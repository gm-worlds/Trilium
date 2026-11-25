/**
 * The to-do roll-up of an embedded notebook: every to-do item of every text note, and ticking one
 * of them from outside the editor.
 *
 * Candidates come from one SQL pass over the note blobs (`LIKE '%todo-list%'`); each candidate's
 * HTML is parsed once per blob id with `node-html-parser`, so a second request reads the cache.
 * A toggle rewrites only the checkbox (and the task state attribute of its `<li>`) in the stored
 * HTML and saves through `noteService.updateNoteData()`, the path `PUT /api/notes/:noteId/data`
 * takes, so revisions, events, the view-role guard and the change history all apply.
 */
import { BLOCK_ID_ATTRIBUTE, DONE_STATE_NAME, isAnchorState, NONE_STATE_NAME, type TaskStateDef } from "@triliumnext/commons";
import { type HTMLElement, parse } from "node-html-parser";

import becca from "../../becca/becca.js";
import type BNote from "../../becca/entities/bnote.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import noteService from "../../services/notes.js";
import { isProtectedSessionAvailable } from "../../services/protected_session.js";
import { getSql } from "../../services/sql/index.js";
import { getTaskStates } from "../../services/task_states.js";

export const TASK_STATE_ATTRIBUTE = "data-trilium-task-state";
export const TODO_TEXT_LIMIT = 200;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export interface TfTodoItem {
    noteId: string;
    noteTitle: string;
    /** Titles from below the root down to the note's parent. */
    notePath: string[];
    blockId: string | null;
    /** Position among the note's to-do items, in document order. */
    index: number;
    text: string;
    /** Task state name: `none`, `done` or a custom one (`doing`, …). */
    state: string;
    /** Title of the state as configured, for the custom ones. */
    stateTitle: string | null;
    checked: boolean;
    /** Whether the item counts as completed (ticked, or a custom state marked so). */
    completed: boolean;
}

export interface TfTodoNote {
    noteId: string;
    noteTitle: string;
    notePath: string[];
    blobId: string;
}

export interface TfTodoList {
    items: TfTodoItem[];
    notes: TfTodoNote[];
    total: number;
    next: string | null;
}

export interface TfTodoQuery {
    scope?: string;
    noteId?: string;
    state?: string;
    limit?: string | number;
    cursor?: string;
}

/** One to-do item as parsed from a note's HTML, before the note's own fields are added. */
export interface ParsedTodo {
    blockId: string | null;
    index: number;
    text: string;
    state: string;
    checked: boolean;
    /** Source offsets of the item's `<li>` and its checkbox `<input>`. */
    liRange: readonly [number, number];
    inputRange: readonly [number, number] | null;
}

interface CacheEntry {
    blobId: string;
    items: ParsedTodo[];
}

const cache = new Map<string, CacheEntry>();

export function clearTfTodoCache() {
    cache.clear();
}

/** `GET /api/tf/todos`. */
export function listTfTodos(query: TfTodoQuery): TfTodoList {
    const scope = query.scope === "subtree" ? "subtree" : "notebook";
    const state = query.state === "all" ? "all" : "open";
    const limit = clampLimit(query.limit);
    const offset = query.cursor ? Math.max(0, Number.parseInt(String(query.cursor), 10) || 0) : 0;

    let subtree: Set<string> | null = null;
    if (scope === "subtree") {
        if (!query.noteId) {
            throw new ValidationError("A subtree list needs a noteId.");
        }
        const top = becca.getNote(query.noteId);
        if (!top) {
            throw new NotFoundError(`Note '${query.noteId}' not found.`);
        }
        subtree = new Set(top.getSubtreeNoteIds({ includeArchived: false }));
    }

    const states = stateMap();
    const notes: { note: BNote; order: number[]; items: ParsedTodo[] }[] = [];
    for (const row of findCandidates()) {
        if (subtree && !subtree.has(row.noteId)) {
            continue;
        }
        const note = becca.getNote(row.noteId);
        if (!note || !isListable(note)) {
            continue;
        }
        const items = getParsedTodos(note);
        if (!items.length) {
            continue;
        }
        notes.push({ note, order: treeOrder(note), items });
    }
    notes.sort((a, b) => compareOrder(a.order, b.order) || a.note.title.localeCompare(b.note.title));

    const all: TfTodoItem[] = [];
    const noteInfo = new Map<string, TfTodoNote>();
    for (const { note, items } of notes) {
        const notePath = titlePath(note);
        for (const item of items) {
            const full = toItem(note, notePath, item, states);
            if (state === "open" && full.completed) {
                continue;
            }
            all.push(full);
            if (!noteInfo.has(note.noteId)) {
                noteInfo.set(note.noteId, { noteId: note.noteId, noteTitle: note.title, notePath, blobId: note.blobId ?? "" });
            }
        }
    }

    const page = all.slice(offset, offset + limit);
    const pageNoteIds = new Set(page.map((item) => item.noteId));
    return {
        items: page,
        notes: [ ...noteInfo.values() ].filter((info) => pageNoteIds.has(info.noteId)),
        total: all.length,
        next: offset + limit < all.length ? String(offset + limit) : null
    };
}

