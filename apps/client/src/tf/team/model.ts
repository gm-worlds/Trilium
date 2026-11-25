/**
 * The shapes of the team routes and realtime events (`infra/notes/README.md` in Taskforce,
 * "Feature routes" and "Realtime"), and the pure logic built on them: presence, comment threads,
 * mentions in note text, unread marks. No DOM and no app state, so all of it is unit tested.
 */

export interface Person {
    id: string;
    name: string;
    avatar: string | null;
    color: string;
}

export interface PresencePerson {
    id: string;
    name: string;
    avatar?: string | null;
    noteId: string | null;
    editing: boolean;
    color: string;
}

export interface LockHolder {
    id: string;
    name: string;
    color: string;
}

export interface Comment {
    id: string;
    noteId: string;
    blockId: string | null;
    threadId: string | null;
    body: string;
    quote: string | null;
    mentions: Person[];
    author: Person | null;
    createdAt: string;
    editedAt: string | null;
    resolvedAt: string | null;
    resolvedBy: Person | null;
    deleted: boolean;
}

export interface Thread extends Comment {
    replies: Comment[];
}

export interface UnreadNote {
    noteId: string;
    title: string;
    changedAt: string;
    by: Person | null;
}

export interface UnreadAnswer {
    count: number;
    mentions: number;
    notes: UnreadNote[];
}

export interface Activity {
    lastEditedBy: Person | null;
    lastEditedAt: string | null;
}

export type RevisionAuthors = Record<string, { id: string; name: string; avatar: string | null }>;

//#region Presence

/** Everyone in the notebook but `selfId`, one entry each. */
export function othersOf(people: readonly PresencePerson[], selfId: string | undefined) {
    return people.filter((person) => person.id !== selfId);
}

/** The other people on `noteId`, the ones typing first, then by name. */
export function othersOnNote(people: readonly PresencePerson[], noteId: string | undefined, selfId: string | undefined) {
    if (!noteId) {
        return [];
    }
    return othersOf(people, selfId)
        .filter((person) => person.noteId === noteId)
        .toSorted((a, b) => Number(b.editing) - Number(a.editing) || a.name.localeCompare(b.name));
}

/** The other people by the note each is on. */
export function presenceByNote(people: readonly PresencePerson[], selfId: string | undefined) {
    const byNote = new Map<string, PresencePerson[]>();
    for (const person of othersOf(people, selfId)) {
        if (person.noteId) {
            byNote.set(person.noteId, [ ...(byNote.get(person.noteId) ?? []), person ]);
        }
    }
    return byNote;
}

/** The first `max` people of a stack, and how many more there are. */
export function stackOf<T>(people: readonly T[], max = 3) {
    return { shown: people.slice(0, max), extra: Math.max(0, people.length - max) };
}

/** Up to two initials of `name`. */
export function initialsOf(name: string) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
        return "?";
    }
    const letters = words.length === 1 ? [ ...words[0] ].slice(0, 2) : [ [ ...words[0] ][0], [ ...words[words.length - 1] ][0] ];
    return letters.join("").toUpperCase();
}

/** Reads a `presence.list` frame; entries without an id or a name are dropped. */
export function parsePresenceList(data: unknown): PresencePerson[] {
    const people = (data as { people?: unknown } | null)?.people;
    if (!Array.isArray(people)) {
        return [];
    }
    return people
        .filter((person): person is PresencePerson => !!person && typeof person.id === "string" && typeof person.name === "string")
        .map((person) => ({
            id: person.id,
            name: person.name,
            avatar: person.avatar ?? null,
            noteId: typeof person.noteId === "string" ? person.noteId : null,
            editing: person.editing === true,
            color: typeof person.color === "string" ? person.color : ""
        }));
}

//#endregion

//#region Comments

/** Threads from a flat list of comments: roots oldest first, each with its replies oldest first. */
export function buildThreads(comments: readonly Comment[]): Thread[] {
    const roots = new Map<string, Thread>();
    const replies: Comment[] = [];
    for (const comment of comments) {
        if (comment.threadId) {
            replies.push(comment);
        } else {
            roots.set(comment.id, { ...comment, replies: [] });
        }
    }
    for (const reply of replies.toSorted(byCreatedAt)) {
        const root = reply.threadId ? roots.get(reply.threadId) : undefined;
        if (root && !reply.deleted) {
            root.replies.push(reply);
        }
    }
    return [ ...roots.values() ]
        .filter((root) => !root.deleted || root.replies.length > 0)
        .toSorted(byCreatedAt);
}

export type CommentEvent = "comment.created" | "comment.updated" | "comment.deleted" | "comment.resolved";

