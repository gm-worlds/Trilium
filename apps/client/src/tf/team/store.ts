/**
 * The team state of the notebook frame: the people who may open it, who is here and on which note,
 * edit locks, comment threads, unread notes and authorship. Filled from the feature routes
 * (`/__tf/api/*`) and the realtime socket (`/__tf/rt`); components read it with {@link useTeam}.
 */
import { useSyncExternalStore } from "preact/compat";

import { getTfBridge } from "../bridge.js";
import { type TfRealtime, tfFetch, tfRealtime } from "../gateway.js";
import { bumpTfTeamBadges } from "./hooks.js";
import {
    type Activity, applyCommentEvent, type Comment, type CommentEvent, filterPeople, type LockHolder,
    markUnread, parsePresenceList, parseUnread, type Person, type PresencePerson, type RevisionAuthors,
    type Thread, type UnreadAnswer, type UnreadMark
} from "./model.js";
import { TurnLock, type TurnView } from "./turns.js";

export interface TeamSelf {
    id: string;
    name: string;
    role: "edit" | "view";
}

export interface TeamState {
    self: TeamSelf | null;
    connected: boolean;
    people: Person[];
    presence: PresencePerson[];
    turn: TurnView;
    threads: ReadonlyMap<string, Thread[]>;
    commentCounts: Readonly<Record<string, number>>;
    unread: UnreadAnswer;
    unreadMarks: ReadonlyMap<string, UnreadMark>;
    activity: ReadonlyMap<string, Activity>;
    revisionAuthors: ReadonlyMap<string, RevisionAuthors>;
    /** The thread the comments panel should show, set by a margin marker or `goto`. */
    focusThread: { noteId: string; threadId: string; at: number } | null;
    /** When a keystroke was last refused because someone else has the turn. */
    blockedAt: number;
    /** A new thread about to be written on a block, from a "Comment" menu entry. */
    commentTarget: { noteId: string; blockId: string | null; quote: string | null; at: number } | null;
}

type Listener = () => void;

let state: TeamState = {
    self: null,
    connected: false,
    people: [],
    presence: [],
    turn: { noteId: null, holder: null, mine: false, takingOver: false, takeOverRefused: false },
    threads: new Map(),
    commentCounts: {},
    unread: { count: 0, mentions: 0, notes: [] },
    unreadMarks: new Map(),
    activity: new Map(),
    revisionAuthors: new Map(),
    focusThread: null,
    blockedAt: 0,
    commentTarget: null
};
const listeners = new Set<Listener>();
let realtime: TfRealtime | null = null;
let turnLock: TurnLock | null = null;
let parentsOf: (noteIds: string[]) => Promise<(noteId: string) => readonly string[]> = async () => () => [];
let lastBadge = "";

export function getTeam() {
    return state;
}

export function setTeam(patch: Partial<TeamState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) {
        listener();
    }
    if (patch.commentCounts) {
        bumpTfTeamBadges();
    }
}

export function subscribeTeam(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useTeam() {
    return useSyncExternalStore(subscribeTeam, getTeam);
}

export function getTurnLock() {
    return turnLock;
}

export function canWrite() {
    return state.self?.role === "edit";
}

//#region Start-up

export interface TeamStartOptions {
    self: TeamSelf;
    /** Resolves the parents of notes (loading them first), for the ancestor marks of unread notes. */
    parentsOf(noteIds: string[]): Promise<(noteId: string) => readonly string[]>;
}

export function startTeamStore(options: TeamStartOptions) {
    parentsOf = options.parentsOf;
    setTeam({ self: options.self });

    const rt = tfRealtime();
    realtime = rt;
    turnLock = new TurnLock({
        selfId: options.self.id,
        send: (event, data) => rt.send(event, data),
        now: () => Date.now(),
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number)
    });
    turnLock.onChange((turn) => setTeam({ turn }));

    rt.on("presence.list", (data) => setTeam({ presence: parsePresenceList(data), connected: true }));
    rt.on("lock", (data: { noteId?: string; holder?: LockHolder | null }) => turnLock?.onLock(data));
    let opened = false;
    rt.on("__open", () => {
        setTeam({ connected: true });
        onReconnect?.();
        void refreshUnread();
        void refreshCommentCounts();
        if (opened) {
            reloadAfterReconnect();
        }
        opened = true;
    });
    rt.on("__close", () => {
        setTeam({ connected: false, presence: [] });
        turnLock?.onDisconnect();
    });
    for (const event of [ "comment.created", "comment.updated", "comment.deleted", "comment.resolved" ] as CommentEvent[]) {
        rt.on(event, (comment: Comment) => onCommentEvent(event, comment));
    }
    rt.on("unread", () => void refreshUnread());

    void loadPeople();
    void refreshUnread();
    void refreshCommentCounts();
}