export interface TfTodoToggle {
    noteId?: unknown;
    blockId?: unknown;
    index?: unknown;
    checked?: unknown;
    state?: unknown;
    baseBlobId?: unknown;
}

export interface TfTodoConflict {
    conflict: true;
    blobId: string | undefined;
}

/** `POST /api/tf/todos/toggle`. Answers `[409, conflict]` when `baseBlobId` is stale. */
export function toggleTfTodo(body: TfTodoToggle): [409, TfTodoConflict] | { blobId: string | undefined; item: TfTodoItem } {
    const noteId = typeof body.noteId === "string" ? body.noteId : "";
    const note = becca.getNote(noteId);
    if (!note || note.type !== "text") {
        throw new NotFoundError(`Text note '${noteId}' not found.`);
    }
    if (!note.isContentAvailable()) {
        throw new ValidationError("The note is protected and locked.");
    }
    if (typeof body.baseBlobId !== "string" || !body.baseBlobId) {
        throw new ValidationError("baseBlobId is required.");
    }
    if (body.baseBlobId !== note.blobId) {
        return [409, { conflict: true, blobId: note.blobId }];
    }

    const content = note.getContent();
    if (typeof content !== "string") {
        throw new ValidationError("The note has no text content.");
    }
    const items = parseTodos(content);
    const target = findItem(items, body.blockId, body.index);
    if (!target) {
        throw new NotFoundError("That to-do item is no longer in the note.");
    }

    const states = stateMap();
    let nextState: string;
    if (typeof body.state === "string" && body.state) {
        if (!states.has(body.state)) {
            throw new ValidationError(`Unknown task state '${body.state}'.`);
        }
        nextState = body.state;
    } else if (typeof body.checked === "boolean") {
        nextState = body.checked ? DONE_STATE_NAME : NONE_STATE_NAME;
    } else {
        throw new ValidationError("Send checked or state.");
    }
    const completed = states.get(nextState)?.isCompleted ?? nextState === DONE_STATE_NAME;
    const newContent = applyTodoState(content, target, nextState, completed);

    if (newContent !== content) {
        noteService.updateNoteData(note.noteId, newContent);
    }

    const updated = becca.getNoteOrThrow(note.noteId);
    const reparsed = getParsedTodos(updated);
    const item = findItem(reparsed, target.blockId, target.index) ?? target;
    return { blobId: updated.blobId, item: toItem(updated, titlePath(updated), item, states) };
}

/** The to-do items of one note's HTML, in document order. */
export function parseTodos(html: string): ParsedTodo[] {
    if (!html.includes("todo-list")) {
        return [];
    }
    const root = parse(html, { comment: false });
    const result: ParsedTodo[] = [];
    for (const li of root.querySelectorAll("ul.todo-list > li")) {
        const input = findCheckbox(li);
        result.push({
            blockId: findBlockId(li),
            index: result.length,
            text: itemText(li),
            state: itemState(li, input),
            checked: !!input?.hasAttribute("checked"),
            liRange: li.range,
            inputRange: input ? input.range : null
        });
    }
    return result;
}