/** The threads of one note after a realtime comment event. Events of other notes change nothing. */
export function applyCommentEvent(threads: readonly Thread[], noteId: string, event: CommentEvent, comment: Comment): Thread[] {
    if (!comment || comment.noteId !== noteId) {
        return threads as Thread[];
    }

    if (!comment.threadId) {
        const existing = threads.find((thread) => thread.id === comment.id);
        if (event === "comment.created" && !existing) {
            return [ ...threads, { ...comment, replies: [] } ].toSorted(byCreatedAt);
        }
        if (!existing) {
            return threads as Thread[];
        }
        if (event === "comment.deleted" && existing.replies.length === 0) {
            return threads.filter((thread) => thread.id !== comment.id);
        }
        return threads.map((thread) => thread.id === comment.id ? { ...comment, replies: thread.replies } : thread);
    }

    return threads.map((thread) => {
        if (thread.id !== comment.threadId) {
            return thread;
        }
        const has = thread.replies.some((reply) => reply.id === comment.id);
        if (event === "comment.deleted") {
            const replies = thread.replies.filter((reply) => reply.id !== comment.id);
            return { ...thread, replies };
        }
        if (event === "comment.created" && !has) {
            return { ...thread, replies: [ ...thread.replies, comment ].toSorted(byCreatedAt) };
        }
        return { ...thread, replies: thread.replies.map((reply) => reply.id === comment.id ? comment : reply) };
    }).filter((thread) => !thread.deleted || thread.replies.length > 0);
}

/** Threads still open (not resolved, root not deleted). */
export function openThreads(threads: readonly Thread[]) {
    return threads.filter((thread) => !thread.resolvedAt && !thread.deleted);
}

/** Open threads per block id, for the margin markers. */
export function openThreadsByBlock(threads: readonly Thread[]) {
    const byBlock = new Map<string, Thread[]>();
    for (const thread of openThreads(threads)) {
        if (thread.blockId) {
            byBlock.set(thread.blockId, [ ...(byBlock.get(thread.blockId) ?? []), thread ]);
        }
    }
    return byBlock;
}

/** The people named in `body` with `@Name`, out of `candidates`, longest names first so "Ann Lee" beats "Ann". */
export function mentionedIn(body: string, candidates: readonly Person[]) {
    const found: Person[] = [];
    let rest = body;
    for (const person of candidates.toSorted((a, b) => b.name.length - a.name.length)) {
        const token = `@${person.name}`;
        if (rest.includes(token) && !found.some((other) => other.id === person.id)) {
            found.push(person);
            rest = rest.split(token).join(" ");
        }
    }
    return found;
}

/**
 * The people of `people` whose name contains `query` (any case), names starting with it first, at
 * most `limit`, without `selfId`. An empty query keeps the list's order.
 */
export function filterPeople<T extends { id: string; name: string }>(people: readonly T[], query: string, selfId: string | undefined, limit: number) {
    const lower = query.trim().toLowerCase();
    const others = people.filter((person) => person.id !== selfId);
    if (!lower) {
        return others.slice(0, limit);
    }
    return others
        .map((person) => ({ person, at: person.name.toLowerCase().indexOf(lower) }))
        .filter(({ at }) => at >= 0)
        .toSorted((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.person.name.localeCompare(b.person.name))
        .slice(0, limit)
        .map(({ person }) => person);
}

/** The `@` query being typed at `caret` in a composer, or `null` when the caret is not after one. */
export function mentionQueryAt(text: string, caret: number) {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) {
        return null;
    }
    const query = before.slice(at + 1);
    if (query.length > 40 || /\n/.test(query) || /\s\s/.test(query)) {
        return null;
    }
    return { start: at, query };
}

function byCreatedAt(a: { createdAt: string }, b: { createdAt: string }) {
    return a.createdAt.localeCompare(b.createdAt);
}

//#endregion

//#region Mentions in note text

export const MENTION_CLASS = "tf-mention";
export const MENTION_PERSON_ATTRIBUTE = "data-tf-person-id";
export const MENTION_NAME_ATTRIBUTE = "data-tf-person-name";
const BLOCK_ID_SELECTOR = "[data-trilium-block-id]";
const EXCERPT_LENGTH = 140;

export interface MentionRef {
    personId: string;
    blockId: string | null;
    excerpt: string;
}