/**
 * What the socket did not deliver while it was down: the people, the threads of the notes open in
 * a tab (the others load again when they are opened) and their authorship. Presence and the turns
 * come back by themselves: the gateway answers the `presence` the tracker sends again with a
 * `presence.list`, and every lock request with the holder.
 */
function reloadAfterReconnect() {
    peopleRequest = null;
    serverSearches.clear();
    emptySearches.clear();
    void loadPeople();
    const open = new Set(openNoteIds());
    const threads = new Map<string, Thread[]>();
    for (const [ noteId, list ] of state.threads) {
        if (open.has(noteId)) {
            threads.set(noteId, list);
        }
    }
    threadRequests.clear();
    setTeam({ threads });
    for (const noteId of open) {
        void loadThreads(noteId, true);
        void loadActivity(noteId, true);
    }
}

let openNoteIds: () => string[] = () => [];

/** Tells the store which notes are open in a tab, for what it reloads after a reconnect. */
export function setOpenNoteIds(source: () => string[]) {
    openNoteIds = source;
}

let onReconnect: (() => void) | null = null;

/** Runs `callback` after every (re)connect of the socket, to say again where this person is. */
export function setOnReconnect(callback: () => void) {
    onReconnect = callback;
}

export function sendRealtime(event: string, data: unknown) {
    realtime?.send(event, data);
}

//#endregion

//#region People

let peopleRequest: Promise<Person[]> | null = null;
let peopleLoaded = false;

/** The members of the notebook, asked for once a session (and again after a reconnect). */
export function loadPeople(): Promise<Person[]> {
    if (!peopleRequest) {
        peopleRequest = tfFetch<{ people: Person[] }>("people")
            .then((answer) => {
                const people = Array.isArray(answer?.people) ? answer.people : [];
                peopleLoaded = true;
                setTeam({ people });
                return people;
            })
            .catch(() => {
                peopleRequest = null;
                return state.people;
            });
    }
    return peopleRequest;
}

/**
 * The people whose name matches `query`, at most `limit`, without this person, from the member list
 * loaded once. Only when no name matches does the gateway search (it also knows e-mail addresses).
 */
export async function searchPeople(query: string, limit = 8): Promise<Person[]> {
    const q = query.trim();
    const members = await loadPeople();
    const found = filterPeople(members, q, state.self?.id, limit);
    const lower = q.toLowerCase();
    if (found.length || q.length < 2 || [ ...emptySearches ].some((miss) => lower.startsWith(miss))) {
        return found;
    }
    let request = serverSearches.get(lower);
    if (!request) {
        request = tfFetch<{ people: Person[] }>(`people?q=${encodeURIComponent(q)}`)
            .then((answer) => answer.people ?? [])
            .catch(() => {
                serverSearches.delete(lower);
                return null;
            });
        serverSearches.set(lower, request);
    }
    const people = await request;
    if (!people) {
        return [];
    }
    if (!people.length) {
        emptySearches.add(lower);
    }
    return people.filter((person) => person.id !== state.self?.id).slice(0, limit);
}

/** Gateway searches of this session, and the queries nobody matched (longer ones match nobody either). */
const serverSearches = new Map<string, Promise<Person[] | null>>();
const emptySearches = new Set<string>();

/** Whether `id` is a member of this notebook; `null` until the member list has loaded. */
export function isMember(id: string): boolean | null {
    if (!peopleLoaded) {
        return state.presence.some((person) => person.id === id) ? true : null;
    }
    return state.people.some((person) => person.id === id) || state.presence.some((person) => person.id === id);
}

/** Calls `listener` whenever the member list changed. */
export function subscribePeople(listener: () => void) {
    let last = state.people;
    return subscribeTeam(() => {
        if (state.people !== last) {
            last = state.people;
            listener();
        }
    });
}

export function personById(id: string | null | undefined): Person | PresencePerson | undefined {
    if (!id) {
        return undefined;
    }
    return state.people.find((person) => person.id === id) ?? state.presence.find((person) => person.id === id);
}

//#endregion

//#region Comments

const threadRequests = new Map<string, Promise<void>>();

export function loadThreads(noteId: string, force = false) {
    if (!force && threadRequests.has(noteId)) {
        return threadRequests.get(noteId) as Promise<void>;
    }
    const request = tfFetch<{ threads: Thread[] }>(`comments?noteId=${encodeURIComponent(noteId)}`)
        .then((answer) => {
            const threads = (answer?.threads ?? []).map((thread) => ({ ...thread, replies: thread.replies ?? [] }));
            setThreads(noteId, threads);
        })
        .catch(() => {
            threadRequests.delete(noteId);
        });
    threadRequests.set(noteId, request);
    return request;
}

