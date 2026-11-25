/**
 * The client's side of the `TfWork` editor plugin: the host it is configured with, and what each
 * open text editor gets: its chips resolved when a note loads and on focus, its linked to-do items
 * kept in step with their tasks, and a layer beside its to-do items with a clock for a reminder and
 * the "Make task" action.
 */
import type { TfBlockContext, TfWork, TfWorkHost } from "@triliumnext/ckeditor5";
import type { Editor, ModelElement } from "ckeditor5";

import contextMenu, { type MenuItem } from "../../menus/context_menu.js";
import froca from "../../services/froca.js";
import { t } from "../../services/i18n.js";
import server from "../../services/server.js";
import toast from "../../services/toast.js";
import { getTfBootstrap, isTfTouch } from "../state.js";
import { othersOnNote } from "../team/model.js";
import { getTeam, getTurnLock } from "../team/store.js";
import { tasks, TfEngineError, type TfTaskChip, todos } from "./api.js";
import { applyChipUpdate, chipTitle, rememberChip, renderChip, resolveChips } from "./chips.js";
import { openTfWorkDialog } from "./dialog_bus.js";
import { getTfWorkFlags } from "./editor_host.js";
import { isTicker, todoTargetsForTask, touchesTodoStructure } from "./editor_logic.js";
import { notesOriginConfig, parseTaskforceLink, toAbsoluteHref } from "./links.js";
import { getTfWorkState, loadNoteReminders, setChipResult, subscribeTfWork } from "./store.js";

const TYPING_QUIET_MS = 1500;
const MAX_DEFERRALS = 40;
/** How long after its last keystroke an editor may still hold a save in flight. */
const SAVE_SETTLE_MS = 5000;
const SERVER_TICK_ATTEMPTS = 3;

type TodoBlock = ReturnType<TfWork["getTodoBlocks"]>[number];

interface Attached {
    editor: Editor;
    plugin: TfWork;
    lastKey: number;
    overlay: TodoOverlay | null;
    /** The editor's to-do items, read again only after a change that can have changed them. */
    todos: TodoBlock[] | null;
}

const attached = new Set<Attached>();

export function createTfWorkHost(): TfWorkHost {
    const flags = getTfWorkFlags();
    return {
        parseLink(text) {
            const ref = parseTaskforceLink(text, linkConfig());
            return ref ? { kind: ref.kind, id: ref.id, href: ref.href } : null;
        },
        renderChip,
        chipTitle,
        chipAdded: (data) => void resolveChips([ data.href ]).catch(() => {}),
        linkedTodoChanged: (taskId, checked) => void setTaskDone(taskId, checked),
        attach: attachEditor,
        makeTask: flags.tasks ? (editor) => startMakeTask(editor) : undefined,
        remind: (editor) => startRemind(editor),
        label: (key) => t(key === "makeTask" ? "tf.work.make_task" : "tf.work.remind_me")
    };
}

/** Resolves the chips of every open editor again (window focus). */
export function refreshOpenEditors() {
    for (const entry of attached) {
        void syncNote(entry, { chipsOnly: true });
    }
}

/**
 * `chip.updated`: redraws the chips and brings the to-do items of the task in step with it, once
 * per note (see {@link followTask}).
 */
export function onChipUpdated(taskId: string, chip: TfTaskChip | null) {
    applyChipUpdate(taskId, chip);
    if (!chip) {
        return;
    }
    const notes = new Set<string>();
    for (const entry of attached) {
        const noteId = noteIdOf(entry.editor);
        if (noteId && taskTodos(entry, taskId, chip.done).carries) {
            notes.add(noteId);
        }
    }
    for (const noteId of notes) {
        followTask(noteId, taskId, chip.done, 0);
    }
}

/**
 * Ticks or unticks the to-do items of task `taskId` in `noteId` when they are not in the task's
 * state yet. Only one frame does it: the one whose person has the turn on the note writes it into
 * its editor, as an edit of theirs; while nobody has the turn the first person on the note (by id)
 * has the engine write it (`POST /api/tf/todos/toggle`). Every other editor of the note reloads it
 * from the engine's change like after any save, and one with unsaved changes keeps them.
 */