/**
 * Rewrites `item` in `html` to `state`: the checkbox gets or loses `checked`, and the `<li>` gets
 * `data-trilium-task-state` for a custom state or loses it for `none`/`done`. Everything else in
 * the HTML stays byte for byte.
 */
export function applyTodoState(html: string, item: ParsedTodo, state: string, completed: boolean): string {
    const edits: { start: number; end: number; text: string }[] = [];

    if (item.inputRange) {
        const [ start, end ] = item.inputRange;
        edits.push({ start, end, text: setBooleanAttribute(html.slice(start, end), "checked", completed) });
    }

    const liStart = item.liRange[0];
    const openTag = OPEN_TAG.exec(html.slice(liStart));
    if (openTag) {
        const tag = openTag[0];
        const nextTag = isAnchorState(state)
            ? removeAttribute(tag, TASK_STATE_ATTRIBUTE)
            : setAttribute(tag, TASK_STATE_ATTRIBUTE, state);
        if (nextTag !== tag) {
            edits.push({ start: liStart, end: liStart + tag.length, text: nextTag });
        }
    }

    let out = html;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    }
    return out;
}

function getParsedTodos(note: BNote): ParsedTodo[] {
    const blobId = note.blobId ?? "";
    const hit = cache.get(note.noteId);
    if (hit && hit.blobId === blobId) {
        return hit.items;
    }
    let items: ParsedTodo[] = [];
    try {
        const content = note.getContent();
        items = typeof content === "string" ? parseTodos(content) : [];
    } catch {
        items = [];
    }
    // Protected content is never kept once the session could close.
    if (!note.isProtected) {
        cache.set(note.noteId, { blobId, items });
    }
    return items;
}

function findCandidates(): { noteId: string }[] {
    return getSql().getRows<{ noteId: string }>(
        `SELECT notes.noteId FROM notes JOIN blobs ON blobs.blobId = notes.blobId
         WHERE notes.isDeleted = 0 AND notes.type = 'text'
           AND (notes.isProtected = 1 OR blobs.content LIKE '%todo-list%')`
    );
}

function isListable(note: BNote) {
    if (note.noteId.startsWith("_") || note.isDeleted) {
        return false;
    }
    if (note.isProtected && !isProtectedSessionAvailable()) {
        return false;
    }
    if (note.isArchived || note.isHiddenCompletely()) {
        return false;
    }
    return note.getParentBranches().length > 0;
}

function toItem(note: BNote, notePath: string[], item: ParsedTodo, states: Map<string, TaskStateDef>): TfTodoItem {
    const def = states.get(item.state);
    const completed = item.checked || !!def?.isCompleted;
    return {
        noteId: note.noteId,
        noteTitle: note.title,
        notePath,
        blockId: item.blockId,
        index: item.index,
        text: item.text,
        state: item.state,
        stateTitle: def && !isAnchorState(item.state) ? def.title : null,
        checked: item.checked,
        completed
    };
}

function findItem(items: ParsedTodo[], blockId: unknown, index: unknown) {
    if (typeof blockId === "string" && blockId) {
        return items.find((item) => item.blockId === blockId) ?? null;
    }
    if (typeof index === "number" && Number.isInteger(index)) {
        return items[index] ?? null;
    }
    return null;
}

function stateMap() {
    return new Map(getTaskStates().map((state) => [ state.name, state ]));
}

/** The note's position in the tree: the `notePosition` of each branch on its best path. */
function treeOrder(note: BNote): number[] {
    const path = note.getBestNotePath();
    const order: number[] = [];
    for (let i = 1; i < path.length; i++) {
        const branch = becca.getBranchFromChildAndParent(path[i], path[i - 1]);
        order.push(branch?.notePosition ?? 0);
    }
    return order;
}

function compareOrder(a: number[], b: number[]) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return a.length - b.length;
}

function titlePath(note: BNote): string[] {
    return note.getBestNotePath()
        .slice(0, -1)
        .filter((noteId) => noteId !== "root")
        .map((noteId) => becca.getNote(noteId)?.title ?? noteId);
}

