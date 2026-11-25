import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isOwnEdit, isTakenByOthers, KEEP_ALIVE_MS, planEditorLocks, RELEASE_AFTER_MS, TurnLock } from "./turns.js";

const ADA = { id: "ada", name: "Ada", color: "#1c7ed6" };
const BEA = { id: "bea", name: "Bea", color: "#2f9e44" };

function setup() {
    const sent: [string, { noteId: string }][] = [];
    const lock = new TurnLock({
        selfId: BEA.id,
        send: (event, data) => sent.push([ event, data ]),
        now: () => Date.now(),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    });
    const refused = vi.fn();
    lock.onRefused(refused);
    lock.setNote("n1");
    return { lock, sent, refused };
}

describe("TurnLock", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("requests on the first keystroke, keeps the lock alive while typing and releases 5 s after the last", () => {
        const { lock, sent } = setup();
        expect(lock.keystroke()).toBe(true);
        expect(sent).toEqual([ [ "lock.request", { noteId: "n1" } ] ]);

        lock.onLock({ noteId: "n1", holder: BEA });
        expect(lock.view).toMatchObject({ mine: true, holder: null });

        vi.advanceTimersByTime(KEEP_ALIVE_MS - 1);
        lock.keystroke();
        expect(sent.length).toBe(1);
        vi.advanceTimersByTime(1);
        lock.keystroke();
        expect(sent.length).toBe(2);
        expect(sent[1][0]).toBe("lock.request");

        vi.advanceTimersByTime(RELEASE_AFTER_MS - 1);
        expect(sent.length).toBe(2);
        vi.advanceTimersByTime(1);
        expect(sent[2]).toEqual([ "lock.release", { noteId: "n1" } ]);
        expect(lock.view.mine).toBe(false);
    });

    it("blocks keystrokes while someone else holds the lock, and reverts optimistic ones on a refusal", () => {
        const { lock, sent, refused } = setup();
        expect(lock.keystroke()).toBe(true);
        lock.onLock({ noteId: "n1", holder: ADA });
        expect(refused).toHaveBeenCalledTimes(1);
        expect(lock.view).toMatchObject({ holder: ADA, mine: false });
        expect(lock.keystroke()).toBe(false);
        expect(sent.length).toBe(1);

        // A broadcast grant to someone else while nothing was typed is no refusal.
        lock.onLock({ noteId: "n1", holder: null });
        lock.onLock({ noteId: "n1", holder: ADA });
        expect(refused).toHaveBeenCalledTimes(1);

        lock.onLock({ noteId: "n1", holder: null });
        expect(lock.view.holder).toBeNull();
        expect(lock.keystroke()).toBe(true);
    });

    it("take over: refused while the holder types, granted once they were silent", () => {
        const { lock, sent } = setup();
        lock.onLock({ noteId: "n1", holder: ADA });
        lock.takeOver();
        expect(lock.view.takingOver).toBe(true);
        expect(sent.at(-1)).toEqual([ "lock.request", { noteId: "n1" } ]);

        lock.onLock({ noteId: "n1", holder: ADA });
        expect(lock.view).toMatchObject({ takingOver: false, takeOverRefused: true, holder: ADA });

        lock.takeOver();
        expect(lock.view.takeOverRefused).toBe(false);
        lock.onLock({ noteId: "n1", holder: BEA });
        expect(lock.view).toMatchObject({ mine: true, holder: null, takingOver: false });
    });

    it("releases on a note change and remembers the holders of other notes", () => {
        const { lock, sent } = setup();
        lock.keystroke();
        lock.onLock({ noteId: "n1", holder: BEA });
        lock.onLock({ noteId: "n2", holder: ADA });
        expect(lock.view.holder).toBeNull();

        lock.setNote("n2");
        expect(sent.at(-1)).toEqual([ "lock.release", { noteId: "n1" } ]);
        expect(lock.view.holder).toEqual(ADA);
        expect(lock.keystroke()).toBe(false);

        vi.advanceTimersByTime(RELEASE_AFTER_MS * 2);
        expect(sent.filter(([ event ]) => event === "lock.release").length).toBe(1);
    });

    it("forgets every lock when the socket drops", () => {
        const { lock } = setup();
        lock.onLock({ noteId: "n1", holder: ADA });
        lock.onDisconnect();
        expect(lock.view.holder).toBeNull();
        expect(lock.keystroke()).toBe(true);
    });

    it("tells who holds any note's lock, never this person", () => {
        const { lock } = setup();
        lock.onLock({ noteId: "n7", holder: ADA });
        lock.onLock({ noteId: "n8", holder: BEA });
        expect(lock.holderOf("n7")).toEqual(ADA);
        expect(lock.holderOf("n8")).toBeNull();
        expect(lock.holderOf("n9")).toBeNull();
    });
});

