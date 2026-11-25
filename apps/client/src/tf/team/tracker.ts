/**
 * Follows what this person does in the frame and tells the gateway: the note they are on and
 * whether they are typing (`presence`, editing = an edit in the last 3 s), the edit lock of the
 * open text, code or Markdown note (`turns.ts`), and makes every editor of a note read-only while
 * someone else has the turn on it. Also marks a note seen after 1.5 s on screen and refreshes its
 * authorship.
 */
import type { CKTextEditor } from "@triliumnext/ckeditor5";
import type VanillaCodeMirror from "@triliumnext/codemirror";
import type { Batch } from "ckeditor5";

import appContext from "../../components/app_context.js";
import Component from "../../components/component.js";
import type FNote from "../../entities/fnote.js";
import type LoadResults from "../../services/load_results.js";
import { getEditorNoteId } from "../../widgets/react/NoteStore.js";
import {
    activeSplit, codeViewIn, codeViewInSync, findSplit, loadCodeMirror, type LockableKind, lockableKind,
    textEditorIn, TURN_LOCK_ID
} from "./editors.js";
import { othersOnNote } from "./model.js";
import {
    canWrite, getTeam, getTurnLock, loadActivity, loadThreads, markSeen, sendRealtime, setOnReconnect,
    setTeam, subscribeTeam
} from "./store.js";
import { isOwnEdit, isTakenByOthers, type LockTarget, planEditorLocks } from "./turns.js";

export const EDITING_WINDOW_MS = 3000;
export const SEEN_AFTER_MS = 1500;

let noteId: string | null = null;
let note: FNote | null = null;
let editing = false;
let editingTimer: number | null = null;
let lastSent = "";
let seenTimer: number | null = null;
let snapshot: { noteId: string; text: string } | null = null;
let bypassTurns = false;

/**
 * Makes this frame behave like a client without turns (no lock, no typing presence, never
 * read-only), to check that the save guard still catches what the locks would have prevented.
 */
export function setTurnBypass(on: boolean) {
    bypassTurns = on;
    if (on) {
        setEditing(false);
        getTurnLock()?.release();
    }
    applyEditorLock();
}

export function installTracker() {
    appContext.child(new TeamNoteWatcher());
    setOnReconnect(() => {
        lastSent = "";
        report();
    });

    for (const type of [ "keydown", "beforeinput", "paste", "cut", "drop" ]) {
        window.addEventListener(type, onEditEvent, true);
    }
    window.addEventListener("pointerdown", onPointerEdit, true);
    window.addEventListener("blur", () => getTurnLock()?.release());
    window.addEventListener("pagehide", () => getTurnLock()?.release());
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            scheduleSeen();
            applyEditorLock();
        }
    });

    getTurnLock()?.onRefused(() => void revertOptimistic());
    subscribeTeam(applyEditorLock);
    // Editors are rebuilt and tabs restored without an event this module hears.
    window.setInterval(applyEditorLock, 1000);
    onNoteChanged();
}

class TeamNoteWatcher extends Component {
    activeContextChangedEvent() {
        onNoteChanged();
    }

    noteSwitchedAndActivatedEvent() {
        onNoteChanged();
    }

    noteSwitchedEvent() {
        onNoteChanged();
    }

    newNoteContextCreatedEvent() {
        queueMicrotask(applyEditorLock);
    }

    noteContextRemovedEvent() {
        queueMicrotask(applyEditorLock);
    }

    contextsReopenedEvent() {
        queueMicrotask(applyEditorLock);
    }

    entitiesReloadedEvent({ loadResults }: { loadResults: LoadResults }) {
        if (noteId && loadResults.isNoteContentReloaded(noteId)) {
            window.setTimeout(() => noteId && void loadActivity(noteId, true), 2500);
        }
    }
}

function onNoteChanged() {
    const context = appContext.tabManager?.getActiveContext();
    const next = context?.note ?? null;
    const nextId = next?.noteId ?? null;
    note = next;
    if (nextId === noteId) {
        applyEditorLock();
        return;
    }
    noteId = nextId;
    snapshot = null;
    optimistic = [];
    setEditing(false);
    const kind = lockableKind(next);
    getTurnLock()?.setNote(canWrite() && kind ? nextId : null);
    if (kind === "code") {
        void loadCodeMirror();
    }
    report();
    scheduleSeen();
    applyEditorLock();
    if (nextId) {
        void loadActivity(nextId);
        void loadThreads(nextId);
    }
}

function report() {
    const frame = { noteId, editing };
    const key = JSON.stringify(frame);
    if (key === lastSent) {
        return;
    }
    lastSent = key;
    sendRealtime("presence", frame);
}

function setEditing(value: boolean) {
    if (editingTimer !== null) {
        window.clearTimeout(editingTimer);
        editingTimer = null;
    }
    if (value) {
        editingTimer = window.setTimeout(() => setEditing(false), EDITING_WINDOW_MS);
    }
    if (value !== editing) {
        editing = value;
        report();
    }
}

