/**
 * The ways into the comments and mentions from the note: "Comment" in the text editor's menus and
 * the phone toolbar, the margin markers of blocks with open threads, people in the `@` list, the
 * card a pressed mention opens, and the `POST mentions` after a save.
 */
import type { CKTextEditor } from "@triliumnext/ckeditor5";
import type { Editor, ModelElement } from "ckeditor5";
import { createPortal, render } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";

import appContext from "../../components/app_context.js";
import froca from "../../services/froca.js";
import { t } from "../../services/i18n.js";
import { escapeHtml, isMobile } from "../../services/utils.js";
import { FormListHeader } from "../../widgets/react/FormList.js";
import { getEditorNoteId } from "../../widgets/react/NoteStore.js";
import { tfFetch } from "../gateway.js";
import { TF_OPEN_NOTE_PANEL_EVENT, TF_PERSON_PATH_PREFIX, type TfMentionSuggestion, type TfMenuItem } from "./hooks.js";
import { activeSplit, blockElement, findBlock, textContentIn, textEditorIn } from "./editors.js";
import { excerptOf, extractMentions, MENTION_CLASS, MENTION_PERSON_ATTRIBUTE, mentionLabel, MentionLedger, openThreadsByBlock, type Thread } from "./model.js";
import { Avatar } from "./presence_ui.js";
import { canWrite, focusThread, getTeam, isMember, personById, searchPeople, setTeam, useTeam } from "./store.js";

//#region Starting a thread

/** Starts a thread on the block holding the selection, quoting the selection or the block. */
export function startComment(editor?: Editor | CKTextEditor | null) {
    const context = appContext.tabManager.getActiveContext();
    const note = context?.note;
    if (!note || !canWrite()) {
        return;
    }
    const textEditor = (editor ?? textEditorIn(activeSplit())) as Editor | null;
    let blockId: string | null = null;
    let quote: string | null = null;
    if (textEditor) {
        const block = selectedBlock(textEditor);
        const selected = (textEditor as unknown as { getSelectedPlainText?(): string }).getSelectedPlainText?.()?.trim();
        if (block) {
            const existing = block.getAttribute("blockId");
            if (typeof existing === "string") {
                blockId = existing;
            } else if (!textEditor.isReadOnly) {
                blockId = assignId(textEditor, block);
            }
            quote = excerptOf(selected || blockText(block));
        } else if (selected) {
            quote = excerptOf(selected);
        }
    }
    setTeam({ commentTarget: { noteId: note.noteId, blockId, quote: quote || null, at: Date.now() } });
    openCommentsPanel(context?.ntxId);
}

let assign: ((editor: Editor, block: ModelElement) => string) | null = null;

/** Set by `index.ts` once `@triliumnext/ckeditor5` is loaded, so this module does not load it. */
export function setBlockIdAssigner(assigner: (editor: Editor, block: ModelElement) => string) {
    assign = assigner;
}

function assignId(editor: Editor, block: ModelElement) {
    return assign ? assign(editor, block) : null;
}

function selectedBlock(editor: Editor): ModelElement | null {
    const selection = editor.model.document.selection;
    const first = [ ...selection.getSelectedBlocks() ][0];
    if (first && editor.model.schema.checkAttribute(first, "blockId")) {
        return first;
    }
    const position = selection.getFirstPosition();
    return position ? findBlock(editor, position.parent as ModelElement) ?? null : null;
}

function blockText(block: ModelElement) {
    let text = "";
    for (const child of block.getChildren()) {
        if (child.is("$text")) {
            text += child.data;
        } else if (child.is("element")) {
            text += blockText(child);
        }
        if (text.length > 160) {
            break;
        }
    }
    return text;
}

/** Shows the comments tab: the right pane on a desktop, the note panel on a phone. */
export function openCommentsPanel(ntxId?: string | null) {
    if (isMobile()) {
        window.dispatchEvent(new CustomEvent(TF_OPEN_NOTE_PANEL_EVENT, { detail: { ntxId, tabId: "tf-comments" } }));
        return;
    }
    const shown = document.querySelector("#right-pane-host:not(.hidden) .right-pane-tab-body[data-tab-id='tf-comments']:not(.hidden-ext)");
    if (!shown) {
        void appContext.triggerEvent("selectRightPaneTab", { tabId: "tf-comments" });
    }
}