function clampLimit(raw: unknown) {
    const value = Number.parseInt(String(raw ?? ""), 10);
    if (!Number.isFinite(value) || value <= 0) {
        return DEFAULT_LIMIT;
    }
    return Math.min(value, MAX_LIMIT);
}

/** The item's own checkbox: inside its label, never one of a nested list. */
function findCheckbox(li: HTMLElement): HTMLElement | null {
    for (const child of li.childNodes) {
        if (!isElement(child)) {
            continue;
        }
        if (child.tagName === "LABEL" || child.tagName === "SPAN" || child.tagName === "P") {
            const input = child.querySelector("input[type=checkbox]");
            if (input) {
                return input;
            }
        }
        if (child.tagName === "INPUT" && child.getAttribute("type") === "checkbox") {
            return child;
        }
    }
    return null;
}

function findBlockId(li: HTMLElement): string | null {
    const own = li.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (own) {
        return own;
    }
    for (const child of li.childNodes) {
        if (!isElement(child) || child.tagName === "UL" || child.tagName === "OL") {
            continue;
        }
        const id = child.getAttribute(BLOCK_ID_ATTRIBUTE)
            ?? child.querySelector(`[${BLOCK_ID_ATTRIBUTE}]`)?.getAttribute(BLOCK_ID_ATTRIBUTE);
        if (id) {
            return id;
        }
    }
    return null;
}

function itemState(li: HTMLElement, input: HTMLElement | null) {
    const custom = li.getAttribute(TASK_STATE_ATTRIBUTE) ?? input?.getAttribute(TASK_STATE_ATTRIBUTE);
    if (custom && !isAnchorState(custom)) {
        return custom;
    }
    return input?.hasAttribute("checked") ? DONE_STATE_NAME : NONE_STATE_NAME;
}

/** Plain text of the item without its nested lists, whitespace collapsed, at most 200 characters. */
function itemText(li: HTMLElement) {
    const parts: string[] = [];
    for (const child of li.childNodes) {
        if (isElement(child) && (child.tagName === "UL" || child.tagName === "OL")) {
            continue;
        }
        parts.push(isElement(child) ? textWithoutChips(child) : child.rawText ? decodeEntities(child.rawText) : "");
        parts.push(" ");
    }
    const text = parts.join("").replace(/\s+/g, " ").trim();
    return text.length > TODO_TEXT_LIMIT ? `${text.slice(0, TODO_TEXT_LIMIT - 1)}…` : text;
}

/** The text of `element` without the Taskforce chips (`a.tf-chip`) in it. */
function textWithoutChips(element: HTMLElement): string {
    if (!element.querySelector("a.tf-chip")) {
        return element.text;
    }
    let text = "";
    for (const child of element.childNodes) {
        if (!isElement(child)) {
            text += child.rawText ? decodeEntities(child.rawText) : "";
        } else if (!(child.tagName === "A" && child.classList.contains("tf-chip"))) {
            text += textWithoutChips(child);
        }
    }
    return text;
}

function decodeEntities(raw: string) {
    return parse(`<span>${raw}</span>`).text;
}

function isElement(node: unknown): node is HTMLElement {
    return !!node && typeof node === "object" && "tagName" in node && typeof (node as HTMLElement).tagName === "string";
}

const OPEN_TAG = /^<[a-z][a-z0-9]*(?:\s+[^\s"'=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*\s*\/?>/i;

function setBooleanAttribute(tag: string, name: string, on: boolean) {
    const without = removeAttribute(tag, name);
    return on ? without.replace(/\s*(\/?>)$/, ` ${name}="${name}"$1`) : without;
}

function setAttribute(tag: string, name: string, value: string) {
    const escaped = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return removeAttribute(tag, name).replace(/\s*(\/?>)$/, ` ${name}="${escaped}"$1`);
}

function removeAttribute(tag: string, name: string) {
    const pattern = new RegExp(`\\s+${name.replace(/[-]/g, "\\-")}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+))?(?=[\\s/>])`, "gi");
    return tag.replace(pattern, "");
}