function followTask(noteId: string, taskId: string, done: boolean, deferrals: number) {
    const entries = [ ...attached ].filter((entry) => noteIdOf(entry.editor) === noteId);
    if (!entries.some((entry) => taskTodos(entry, taskId, done).behind)) {
        return;
    }
    const team = getTeam();
    const selfId = team.self?.id;
    if (!selfId) {
        return;
    }
    const mine = team.turn.mine && team.turn.noteId === noteId;
    const others = othersOnNote(team.presence, noteId, selfId);
    const holderId = getTurnLock()?.holderOf(noteId)?.id ?? others.find((person) => person.editing)?.id ?? null;
    if (!isTicker({ selfId, mine, holderId, presentIds: others.map((person) => person.id) })) {
        return;
    }
    const writable = entries.find((entry) => !entry.editor.isReadOnly);
    if (mine && writable) {
        applyTaskState(writable, taskId, done, 0);
        return;
    }
    // An own save can still be on its way; the engine's change would then refuse it.
    const settling = entries.some((entry) => Date.now() - entry.lastKey < SAVE_SETTLE_MS);
    if (settling && deferrals < MAX_DEFERRALS) {
        setTimeout(() => followTask(noteId, taskId, done, deferrals + 1), TYPING_QUIET_MS);
        return;
    }
    void tickOnServer(noteId, taskId, done);
}

/** Has the engine tick the task's items, reading the note again when someone saved in between. */
async function tickOnServer(noteId: string, taskId: string, done: boolean) {
    for (let attempt = 0; attempt < SERVER_TICK_ATTEMPTS; attempt++) {
        let base: string | undefined;
        let targets;
        try {
            const blob = await server.get<{ blobId?: string; content?: unknown }>(`notes/${noteId}/blob`);
            base = blob?.blobId;
            targets = todoTargetsForTask(typeof blob?.content === "string" ? blob.content : "", taskId, done);
        } catch {
            return;
        }
        if (!base || !targets.length) {
            return;
        }
        try {
            for (const target of targets) {
                base = (await todos.toggle({ noteId, blockId: target.blockId, index: target.index, checked: done, baseBlobId: base })).blobId;
            }
            return;
        } catch (e) {
            if (!(e instanceof TfEngineError && e.status === 409)) {
                return;
            }
        }
    }
}

/** Whether an editor has to-do items of task `taskId`, and whether one of them is not ticked as `done` says. */
function taskTodos(entry: Attached, taskId: string, done: boolean) {
    let carries = false;
    let behind = false;
    for (const todo of todosOf(entry)) {
        if (todo.taskIds.includes(taskId)) {
            carries = true;
            behind ||= (todo.block.getAttribute("todoListChecked") === true) !== done;
        }
    }
    return { carries, behind };
}

function todosOf(entry: Attached) {
    entry.todos ??= entry.plugin.getTodoBlocks();
    return entry.todos;
}

/** Remind me / Make task for the block holding the caret, or for `block`. */
export function startRemind(editor: Editor, block?: ModelElement | null) {
    const plugin = pluginOf(editor);
    const noteId = noteIdOf(editor);
    if (!plugin || !noteId) {
        return;
    }
    const context = editor.isReadOnly ? null : plugin.getBlockContext(block);
    openTfWorkDialog({
        kind: "remind",
        noteId,
        blockId: context?.blockId,
        text: context?.text || froca.notes[noteId]?.title || ""
    });
}

export function startMakeTask(editor: Editor, block?: ModelElement | null) {
    const plugin = pluginOf(editor);
    const noteId = noteIdOf(editor);
    if (!plugin || !noteId) {
        return;
    }
    if (!getTfWorkFlags().tasks || editor.isReadOnly) {
        toast.showMessage(t("tf.work.task_not_allowed"));
        return;
    }
    const context = plugin.getBlockContext(block);
    if (!context) {
        toast.showMessage(t("tf.work.task_no_block"));
        return;
    }
    openTfWorkDialog({
        kind: "makeTask",
        noteId,
        blockId: context.blockId,
        text: context.text,
        noteTitle: froca.notes[noteId]?.title ?? "",
        onCreated: (chip) => insertTaskChip(plugin, context, chip)
    });
}