/** Opens the panel on `threadId` of `noteId` (a margin marker, a deep link). */
export function openThread(noteId: string, threadId: string, ntxId?: string | null) {
    focusThread(noteId, threadId);
    openCommentsPanel(ntxId);
}

export function textMenuItems(element: Element | null | undefined): Promise<TfMenuItem[]> {
    if (!canWrite() || !element?.closest(".note-detail-editable-text-editor")) {
        return Promise.resolve([]);
    }
    return Promise.resolve([ { title: t("tf.team.comment"), uiIcon: "bx bx-comment-add", handler: () => startComment() } ]);
}

export function blockMenuItems(editor: unknown): TfMenuItem[] {
    if (!canWrite()) {
        return [];
    }
    return [ { title: t("tf.team.comment"), uiIcon: "bx bx-comment-add", handler: () => startComment(editor as Editor) } ];
}

//#endregion

//#region The @ list

export async function mentionSuggestions(term: string): Promise<TfMentionSuggestion[]> {
    const people = await searchPeople(term, term.trim() ? 5 : 3);
    const lower = term.trim().toLowerCase();
    return people.map((person) => {
        const name = escapeHtml(person.name);
        const at = lower ? person.name.toLowerCase().indexOf(lower) : -1;
        const highlighted = at < 0 ? name
            : `${escapeHtml(person.name.slice(0, at))}<b>${escapeHtml(person.name.slice(at, at + lower.length))}</b>${escapeHtml(person.name.slice(at + lower.length))}`;
        return {
            notePath: `${TF_PERSON_PATH_PREFIX}${person.id}`,
            noteTitle: person.name,
            highlightedNotePathTitle: `@${highlighted}`,
            icon: "bx bx-user",
            action: "tf-person"
        };
    });
}

/** The "People" heading above the first person, and "Notes" above the first note after them. */
export function mentionRowPrefix(items: readonly { action?: string }[], index: number) {
    const isPerson = items[index]?.action === "tf-person";
    const previousIsPerson = index > 0 && items[index - 1]?.action === "tf-person";
    if (isPerson && !previousIsPerson) {
        return <FormListHeader key="tf-people" text={t("tf.team.people")} />;
    }
    if (!isPerson && previousIsPerson) {
        return <FormListHeader key="tf-notes" text={t("tf.team.notes")} />;
    }
    return null;
}

//#endregion

//#region Mentions after a save

const mentions = new MentionLedger();

/**
 * A text editor loaded content (`setData()`: the note opened, or reloaded after someone else's
 * save). The people named in it were named by whoever saved it, so this frame does not report them.
 */
export function onEditorContentLoaded(editor: Editor) {
    const noteId = getEditorNoteId(editor);
    if (!noteId) {
        return;
    }
    // Most notes name nobody; only those are serialized again.
    mentions.learn(noteId, hasMention(editor) ? extractMentions(editor.getData()) : []);
}

/** Tells Taskforce about the people @-named in this frame since the note was loaded. */
export function onNoteSaved(noteId: string, data: unknown) {
    const content = (data as { content?: unknown } | undefined)?.content;
    if (typeof content !== "string" || !canWrite()) {
        return;
    }
    const refs = extractMentions(content).filter((ref) => ref.personId !== getTeam().self?.id);
    for (const notice of mentions.take(noteId, refs)) {
        void tfFetch("mentions", {
            json: { noteId, userIds: notice.userIds, excerpt: notice.excerpt, ...(notice.blockId ? { blockId: notice.blockId } : {}) }
        }).catch(() => mentions.forget(noteId, notice));
    }
}

function hasMention(editor: Editor) {
    for (const root of editor.model.document.getRoots()) {
        for (const { item } of editor.model.createRangeIn(root)) {
            if (item.is("element", "tfMention")) {
                return true;
            }
        }
    }
    return false;
}

