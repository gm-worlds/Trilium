/**
 * Pure decisions of the work features in the text editor, kept free of the editor and the app
 * state so they are unit tested: which to-do items a task's state still has to tick and who ticks
 * them, when the editor's to-do index is stale, what a chip opens and shows, and request ids.
 */
import type { TfLinkKind, TfLinkRef } from "./links.js";

const BLOCK_ID_ATTRIBUTE = "data-trilium-block-id";

//#region Ticking a task's to-do items

/** A to-do item as `POST /api/tf/todos/toggle` finds it: by block id, else by its index. */
export interface TodoTarget {
    blockId: string | null;
    index: number;
}

/**
 * The to-do items of a text note's HTML that carry a chip of task `taskId` and are not yet in the
 * state `done`. Items are counted like the engine counts them: every `ul.todo-list > li`, in
 * document order.
 */
export function todoTargetsForTask(html: string, taskId: string, done: boolean): TodoTarget[] {
    if (!html.includes("todo-list") || !html.includes(taskId)) {
        return [];
    }
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const targets: TodoTarget[] = [];
    for (const [ index, li ] of [ ...doc.body.querySelectorAll("ul.todo-list > li") ].entries()) {
        const carries = [ ...li.querySelectorAll("a.tf-chip[data-tf-kind='task']") ]
            .some((chip) => chip.getAttribute("data-tf-id") === taskId && chip.closest("li") === li);
        if (carries && isChecked(li) !== done) {
            targets.push({ blockId: blockIdOf(li), index });
        }
    }
    return targets;
}

function isChecked(li: Element) {
    for (const child of li.children) {
        if (child.matches("ul, ol")) {
            continue;
        }
        const box = child.matches("input[type=checkbox]") ? child : child.querySelector("input[type=checkbox]");
        if (box) {
            return box.hasAttribute("checked");
        }
    }
    return false;
}

function blockIdOf(li: Element) {
    const own = li.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (own) {
        return own;
    }
    for (const child of li.children) {
        if (child.matches("ul, ol")) {
            continue;
        }
        const id = child.getAttribute(BLOCK_ID_ATTRIBUTE) ?? child.querySelector(`[${BLOCK_ID_ATTRIBUTE}]`)?.getAttribute(BLOCK_ID_ATTRIBUTE);
        if (id) {
            return id;
        }
    }
    return null;
}

/**
 * The to-do item of the `index`-th to-do checkbox of a text note's HTML, as the engine finds it:
 * the block id of its `<li>` and the item's index among `ul.todo-list > li`, with whether it is
 * ticked now. `null` when there is no such checkbox.
 */
export function todoItemAt(html: string, checkboxIndex: number): (TodoTarget & { checked: boolean }) | null {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const box = [ ...doc.body.querySelectorAll(".todo-list input[type=checkbox]") ][checkboxIndex];
    const li = box?.closest("li");
    if (!box || !li) {
        return null;
    }
    return {
        blockId: blockIdOf(li),
        index: [ ...doc.body.querySelectorAll("ul.todo-list > li") ].indexOf(li),
        checked: box.hasAttribute("checked")
    };
}

/**
 * Whether this frame ticks a note's to-do items after its task changed, so that exactly one of the
 * frames that have the note open does it: the one whose person has the turn on the note, or, while
 * nobody has it, the one whose person's id sorts first among the people on the note.
 */
export function isTicker({ selfId, mine, holderId, presentIds }: {
    selfId: string;
    mine: boolean;
    /** Who else has the turn on the note (holds its lock or is typing in it), if anyone. */
    holderId: string | null;
    /** The other people the presence list puts on the note. */
    presentIds: readonly string[];
}) {
    if (mine) {
        return true;
    }
    if (holderId) {
        return false;
    }
    return [ selfId, ...presentIds ].toSorted()[0] === selfId;
}

/** The model changes after which the editor's list of to-do items has to be read again. */
const STRUCTURE_ATTRIBUTES = new Set([
    "listType", "listItemId", "listIndent", "blockId", "todoListChecked", "taskState", "tfChipKind", "tfChipId"
]);

/** Whether `changes` (`differ.getChanges()`) can have added, removed or changed a to-do item. */
export function touchesTodoStructure(changes: Iterable<{ type: string; name?: string; attributeKey?: string }>) {
    for (const change of changes) {
        if (change.type === "insert" || change.type === "remove") {
            if (change.name !== "$text") {
                return true;
            }
        } else if (change.type === "attribute" && change.attributeKey && STRUCTURE_ATTRIBUTES.has(change.attributeKey)) {
            return true;
        }
    }
    return false;
}

//#endregion

//#region Chips

/**
 * Whether a stored chip is what its link says: the link is a Taskforce link (`parse` answers only
 * for those, on an allowed origin) of the stated kind and id.
 */
export function isGenuineChip(href: string, kind: string, id: string, parse: (href: string) => Pick<TfLinkRef, "kind" | "id"> | null) {
    const ref = parse(href);
    if (!ref || ref.kind !== kind) {
        return false;
    }
    return ref.id === id || (kind !== "note" && ref.id.toLowerCase() === id.toLowerCase());
}

/**
 * What the host's `open` gets for a chip: the path Taskforce answered for it, else the path of its
 * link once that is checked to be a Taskforce link of the chip's kind and id. `null` opens nothing.
 */
export function chipOpenTarget(
    data: { href: string; kind: TfLinkKind; id: string },
    resolved: { href: string } | null,
    parse: (href: string) => TfLinkRef | null,
    toHostPath: (href: string) => string
): string | null {
    const answered = resolved?.href ? toHostPath(resolved.href) : null;
    if (answered?.startsWith("/") && !answered.startsWith("//")) {
        return answered;
    }
    const ref = parse(data.href);
    if (!ref || !isGenuineChip(data.href, data.kind, data.id, parse)) {
        return null;
    }
    return toHostPath(ref.href);
}

/** What a chip with no title yet is called: the host name of its link at most. */
export function chipPlaceholder(href: string) {
    try {
        return new URL(href).host;
    } catch {
        return "";
    }
}

//#endregion

/** A random version 4 UUID (`crypto.randomUUID()` needs a secure context, which a notebook may lack). */
export function newRequestId(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) => crypto.getRandomValues(bytes)) {
    const bytes = random(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