function insertTaskChip(plugin: TfWork, context: TfBlockContext, chip: TfTaskChip) {
    const href = toAbsoluteHref(chip.href, getTfBootstrap()?.parentOrigins ?? []);
    rememberChip(href, chip);
    plugin.appendChip(context.blockId, { href, kind: "task", id: chip.id, storedTitle: chip.title });
}

async function setTaskDone(taskId: string, done: boolean) {
    try {
        const chip = await tasks.setDone(taskId, done);
        applyChipUpdate(taskId, chip);
    } catch {
        toast.showError(t("tf.work.task_update_failed"));
    }
}

function attachEditor(editor: Editor) {
    const plugin = pluginOf(editor);
    if (!plugin) {
        return;
    }
    const entry: Attached = { editor, plugin, lastKey: 0, overlay: null, todos: null };
    attached.add(entry);
    editor.model.document.on("change:data", () => {
        if (entry.todos && touchesTodoStructure(editor.model.document.differ.getChanges())) {
            entry.todos = null;
        }
    });

    const schedule = () => setTimeout(() => void syncNote(entry, {}), 0);
    const onContextMenu = (event: MouseEvent) => showTodoMenu(entry, event);
    let root: HTMLElement | undefined;
    // The editable exists only once the editor UI is ready, after the plugins' `afterInit()`.
    const mount = () => {
        root = editor.editing.view.getDomRoot();
        if (entry.overlay || !root) {
            return;
        }
        entry.overlay = new TodoOverlay(editor, plugin, () => todosOf(entry));
        root.addEventListener("contextmenu", onContextMenu);
        schedule();
    };
    editor.data.on("set", schedule, { priority: "lowest" });
    editor.on("ready", mount);
    mount();
    editor.editing.view.document.on("keydown", () => {
        entry.lastKey = Date.now();
    });

    return () => {
        attached.delete(entry);
        entry.overlay?.destroy();
        root?.removeEventListener("contextmenu", onContextMenu);
    };
}

async function syncNote(entry: Attached, { chipsOnly }: { chipsOnly?: boolean }) {
    const noteId = noteIdOf(entry.editor);
    if (!noteId) {
        return;
    }
    const chips = entry.plugin.getChips();
    if (chips.length) {
        await resolveChips(chips.map((chip) => chip.data.href)).catch(() => {});
    }
    if (chipsOnly) {
        return;
    }
    await loadNoteReminders(noteId).catch(() => {});
    entry.overlay?.update();

    const linked = todosOf(entry).filter((todo) => todo.taskIds.length);
    if (!linked.length) {
        return;
    }
    try {
        for (const link of await tasks.forNote(noteId)) {
            const href = chips.find((chip) => chip.data.kind === "task" && chip.data.id === link.chip.id)?.data.href;
            if (href) {
                setChipResult(href, link.chip);
            }
            applyChipUpdate(link.chip.id, link.chip);
            followTask(noteId, link.chip.id, link.chip.done, 0);
        }
    } catch {
        // The chips keep what links/resolve answered.
    }
}

/**
 * Applies a task's done state to its to-do items in an editor whose person has the turn on the
 * note, waiting while they are typing in it.
 */
function applyTaskState(entry: Attached, taskId: string, done: boolean, deferrals: number) {
    if (!attached.has(entry) || entry.editor.isReadOnly) {
        return;
    }
    const typing = entry.editor.editing.view.document.isFocused && Date.now() - entry.lastKey < TYPING_QUIET_MS;
    if (typing && deferrals < MAX_DEFERRALS) {
        setTimeout(() => applyTaskState(entry, taskId, done, deferrals + 1), TYPING_QUIET_MS);
        return;
    }
    entry.plugin.setTaskTodoState(taskId, done);
}