//#endregion

//#region The card of a pressed mention

let cardHost: HTMLElement | null = null;

/** Opens the card of a person mention pressed in a note. */
export function installMentionCards() {
    document.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>(`.${MENTION_CLASS}[${MENTION_PERSON_ATTRIBUTE}]`) : null;
        if (!target || !target.closest(".note-split, .ck-content")) {
            return;
        }
        showMentionCard(target);
    });
}

function showMentionCard(anchor: HTMLElement) {
    closeMentionCard();
    cardHost = document.createElement("div");
    cardHost.className = "tf-team-card-host";
    document.body.append(cardHost);
    render(<MentionCard anchor={anchor} personId={anchor.getAttribute(MENTION_PERSON_ATTRIBUTE) ?? ""} />, cardHost);
}

function closeMentionCard() {
    if (cardHost) {
        render(null, cardHost);
        cardHost.remove();
        cardHost = null;
    }
}

function MentionCard({ anchor, personId }: { anchor: HTMLElement; personId: string }) {
    const team = useTeam();
    const name = mentionLabel(personById(personId)?.name, isMember(personId), t("tf.team.unknown_person"));
    const person = { ...(personById(personId) ?? { id: personId, avatar: null, color: "" }), name };
    const present = team.presence.find((entry) => entry.id === personId && entry.noteId);
    const [ title, setTitle ] = useState<string | null>(null);
    const [ position, setPosition ] = useState({ top: 0, left: 0 });

    useLayoutEffect(() => {
        const rect = anchor.getBoundingClientRect();
        const width = 260;
        setPosition({
            top: Math.min(rect.bottom + 6, window.innerHeight - 120),
            left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
        });
    }, [ anchor ]);

    useEffect(() => {
        if (present?.noteId) {
            void froca.getNote(present.noteId).then((note) => setTitle(note?.title ?? null));
        }
    }, [ present?.noteId ]);

    useEffect(() => {
        const onDown = (event: PointerEvent) => {
            if (!(event.target instanceof Node) || !cardHost?.contains(event.target)) {
                closeMentionCard();
            }
        };
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && closeMentionCard();
        const timer = window.setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
        document.addEventListener("keydown", onKey);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener("pointerdown", onDown, true);
            document.removeEventListener("keydown", onKey);
        };
    }, []);

    return (
        <div className="tf-team-card" role="dialog" aria-label={person.name} style={{ top: `${position.top}px`, left: `${position.left}px` }}>
            <Avatar person={person} size="lg" />
            <div className="tf-team-card-text">
                <div className="tf-team-card-name">{person.name}</div>
                {present
                    ? <div className="tf-team-card-where">{t("tf.team.on_note_now", { title: title ?? "…" })}</div>
                    : <div className="tf-team-card-where is-away">{t("tf.team.not_here")}</div>}
            </div>
        </div>
    );
}

/**
 * Writes each mention of a read-only text note with the member's current name, as the editor does,
 * so pasted HTML cannot show one name and stand for another person.
 */
function showMentionNames(content: HTMLElement | null) {
    if (!content?.classList.contains("note-detail-readonly-text-content")) {
        return;
    }
    for (const element of content.querySelectorAll<HTMLElement>(`span.${MENTION_CLASS}[${MENTION_PERSON_ATTRIBUTE}]`)) {
        const personId = element.getAttribute(MENTION_PERSON_ATTRIBUTE) ?? "";
        const text = `@${mentionLabel(personById(personId)?.name, isMember(personId), t("tf.team.unknown_person"))}`;
        if (element.textContent !== text) {
            element.textContent = text;
        }
    }
}

//#endregion

//#region Margin markers

/** Room a marker needs beside the block handle, and the width of the lane at the right of the text. */
const MARKER_GUTTER = 88;
const MARKER_LANE = 52;