/** The person mentions in a text note's HTML, each with the id and text of the block holding it. */
export function extractMentions(html: string): MentionRef[] {
    if (!html.includes(MENTION_CLASS)) {
        return [];
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const refs: MentionRef[] = [];
    for (const element of doc.querySelectorAll(`span.${MENTION_CLASS}[${MENTION_PERSON_ATTRIBUTE}]`)) {
        const personId = element.getAttribute(MENTION_PERSON_ATTRIBUTE) ?? "";
        if (!personId) {
            continue;
        }
        const block = element.closest(BLOCK_ID_SELECTOR);
        const blockId = block?.getAttribute("data-trilium-block-id") ?? null;
        const text = (block ?? element.parentElement ?? element).textContent ?? "";
        refs.push({ personId, blockId, excerpt: excerptOf(text) });
    }
    return refs;
}

export interface MentionNotice {
    blockId: string | null;
    userIds: string[];
    excerpt: string;
}

/**
 * The mentions to report after a save: those not in `previous` (the keys of the last save), grouped
 * by block, at most 50 people each. Returns them with the keys of this save.
 */
export function diffMentions(previous: ReadonlySet<string> | undefined, refs: readonly MentionRef[]) {
    const next = new Set(refs.map(mentionKey));
    const byBlock = new Map<string, MentionNotice>();
    for (const ref of refs) {
        if (previous?.has(mentionKey(ref))) {
            continue;
        }
        const blockKey = ref.blockId ?? "";
        const notice = byBlock.get(blockKey) ?? { blockId: ref.blockId, userIds: [], excerpt: ref.excerpt };
        if (!notice.userIds.includes(ref.personId) && notice.userIds.length < 50) {
            notice.userIds.push(ref.personId);
        }
        byBlock.set(blockKey, notice);
    }
    return { notices: [ ...byBlock.values() ], keys: next };
}

function mentionKey(ref: Pick<MentionRef, "personId" | "blockId">) {
    return `${ref.personId}|${ref.blockId ?? ""}`;
}

/**
 * The name a person mention shows: the member's current name; "…" while the people are not loaded
 * yet; `unknown` for an id that is not a member. Never the name stored in the note.
 */
export function mentionLabel(name: string | undefined, isMember: boolean | null, unknown: string) {
    if (isMember === null) {
        return name ?? "…";
    }
    return isMember && name ? name : unknown;
}

/**
 * The mentions of each note this frame already knows: every mention in content an editor loaded
 * (the note opened, or reloaded after someone else's save) and every mention it reported. Only a
 * mention added in this frame is reported, once, however often it is removed and pasted or undone
 * back. A note no editor has loaded yet reports nothing; its first save teaches the ledger instead.
 */
export class MentionLedger {
    private readonly known = new Map<string, Set<string>>();

    /** Content of `noteId` an editor loaded: its mentions were written by whoever saved it. */
    learn(noteId: string, refs: readonly MentionRef[]) {
        const keys = this.known.get(noteId) ?? new Set<string>();
        for (const ref of refs) {
            keys.add(mentionKey(ref));
        }
        this.known.set(noteId, keys);
    }

    /** The notices to send after a save of `noteId` with `refs`; their mentions count as known. */
    take(noteId: string, refs: readonly MentionRef[]): MentionNotice[] {
        const keys = this.known.get(noteId);
        if (!keys) {
            this.learn(noteId, refs);
            return [];
        }
        const { notices } = diffMentions(keys, refs);
        for (const ref of refs) {
            keys.add(mentionKey(ref));
        }
        return notices;
    }

    /** A notice could not be sent: its people count as new again, the rest stays known. */
    forget(noteId: string, notice: MentionNotice) {
        const keys = this.known.get(noteId);
        for (const personId of notice.userIds) {
            keys?.delete(mentionKey({ personId, blockId: notice.blockId }));
        }
    }
}

/** The first 140 characters of `text`, whitespace collapsed. */
export function excerptOf(text: string) {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > EXCERPT_LENGTH ? `${collapsed.slice(0, EXCERPT_LENGTH - 1)}…` : collapsed;
}

//#endregion

//#region Unread

export type UnreadMark = "unread" | "ancestor";

/**
 * The mark of every note to show: the unread notes themselves, and each of their ancestors (through
 * every parent, clones included) that is not unread itself.
 */
export function markUnread(unreadIds: readonly string[], getParentIds: (noteId: string) => readonly string[]) {
    const marks = new Map<string, UnreadMark>();
    for (const noteId of unreadIds) {
        marks.set(noteId, "unread");
    }
    const seen = new Set<string>();
    const queue = [ ...unreadIds ];
    while (queue.length) {
        const noteId = queue.shift() as string;
        for (const parentId of getParentIds(noteId)) {
            if (seen.has(parentId) || parentId === "none") {
                continue;
            }
            seen.add(parentId);
            if (!marks.has(parentId)) {
                marks.set(parentId, "ancestor");
            }
            queue.push(parentId);
        }
    }
    return marks;
}

/** Reads a `GET unread` answer, tolerating missing fields. */
export function parseUnread(data: unknown): UnreadAnswer {
    const answer = (data ?? {}) as Partial<UnreadAnswer>;
    const notes = Array.isArray(answer.notes) ? answer.notes.filter((note) => !!note && typeof note.noteId === "string") : [];
    return {
        count: typeof answer.count === "number" ? answer.count : notes.length,
        mentions: typeof answer.mentions === "number" ? answer.mentions : 0,
        notes
    };
}

//#endregion

//#region Time

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    [ "year", 365 * 24 * 3600 ], [ "month", 30 * 24 * 3600 ], [ "week", 7 * 24 * 3600 ],
    [ "day", 24 * 3600 ], [ "hour", 3600 ], [ "minute", 60 ]
];

/** "3 min ago" in `locale`; "just now" (the `justNow` text) under a minute. */
export function formatAgo(iso: string | null | undefined, now: number, locale: string, justNow: string) {
    const at = iso ? Date.parse(iso) : NaN;
    if (Number.isNaN(at)) {
        return "";
    }
    const seconds = Math.round((now - at) / 1000);
    if (seconds < 60) {
        return justNow;
    }
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    for (const [ unit, size ] of UNITS) {
        if (seconds >= size) {
            return format.format(-Math.floor(seconds / size), unit);
        }
    }
    return justNow;
}

//#endregion