/** Right-click on a to-do item at a bare caret: Remind me and Make task for that item. */
function showTodoMenu(entry: Attached, event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    const item = target?.closest("ul.todo-list > li");
    const selection = window.getSelection();
    if (!item || target?.closest(".tf-chip") || (selection && !selection.isCollapsed && selection.toString().trim())) {
        return;
    }
    const block = entry.plugin.blockForDom(target as Node);
    if (!block) {
        return;
    }
    event.preventDefault();
    void contextMenu.show({
        x: event.pageX,
        y: event.pageY,
        items: workMenuItems(entry.editor, block),
        selectMenuItemHandler: () => {}
    });
}

/** The "Remind me" and "Make task" rows for a block (or the caret's block). */
export function workMenuItems(editor: Editor, block?: ModelElement | null): MenuItem<string>[] {
    const items: MenuItem<string>[] = [
        { title: t("tf.work.remind_me_menu"), uiIcon: "bx bx-bell", handler: () => startRemind(editor, block) }
    ];
    if (getTfWorkFlags().tasks && !editor.isReadOnly) {
        items.push({ title: t("tf.work.make_task_menu"), uiIcon: "bx bx-task", handler: () => startMakeTask(editor, block) });
    }
    return items;
}

export function pluginOf(editor: Editor): TfWork | null {
    return editor.plugins.has("TfWork") ? editor.plugins.get("TfWork") : null;
}

function noteIdOf(editor: Editor): string | undefined {
    const getNoteId = editor.config.get("getNoteId") as (() => string | undefined) | undefined;
    return getNoteId?.();
}

function linkConfig() {
    return { appOrigins: getTfBootstrap()?.parentOrigins ?? [], ...notesOriginConfig(location) };
}

/**
 * A layer over the editor, beside its to-do items: a clock where the item has an open reminder,
 * and the "Make task" action at the end of the item under the pointer or holding the caret.
 * Outside the editable, so the editor never sees it. Drawn at most once per animation frame, from
 * the editor's cached to-do items, and only while the editor is on screen.
 */
class TodoOverlay {
    private readonly layer: HTMLDivElement;
    private hovered: Element | null = null;
    private hoveredBlock: ModelElement | null = null;
    private frame = 0;
    private drawn = "";
    private readonly unsubscribe: () => void;
    private readonly root: HTMLElement | null;
    private readonly resize: ResizeObserver | null;

    constructor(private readonly editor: Editor, private readonly plugin: TfWork, private readonly todos: () => TodoBlock[]) {
        this.layer = document.createElement("div");
        this.layer.className = "tf-todo-layer";
        this.root = editor.editing.view.getDomRoot() ?? null;
        const host = this.root?.parentElement;
        host?.classList.add("tf-todo-layer-host");
        host?.append(this.layer);

        editor.editing.view.on("render", this.schedule);
        editor.model.document.selection.on("change:range", this.schedule);
        editor.on("change:isReadOnly", this.schedule);
        this.root?.addEventListener("mouseover", this.onHover);
        window.addEventListener("resize", this.schedule);
        document.addEventListener("visibilitychange", this.schedule);
        // Also fires when a hidden tab with this editor is shown again.
        this.resize = this.root && typeof ResizeObserver !== "undefined" ? new ResizeObserver(this.schedule) : null;
        if (this.root) {
            this.resize?.observe(this.root);
        }
        this.unsubscribe = subscribeTfWork(this.schedule);
    }

    destroy() {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.unsubscribe();
        this.resize?.disconnect();
        window.removeEventListener("resize", this.schedule);
        document.removeEventListener("visibilitychange", this.schedule);
        this.root?.removeEventListener("mouseover", this.onHover);
        this.layer.remove();
    }

    update() {
        this.schedule();
    }

    private readonly onHover = (event: MouseEvent) => {
        const item = event.target instanceof Element ? event.target.closest("ul.todo-list > li") : null;
        if (item !== this.hovered && !this.layer.contains(event.target as Node)) {
            this.hovered = item;
            this.hoveredBlock = item ? this.plugin.blockForDom(item) : null;
            this.schedule();
        }
    };

