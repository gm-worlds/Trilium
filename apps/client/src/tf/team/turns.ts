/**
 * Taking turns in one note: the client half of the gateway's edit locks (`lock.request`,
 * `lock.release`, `lock { noteId, holder }`, see "Realtime" in `infra/notes/README.md`).
 *
 * The first keystroke asks for the lock and is applied at once; a refusal (a `lock` naming someone
 * else while the request is out) reverts it. While typing, a request every {@link KEEP_ALIVE_MS}
 * keeps the gateway from handing the lock on (it does after 8 s of silence). The lock goes back
 * {@link RELEASE_AFTER_MS} after the last keystroke, on blur, on a note change and on unload.
 * "Take over" asks for the lock again and learns from the answer whether the holder was silent.
 */
import type { LockHolder } from "./model.js";

export const RELEASE_AFTER_MS = 5000;
export const KEEP_ALIVE_MS = 2000;

export interface TurnDeps {
    selfId: string;
    send(event: "lock.request" | "lock.release", data: { noteId: string }): void;
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface TurnView {
    noteId: string | null;
    /** Who holds the lock of the open note, if not this person. */
    holder: LockHolder | null;
    mine: boolean;
    /** A "Take over" is waiting for its answer. */
    takingOver: boolean;
    /** The last "Take over" was refused: the holder is still typing. */
    takeOverRefused: boolean;
}

type Listener = (view: TurnView) => void;

export class TurnLock {
    private noteId: string | null = null;
    private readonly holders = new Map<string, LockHolder | null>();
    private mine = false;
    private pending = false;
    private takingOver = false;
    private takeOverRefused = false;
    private lastRequestAt = -Infinity;
    private releaseTimer: unknown = null;
    private readonly listeners = new Set<Listener>();
    private readonly refusedListeners = new Set<() => void>();

    constructor(private readonly deps: TurnDeps) {}