function scheduleSeen() {
    if (seenTimer !== null) {
        window.clearTimeout(seenTimer);
    }
    const target = noteId;
    if (!target) {
        return;
    }
    seenTimer = window.setTimeout(() => {
        seenTimer = null;
        if (noteId === target && document.visibilityState === "visible") {
            void markSeen(target);
        }
    }, SEEN_AFTER_MS);
}

//#region Edits

const NAVIGATION_KEYS = new Set([
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Escape",
    "Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "ContextMenu", "F1", "F2", "F3", "F4", "F5",
    "F6", "F7", "F8", "F9", "F10", "F11", "F12", "Dead", "Unidentified", "Process"
]);
const EDITING_SHORTCUT_KEYS = new Set([ "v", "x", "z", "y", "d", "b", "i", "u", "k" ]);

/** Whether a keydown changes the text it is typed into. */
export function isEditingKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">) {
    if (event.isComposing || NAVIGATION_KEYS.has(event.key)) {
        return false;
    }
    if (event.ctrlKey || event.metaKey) {
        return EDITING_SHORTCUT_KEYS.has(event.key.toLowerCase());
    }
    return event.key.length === 1 || [ "Backspace", "Delete", "Enter" ].includes(event.key);
}

function editTarget(event: Event) {
    const target = event.target instanceof Element ? event.target : null;
    const split = target?.closest<HTMLElement>(".note-split");
    if (!target || !split) {
        return null;
    }
    if (target.closest(".title-row, .inline-title, .note-title-widget, input, select, .tf-team-bar")) {
        return null;
    }
    const editable = target.closest("[contenteditable='true'], .cm-content, textarea");
    return { split, editable };
}

/** Keys and clipboard events: refused before they change anything while someone else types. */
function onEditEvent(event: Event) {
    if (!noteId || !canWrite() || bypassTurns) {
        return;
    }
    if (event.type === "keydown" && !isEditingKey(event as KeyboardEvent)) {
        return;
    }
    const where = editTarget(event);
    if (!where) {
        return;
    }
    const kind = lockableKind(note);
    if (kind && where.editable) {
        const lock = getTurnLock();
        const wasMine = getTeam().turn.mine;
        if (lock && !lock.keystroke()) {
            event.preventDefault();
            event.stopImmediatePropagation();
            setTeam({ blockedAt: Date.now() });
            return;
        }
        if (kind === "code" && !wasMine && !snapshot) {
            takeCodeSnapshot();
        }
    } else if (!where.editable && kind) {
        return;
    }
    setEditing(true);
}

function onPointerEdit(event: PointerEvent) {
    if (!noteId || !canWrite() || lockableKind(note)) {
        return;
    }
    if (editTarget(event)) {
        setEditing(true);
    }
}

/** Edits of a text editor applied ahead of the gateway's answer, undone if it refuses the turn. */
let optimistic: { editor: CKTextEditor; batch: Batch }[] = [];
let reverting = false;

/**
 * Every change of a text editor's model (`change:data`), whatever made it: typing, a checkbox, a
 * person picked with the mouse, a moved block, a transcript. An own edit asks for the turn; when
 * someone else has it the edit is undone and the turn bar says who is typing.
 */
export function onTextEditorChange(editor: CKTextEditor, batch: Batch) {
    if (!isOwnEdit(batch, reverting) || !canWrite() || bypassTurns) {
        return;
    }
    const target = getEditorNoteId(editor);
    if (!target || target !== noteId) {
        // An editor of a note other than the open one: it cannot ask for that note's turn, but it
        // must not write while someone else has it.
        if (target && isNoteTaken(target)) {
            refuse(editor, [ batch ]);
        }
        return;
    }
    const lock = getTurnLock();
    const wasMine = getTeam().turn.mine;
    if (lock && !lock.keystroke()) {
        refuse(editor, [ batch ]);
        return;
    }
    if (!wasMine) {
        optimistic.push({ editor, batch });
    }
    setEditing(true);
}

function refuse(editor: CKTextEditor, batches: Batch[]) {
    // Undoing inside the change listener would join the edit's own batch.
    window.setTimeout(() => {
        undoBatches(editor, batches);
        setTeam({ blockedAt: Date.now() });
    }, 0);
}

function undoBatches(editor: CKTextEditor, batches: readonly Batch[]) {
    if (editor.state === "destroyed") {
        return;
    }
    const undo = editor.commands.get("undo");
    if (!undo) {
        return;
    }
    // The turn lock may already have made the editor read-only, which disables undo.
    const relock = isLockedHere(editor);
    if (relock) {
        editor.disableReadOnlyMode(TURN_LOCK_ID);
    }
    reverting = true;
    try {
        for (const batch of [ ...batches ].reverse()) {
            if (undo.isEnabled) {
                editor.execute("undo", batch);
            }
        }
    } finally {
        reverting = false;
        if (relock) {
            editor.enableReadOnlyMode(TURN_LOCK_ID);
        }
    }
}

function takeCodeSnapshot() {
    const id = noteId;
    const view = codeViewInSync(activeSplit());
    if (id && view) {
        snapshot = { noteId: id, text: view.getText() };
    }
}