    private readonly schedule = () => {
        if (!this.frame) {
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.draw();
            });
        }
    };

    private draw() {
        const host = this.layer.parentElement;
        const noteId = noteIdOf(this.editor);
        if (!host || !noteId || !this.root?.isConnected) {
            this.show([], "");
            return;
        }
        if (document.visibilityState !== "visible" || this.root.offsetParent === null) {
            return;
        }
        const reminders = getTfWorkState().byNote.get(noteId) ?? [];
        const remindedBlocks = new Set(reminders.map((r) => r.blockId).filter(Boolean));
        const canMakeTask = getTfWorkFlags().tasks && !this.editor.isReadOnly;
        if (!remindedBlocks.size && !canMakeTask) {
            this.show([], "");
            return;
        }
        const caretBlock = canMakeTask ? this.caretTodoBlock() : null;
        let hostRect: DOMRect | null = null;
        const nodes: HTMLElement[] = [];
        const keys: string[] = [];

        for (const todo of this.todos()) {
            const hasReminder = !!todo.blockId && remindedBlocks.has(todo.blockId);
            const active = canMakeTask && !todo.taskIds.length && (todo.block === this.hoveredBlock || todo.block === caretBlock);
            if (!hasReminder && !active) {
                continue;
            }
            const dom = this.plugin.domForBlock(todo.block);
            const end = dom?.closest("li") ? textEnd(dom) : null;
            if (!end) {
                continue;
            }
            hostRect ??= host.getBoundingClientRect();
            let left = Math.round(end.right - hostRect.left + host.scrollLeft + 6);
            const top = Math.round(end.top - hostRect.top + host.scrollTop + end.height / 2);
            if (hasReminder) {
                keys.push(`c${left},${top}`);
                const clock = document.createElement("span");
                clock.className = "tf-todo-clock bx bx-time-five";
                clock.title = t("tf.work.reminder_on_item");
                clock.setAttribute("role", "img");
                clock.setAttribute("aria-label", t("tf.work.reminder_on_item"));
                clock.style.setProperty("--tf-x", `${left}px`);
                clock.style.setProperty("--tf-y", `${top}px`);
                nodes.push(clock);
                left += 22;
            }
            if (active) {
                keys.push(`a${left},${top},${todo.blockId ?? ""}`);
                const button = document.createElement("button");
                button.type = "button";
                button.className = "tf-todo-action";
                button.title = t("tf.work.make_task");
                button.setAttribute("aria-label", t("tf.work.make_task"));
                button.innerHTML = `<span class="bx bx-task" aria-hidden="true"></span><span class="tf-todo-action-label">${escapeText(t("tf.work.make_task"))}</span>`;
                button.style.setProperty("--tf-x", `${left}px`);
                button.style.setProperty("--tf-y", `${top}px`);
                const block = todo.block;
                button.addEventListener("mousedown", (e) => e.preventDefault());
                button.addEventListener("click", (e) => {
                    e.preventDefault();
                    startMakeTask(this.editor, block);
                });
                nodes.push(button);
            }
        }
        this.layer.classList.toggle("tf-todo-layer--touch", isTfTouch());
        this.show(nodes, keys.join("|"));
    }

    /** Puts `nodes` in the layer unless the same ones are there already. */
    private show(nodes: HTMLElement[], key: string) {
        if (key !== this.drawn || (!key && this.layer.childElementCount)) {
            this.drawn = key;
            this.layer.replaceChildren(...nodes);
        }
    }

    private caretTodoBlock(): ModelElement | null {
        const position = this.editor.model.document.selection.getFirstPosition();
        let current = position?.parent ?? null;
        while (current && current.is("element")) {
            if (current.getAttribute("listType") === "todo") {
                return current;
            }
            current = current.parent;
        }
        return null;
    }
}

/** The box of the last line of text in a block, where the item's text ends. */
function textEnd(dom: HTMLElement): DOMRect | null {
    const description = dom.matches(".todo-list__label__description") ? dom : dom.querySelector(".todo-list__label__description") ?? dom;
    const range = document.createRange();
    range.selectNodeContents(description);
    const rects = [ ...range.getClientRects() ].filter((r) => r.width > 0 || r.height > 0);
    const last = rects[rects.length - 1] ?? description.getBoundingClientRect();
    return last.height ? last : null;
}

function escapeText(text: string) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