    /** Calls `listener` with the new view after every change. Returns the unsubscribe function. */
    onChange(listener: Listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Calls `listener` when keystrokes applied ahead of the gateway's answer were refused. */
    onRefused(listener: () => void) {
        this.refusedListeners.add(listener);
        return () => this.refusedListeners.delete(listener);
    }

    get view(): TurnView {
        const holder = this.noteId ? this.holders.get(this.noteId) ?? null : null;
        return {
            noteId: this.noteId,
            holder: holder && holder.id !== this.deps.selfId ? holder : null,
            mine: this.mine,
            takingOver: this.takingOver,
            takeOverRefused: this.takeOverRefused
        };
    }

    /** Who holds the lock of `noteId` (any note the gateway told about), if not this person. */
    holderOf(noteId: string): LockHolder | null {
        const holder = this.holders.get(noteId) ?? null;
        return holder && holder.id !== this.deps.selfId ? holder : null;
    }

    /** The note open for editing changed; the lock of the previous one goes back. */
    setNote(noteId: string | null) {
        if (noteId === this.noteId) {
            return;
        }
        this.release();
        this.noteId = noteId;
        this.pending = false;
        this.takingOver = false;
        this.takeOverRefused = false;
        this.lastRequestAt = -Infinity;
        this.emit();
    }

    /**
     * A keystroke in the open note. Returns `false` when it must not be applied: someone else holds
     * the lock.
     */
    keystroke(): boolean {
        const noteId = this.noteId;
        if (!noteId) {
            return true;
        }
        if (this.view.holder) {
            return false;
        }

        const now = this.deps.now();
        if (!this.mine && !this.pending) {
            this.pending = true;
            this.request(noteId, now);
        } else if (now - this.lastRequestAt >= KEEP_ALIVE_MS) {
            this.request(noteId, now);
        }

        this.clearReleaseTimer();
        this.releaseTimer = this.deps.setTimeout(() => {
            this.releaseTimer = null;
            this.release();
        }, RELEASE_AFTER_MS);
        return true;
    }

    /** Asks for the lock someone else holds; the gateway grants it once they were silent for 8 s. */
    takeOver() {
        if (!this.noteId || !this.view.holder) {
            return;
        }
        this.takingOver = true;
        this.takeOverRefused = false;
        this.request(this.noteId, this.deps.now());
        this.emit();
    }

    /** A `lock` frame from the gateway. */
    onLock(data: { noteId?: unknown; holder?: LockHolder | null }) {
        if (typeof data?.noteId !== "string") {
            return;
        }
        const holder = data.holder && typeof data.holder.id === "string" ? data.holder : null;
        this.holders.set(data.noteId, holder);
        if (data.noteId !== this.noteId) {
            return;
        }

        if (holder?.id === this.deps.selfId) {
            this.mine = true;
            this.pending = false;
            this.takingOver = false;
            this.takeOverRefused = false;
        } else {
            const wasOptimistic = this.pending;
            this.mine = false;
            this.pending = false;
            if (this.takingOver && holder) {
                this.takeOverRefused = true;
            }
            this.takingOver = false;
            if (holder) {
                this.clearReleaseTimer();
                if (wasOptimistic) {
                    for (const listener of this.refusedListeners) {
                        listener();
                    }
                }
            } else {
                this.takeOverRefused = false;
            }
        }
        this.emit();
    }

    /** The socket closed: the gateway dropped every lock this person held. */
    onDisconnect() {
        this.holders.clear();
        this.mine = false;
        this.pending = false;
        this.takingOver = false;
        this.clearReleaseTimer();
        this.emit();
    }

    /** Gives the lock back now, if this person holds it (blur, unload, the release timer). */
    release() {
        this.clearReleaseTimer();
        if (this.noteId && (this.mine || this.pending)) {
            this.deps.send("lock.release", { noteId: this.noteId });
        }
        this.mine = false;
        this.pending = false;
        if (this.noteId && this.holders.get(this.noteId)?.id === this.deps.selfId) {
            this.holders.set(this.noteId, null);
        }
        this.emit();
    }

    private request(noteId: string, now: number) {
        this.lastRequestAt = now;
        this.deps.send("lock.request", { noteId });
    }

    private clearReleaseTimer() {
        if (this.releaseTimer !== null) {
            this.deps.clearTimeout(this.releaseTimer);
            this.releaseTimer = null;
        }
    }

    private emit() {
        const view = this.view;
        for (const listener of this.listeners) {
            listener(view);
        }
    }
}

/** An editor of a note on screen (or in a hidden tab), by the note context that shows it. */
export interface LockTarget<E = object> {
    ntxId: string;
    /** The note the editor holds now. */
    noteId: string;
    editor: E;
}

/**
 * Which turn locks to lift and which to apply. A lock stays only while the same editor of the same
 * context still shows the same note and that note is still taken; everything else is lifted from
 * the editor it was applied to, and every editor of a taken note without one gets one.
 */
export function planEditorLocks<E, A extends LockTarget<E>>(targets: readonly LockTarget<E>[], applied: readonly A[], isTaken: (noteId: string) => boolean) {
    const keep: A[] = [];
    const release: A[] = [];
    for (const lock of applied) {
        const target = targets.find((entry) => entry.ntxId === lock.ntxId);
        const holds = !!target && target.editor === lock.editor && target.noteId === lock.noteId && isTaken(lock.noteId);
        (holds ? keep : release).push(lock);
    }
    const take = targets.filter((target) => isTaken(target.noteId) && !keep.some((lock) => lock.ntxId === target.ntxId));
    return { keep, release, take };
}

/**
 * Whether someone else has the turn on `noteId`: they hold its lock or are typing in it, and this
 * person does not hold it.
 */
export function isTakenByOthers(noteId: string, { mine, holder, othersEditing }: { mine: boolean; holder: LockHolder | null; othersEditing: boolean }) {
    return !!noteId && !mine && (!!holder || othersEditing);
}

/**
 * Whether a change of a text editor's model is this person's own edit, which needs the turn:
 * undoable (loading content with `setData()` and invisible block ids are not), local, and not one
 * of the reverts of a refused edit.
 */
export function isOwnEdit(batch: { isUndoable: boolean; isLocal: boolean }, reverting: boolean) {
    return !reverting && batch.isUndoable && batch.isLocal;
}