function setThreads(noteId: string, threads: Thread[]) {
    const next = new Map(state.threads);
    next.set(noteId, threads);
    setTeam({ threads: next });
}

function onCommentEvent(event: CommentEvent, comment: Comment) {
    if (!comment || typeof comment.noteId !== "string") {
        return;
    }
    const current = state.threads.get(comment.noteId);
    if (current) {
        setThreads(comment.noteId, applyCommentEvent(current, comment.noteId, event, comment));
    }
    scheduleCountsRefresh();
}

/** Applies a comment the frame itself just wrote, ahead of its realtime echo. */
export function applyOwnComment(event: CommentEvent, comment: Comment) {
    onCommentEvent(event, comment);
}

let countsTimer: number | null = null;

function scheduleCountsRefresh() {
    if (countsTimer !== null) {
        window.clearTimeout(countsTimer);
    }
    countsTimer = window.setTimeout(() => {
        countsTimer = null;
        void refreshCommentCounts();
    }, 250);
}

export async function refreshCommentCounts() {
    try {
        const answer = await tfFetch<{ counts: Record<string, number> }>("comments/counts");
        setTeam({ commentCounts: answer?.counts ?? {} });
    } catch {
        // The counts stay as they were until the next event.
    }
}

export function focusThread(noteId: string, threadId: string) {
    setTeam({ focusThread: { noteId, threadId, at: Date.now() } });
}

//#endregion

//#region Unread

let unreadRequest: Promise<void> | null = null;
let unreadAgain = false;

export function refreshUnread(): Promise<void> {
    if (unreadRequest) {
        unreadAgain = true;
        return unreadRequest;
    }
    unreadRequest = (async () => {
        try {
            const unread = parseUnread(await tfFetch("unread"));
            const ids = unread.notes.map((note) => note.noteId);
            const getParents = await parentsOf(ids).catch(() => () => []);
            setTeam({ unread, unreadMarks: markUnread(ids, getParents) });
            sendBadge();
        } catch {
            // Kept until the next `unread` event.
        } finally {
            unreadRequest = null;
            if (unreadAgain) {
                unreadAgain = false;
                void refreshUnread();
            }
        }
    })();
    return unreadRequest;
}

/** Marks `noteId` seen, locally at once and then on the server. */
export async function markSeen(noteId: string) {
    if (!state.unreadMarks.has(noteId) || state.unreadMarks.get(noteId) !== "unread") {
        return;
    }
    const notes = state.unread.notes.filter((note) => note.noteId !== noteId);
    const removed = state.unread.notes.length - notes.length;
    const unread = { ...state.unread, notes, count: Math.max(0, state.unread.count - removed) };
    const getParents = await parentsOf(notes.map((note) => note.noteId)).catch(() => () => []);
    setTeam({ unread, unreadMarks: markUnread(notes.map((note) => note.noteId), getParents) });
    sendBadge();
    try {
        await tfFetch("seen", { json: { noteId } });
    } finally {
        void refreshUnread();
    }
}

export async function markAllSeen() {
    setTeam({ unread: { count: 0, mentions: 0, notes: [] }, unreadMarks: new Map() });
    sendBadge();
    try {
        await tfFetch("seen-all", { json: {} });
    } finally {
        void refreshUnread();
    }
}

function sendBadge() {
    const badge = { unread: state.unread.count, mentions: state.unread.mentions };
    const key = JSON.stringify(badge);
    if (key !== lastBadge) {
        lastBadge = key;
        getTfBridge()?.notify("badge", badge);
    }
}

//#endregion

//#region Authorship

const activityRequests = new Map<string, number>();

export async function loadActivity(noteId: string, force = false) {
    const last = activityRequests.get(noteId) ?? 0;
    if (!force && Date.now() - last < 2000) {
        return;
    }
    activityRequests.set(noteId, Date.now());
    try {
        const answer = await tfFetch<Activity>(`activity?noteId=${encodeURIComponent(noteId)}`);
        const next = new Map(state.activity);
        next.set(noteId, { lastEditedBy: answer?.lastEditedBy ?? null, lastEditedAt: answer?.lastEditedAt ?? null });
        setTeam({ activity: next });
    } catch {
        // Nothing shown until the next refresh.
    }
}

export async function loadRevisionAuthors(noteId: string) {
    try {
        const answer = await tfFetch<RevisionAuthors>(`revisions/authors?noteId=${encodeURIComponent(noteId)}`);
        const next = new Map(state.revisionAuthors);
        next.set(noteId, answer && typeof answer === "object" ? answer : {});
        setTeam({ revisionAuthors: next });
    } catch {
        // Revisions without a known author show nothing.
    }
}

//#endregion