/** The markers beside the blocks of a text note that have open threads, inside its split. */
export function CommentMarkers({ split, noteId, ntxId }: { split: HTMLElement; noteId: string; ntxId?: string | null }) {
    const team = useTeam();
    const threads = team.threads.get(noteId);
    const byBlock = openThreadsByBlock(threads ?? []);
    const [ layer, setLayer ] = useState<HTMLElement | null>(null);
    const [ positions, setPositions ] = useState<{ blockId: string; top: number; left: number }[]>([]);
    const key = [ ...byBlock.keys() ].join(",");

    useLayoutEffect(() => {
        const scroller = split.querySelector<HTMLElement>(".scrolling-container");
        if (!scroller) {
            return;
        }
        const element = document.createElement("div");
        element.className = "tf-team-marker-layer";
        scroller.append(element);
        setLayer(element);
        return () => element.remove();
    }, [ split ]);

    useEffect(() => {
        if (!layer) {
            return;
        }
        const scroller = layer.parentElement as HTMLElement;
        let frame = 0;
        let drawn = "";
        // Measures once per animation frame at most, and not at all while the split is not shown:
        // a resize or the page coming back schedules it again.
        const measure = () => {
            frame = 0;
            if (document.visibilityState !== "visible" || split.offsetParent === null) {
                return;
            }
            const content = textContentIn(split);
            showMentionNames(content);
            const next: { blockId: string; top: number; left: number }[] = [];
            let lane = false;
            if (byBlock.size) {
                const box = scroller.getBoundingClientRect();
                const right = (content?.getBoundingClientRect().right ?? box.right) - box.left;
                for (const blockId of byBlock.keys()) {
                    const block = blockElement(content, blockId);
                    if (!block || block.offsetParent === null) {
                        continue;
                    }
                    const rect = block.getBoundingClientRect();
                    // The left margin holds the block handle; a marker goes there only when both fit,
                    // otherwise into a lane kept free at the right of the text.
                    const gutter = rect.left - box.left;
                    const inGutter = gutter >= MARKER_GUTTER;
                    lane ||= !inGutter;
                    next.push({
                        blockId,
                        top: Math.round(rect.top - box.top + scroller.scrollTop),
                        left: Math.round(inGutter ? gutter - MARKER_GUTTER + 2 : Math.max(2, right - MARKER_LANE + 6))
                    });
                }
            }
            const key = `${lane}|${next.map((entry) => `${entry.blockId}:${entry.top}:${entry.left}`).join(",")}`;
            if (key !== drawn) {
                drawn = key;
                scroller.classList.toggle("tf-team-marker-lane", lane);
                setPositions(next);
            }
        };
        const schedule = () => {
            if (!frame) {
                frame = window.requestAnimationFrame(measure);
            }
        };
        schedule();
        const content = textContentIn(split);
        const resize = new ResizeObserver(schedule);
        resize.observe(scroller);
        if (content) {
            resize.observe(content);
        }
        const mutations = new MutationObserver(schedule);
        mutations.observe(split.querySelector(".note-detail") ?? scroller, { childList: true, subtree: true, attributes: true, attributeFilter: [ "data-trilium-block-id" ] });
        document.addEventListener("visibilitychange", schedule);
        return () => {
            scroller.classList.remove("tf-team-marker-lane");
            resize.disconnect();
            mutations.disconnect();
            document.removeEventListener("visibilitychange", schedule);
            if (frame) {
                window.cancelAnimationFrame(frame);
            }
        };
    }, [ layer, key, threads, team.people ]);

    if (!layer) {
        return null;
    }
    return createPortal(
        <>
            {positions.map(({ blockId, top, left }) => {
                const blockThreads = byBlock.get(blockId) as Thread[];
                const count = blockThreads.length;
                const label = t("tf.team.marker_label", { count });
                return (
                    <button
                        key={blockId}
                        type="button"
                        className="tf-team-marker"
                        data-block-id={blockId}
                        style={{ top: `${top}px`, left: `${left}px` }}
                        title={label}
                        aria-label={label}
                        onClick={() => openThread(noteId, blockThreads[0].id, ntxId)}
                    >
                        <span className="bx bx-message-square-dots" aria-hidden="true" />
                        <span className="tf-team-marker-count">{count}</span>
                    </button>
                );
            })}
        </>,
        layer
    );
}

//#endregion