describe("editor locks", () => {
    const editorA = { name: "editor of split 1" };
    const editorB = { name: "editor of split 2" };
    const taken = (noteIds: string[]) => (noteId: string) => noteIds.includes(noteId);

    it("lifts a lock from the editor it was put on when the turn ends, whichever tab is active", () => {
        const first = planEditorLocks([ { ntxId: "t1", noteId: "A", editor: editorA }, { ntxId: "t2", noteId: "C", editor: editorB } ], [], taken([ "A" ]));
        expect(first.take).toEqual([ { ntxId: "t1", noteId: "A", editor: editorA } ]);

        const ended = planEditorLocks([ { ntxId: "t1", noteId: "A", editor: editorA }, { ntxId: "t2", noteId: "C", editor: editorB } ], first.take, taken([]));
        expect(ended.release).toEqual(first.take);
        expect(ended.take).toEqual([]);
    });

    it("locks every split of a taken note and lifts the lock after a note switch or a closed tab", () => {
        const both = planEditorLocks([ { ntxId: "s1", noteId: "A", editor: editorA }, { ntxId: "s2", noteId: "A", editor: editorB } ], [], taken([ "A" ]));
        expect(both.take.map((lock) => lock.ntxId)).toEqual([ "s1", "s2" ]);

        // s1 now shows C (same editor), s2 was closed.
        const after = planEditorLocks([ { ntxId: "s1", noteId: "C", editor: editorA } ], both.take, taken([ "A" ]));
        expect(after.release.map((lock) => lock.ntxId)).toEqual([ "s1", "s2" ]);
        expect(after.take).toEqual([]);
        expect(after.keep).toEqual([]);
    });

    it("keeps a lock that still holds and moves it to a rebuilt editor", () => {
        const applied = [ { ntxId: "s1", noteId: "A", editor: editorA } ];
        expect(planEditorLocks(applied, applied, taken([ "A" ]))).toEqual({ keep: applied, release: [], take: [] });

        const rebuilt = planEditorLocks([ { ntxId: "s1", noteId: "A", editor: editorB } ], applied, taken([ "A" ]));
        expect(rebuilt.release).toEqual(applied);
        expect(rebuilt.take).toEqual([ { ntxId: "s1", noteId: "A", editor: editorB } ]);
    });

    it("counts a note taken while someone else holds or types in it and this person does not hold it", () => {
        expect(isTakenByOthers("A", { mine: false, holder: ADA, othersEditing: false })).toBe(true);
        expect(isTakenByOthers("A", { mine: false, holder: null, othersEditing: true })).toBe(true);
        expect(isTakenByOthers("A", { mine: true, holder: null, othersEditing: true })).toBe(false);
        expect(isTakenByOthers("A", { mine: false, holder: null, othersEditing: false })).toBe(false);
    });

    it("asks for the turn on own edits only: not on loads, invisible ids or reverts", () => {
        expect(isOwnEdit({ isUndoable: true, isLocal: true }, false)).toBe(true);
        expect(isOwnEdit({ isUndoable: false, isLocal: true }, false)).toBe(false);
        expect(isOwnEdit({ isUndoable: true, isLocal: false }, false)).toBe(false);
        expect(isOwnEdit({ isUndoable: true, isLocal: true }, true)).toBe(false);
    });
});