/** Puts back what was changed before the gateway refused the turn. */
async function revertOptimistic() {
    const edits = optimistic;
    optimistic = [];
    const byEditor = new Map<CKTextEditor, Batch[]>();
    for (const { editor, batch } of edits) {
        byEditor.set(editor, [ ...(byEditor.get(editor) ?? []), batch ]);
    }
    for (const [ editor, batches ] of byEditor) {
        undoBatches(editor, batches);
    }

    const saved = snapshot;
    snapshot = null;
    if (saved && saved.noteId === noteId) {
        (await codeViewIn(activeSplit()))?.setText(saved.text);
    }
}

//#endregion

//#region Read-only while someone else has the turn

type TurnEditor = CKTextEditor | VanillaCodeMirror;

interface Target extends LockTarget<TurnEditor> {
    kind: LockableKind;
}

interface Applied extends Target {
    caretPath: number[] | null;
}

let applied: Applied[] = [];
let codeMirrorAsked = false;

/** Whether someone else has the turn on `target`: they hold its lock or are typing in it. */
export function isNoteTaken(target: string) {
    const team = getTeam();
    return isTakenByOthers(target, {
        mine: team.turn.mine && team.turn.noteId === target,
        holder: getTurnLock()?.holderOf(target) ?? null,
        othersEditing: othersOnNote(team.presence, target, team.self?.id).some((person) => person.editing)
    });
}

/** Who has the turn on `target`, for a refusal that names them. */
export function turnHolderName(target: string) {
    const team = getTeam();
    return getTurnLock()?.holderOf(target)?.name
        ?? othersOnNote(team.presence, target, team.self?.id).find((person) => person.editing)?.name
        ?? null;
}

function isLockedHere(editor: TurnEditor) {
    return applied.some((lock) => lock.editor === editor);
}

/**
 * Locks each editor, in every tab and split, whose note someone else has the turn on, and lifts
 * each lock from the editor it was put on once that is no longer so: the turn ended, the context
 * shows another note, or the tab closed. Runs on every turn, presence and note context change.
 */
function applyEditorLock() {
    if (getTeam().turn.mine && snapshot) {
        snapshot = null;
    }
    if (getTeam().turn.mine && optimistic.length) {
        optimistic = [];
    }
    const targets = bypassTurns ? [] : collectTargets();
    const plan = planEditorLocks(targets, applied, isNoteTaken);
    for (const lock of plan.release) {
        unlockEditor(lock);
    }
    const taken: Applied[] = plan.take.map((target) => ({ ...(target as Target), caretPath: null }));
    for (const lock of taken) {
        lockEditor(lock);
    }
    applied = [ ...plan.keep, ...taken ];
}

function collectTargets(): Target[] {
    const targets: Target[] = [];
    for (const context of appContext.tabManager?.getNoteContexts() ?? []) {
        const kind = lockableKind(context.note);
        const ntxId = context.ntxId;
        if (!kind || !ntxId || !context.note) {
            continue;
        }
        const split = findSplit(ntxId);
        if (kind === "text") {
            const editor = textEditorIn(split);
            if (editor && editor.state !== "destroyed") {
                targets.push({ ntxId, kind, editor, noteId: getEditorNoteId(editor) ?? context.note.noteId });
            }
            continue;
        }
        const view = codeViewInSync(split);
        if (view) {
            targets.push({ ntxId, kind, editor: view, noteId: context.note.noteId });
        } else if (!codeMirrorAsked) {
            codeMirrorAsked = true;
            void loadCodeMirror().then(applyEditorLock);
        }
    }
    return targets;
}

function lockEditor(lock: Applied) {
    if (lock.kind === "text") {
        const editor = lock.editor as CKTextEditor;
        if (!editor.isReadOnly) {
            lock.caretPath = editor.model.document.selection.getFirstPosition()?.path.slice() ?? null;
        }
        editor.enableReadOnlyMode(TURN_LOCK_ID);
        return;
    }
    const view = lock.editor as VanillaCodeMirror;
    if (!view.state.readOnly) {
        view.setReadOnly(true);
        view.dom.dataset.tfTurnLocked = "true";
    }
}

function unlockEditor(lock: Applied) {
    if (lock.kind === "text") {
        const editor = lock.editor as CKTextEditor;
        if (editor.state === "destroyed") {
            return;
        }
        editor.disableReadOnlyMode(TURN_LOCK_ID);
        const path = lock.caretPath;
        // The caret goes back only where the editor still shows the note it was locked on.
        if (path && getEditorNoteId(editor) === lock.noteId) {
            try {
                editor.model.change((writer) => {
                    const position = editor.model.createPositionFromPath(editor.model.document.getRoot() as never, path);
                    writer.setSelection(position);
                });
            } catch {
                // The text changed under the caret; it stays where the new text put it.
            }
        }
        return;
    }
    const view = lock.editor as VanillaCodeMirror;
    if (view.dom.dataset.tfTurnLocked === "true") {
        delete view.dom.dataset.tfTurnLocked;
        view.setReadOnly(false);
    }
}

//#endregion
