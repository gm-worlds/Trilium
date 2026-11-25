import { describe, expect, it } from "vitest";

import {
    applyCommentEvent, buildThreads, type Comment, diffMentions, extractMentions, filterPeople, formatAgo, initialsOf,
    markUnread, mentionedIn, mentionLabel, MentionLedger, mentionQueryAt, openThreadsByBlock, othersOnNote,
    parsePresenceList, presenceByNote, stackOf
} from "./model.js";

const ada = { id: "ada", name: "Ada Lovelace", avatar: null, color: "#1c7ed6" };
const bea = { id: "bea", name: "Bea", avatar: null, color: "#2f9e44" };

function comment(id: string, extra: Partial<Comment> = {}): Comment {
    return {
        id, noteId: "n1", blockId: null, threadId: null, body: id, quote: null, mentions: [], author: ada,
        createdAt: `2026-11-25T10:00:0${id.length}Z`, editedAt: null, resolvedAt: null, resolvedBy: null,
        deleted: false, ...extra
    };
}

describe("presence", () => {
    const people = parsePresenceList({ people: [
        { id: "me", name: "Me", noteId: "n1", editing: true, color: "#000" },
        { id: "bea", name: "Bea", noteId: "n1", editing: false, color: "#2f9e44" },
        { id: "ada", name: "Ada", noteId: "n1", editing: true, color: "#1c7ed6" },
        { id: "cy", name: "Cy", noteId: "n2", editing: false, color: "#e8590c" },
        { name: "no id" }
    ] });

    it("lists the others on a note, typing first, and groups them by note", () => {
        expect(people.length).toBe(4);
        expect(othersOnNote(people, "n1", "me").map((p) => p.id)).toEqual([ "ada", "bea" ]);
        expect(othersOnNote(people, undefined, "me")).toEqual([]);
        const byNote = presenceByNote(people, "me");
        expect([ ...byNote.keys() ]).toEqual([ "n1", "n2" ]);
        expect(byNote.get("n1")?.map((p) => p.id)).toEqual([ "bea", "ada" ]);
    });

    it("stacks at most three and names the rest, with initials", () => {
        expect(stackOf([ 1, 2, 3, 4, 5 ])).toEqual({ shown: [ 1, 2, 3 ], extra: 2 });
        expect(stackOf([ 1 ])).toEqual({ shown: [ 1 ], extra: 0 });
        expect([ initialsOf("Ada Lovelace"), initialsOf("bea"), initialsOf(" "), initialsOf("Jan van Dijk") ]).toEqual([ "AL", "BE", "?", "JD" ]);
    });
});

describe("comment threads", () => {
    it("builds threads from flat comments, dropping deleted replies and empty deleted roots", () => {
        const threads = buildThreads([
            comment("r2", { threadId: "t1", createdAt: "2026-11-25T10:00:05Z" }),
            comment("t1", { createdAt: "2026-11-25T10:00:01Z" }),
            comment("r1", { threadId: "t1", createdAt: "2026-11-25T10:00:03Z" }),
            comment("rx", { threadId: "t1", deleted: true }),
            comment("t2", { deleted: true, createdAt: "2026-11-25T10:00:02Z" })
        ]);
        expect(threads.map((t) => [ t.id, t.replies.map((r) => r.id) ])).toEqual([ [ "t1", [ "r1", "r2" ] ] ]);
    });

    it("applies created, updated, resolved and deleted events of its own note only", () => {
        let threads = buildThreads([ comment("t1", { blockId: "b1" }) ]);
        threads = applyCommentEvent(threads, "n1", "comment.created", comment("r1", { threadId: "t1" }));
        threads = applyCommentEvent(threads, "n1", "comment.created", comment("r1", { threadId: "t1" }));
        threads = applyCommentEvent(threads, "n1", "comment.created", comment("t22", { blockId: "b1" }));
        threads = applyCommentEvent(threads, "n1", "comment.created", comment("other", { noteId: "n2" }));
        expect(threads.map((t) => [ t.id, t.replies.length ])).toEqual([ [ "t1", 1 ], [ "t22", 0 ] ]);
        expect(openThreadsByBlock(threads).get("b1")?.length).toBe(2);

        threads = applyCommentEvent(threads, "n1", "comment.updated", comment("r1", { threadId: "t1", body: "edited" }));
        expect(threads[0].replies[0].body).toBe("edited");

        threads = applyCommentEvent(threads, "n1", "comment.resolved", comment("t1", { resolvedAt: "2026-11-25T11:00:00Z", resolvedBy: bea, blockId: "b1" }));
        expect(threads[0].resolvedBy?.id).toBe("bea");
        expect(threads[0].replies.length).toBe(1);
        expect(openThreadsByBlock(threads).get("b1")?.map((t) => t.id)).toEqual([ "t22" ]);

        threads = applyCommentEvent(threads, "n1", "comment.deleted", comment("t22", { deleted: true }));
        threads = applyCommentEvent(threads, "n1", "comment.deleted", comment("t1", { deleted: true, body: "" }));
        expect(threads.map((t) => [ t.id, t.deleted ])).toEqual([ [ "t1", true ] ]);
        threads = applyCommentEvent(threads, "n1", "comment.deleted", comment("r1", { threadId: "t1", deleted: true }));
        expect(threads).toEqual([]);
    });

    it("finds @people in a body and the @ query at the caret", () => {
        const ann = { id: "ann", name: "Ann", avatar: null, color: "" };
        const annLee = { id: "al", name: "Ann Lee", avatar: null, color: "" };
        expect(mentionedIn("ask @Ann Lee and @Bea", [ ann, annLee, bea ]).map((p) => p.id)).toEqual([ "al", "bea" ]);
        expect(mentionQueryAt("hi @Be", 6)).toEqual({ start: 3, query: "Be" });
        expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
        expect(mentionQueryAt("mail a@b", 8)).toBeNull();
        expect(mentionQueryAt("no at", 5)).toBeNull();
    });
});

describe("mentions in note text", () => {
    const html = `<p data-trilium-block-id="b1">Ask <span class="tf-mention" data-tf-person-id="bea" data-tf-person-name="Bea">@Bea</span> about it</p>`
        + `<ul><li data-trilium-block-id="b2">and <span class="tf-mention" data-tf-person-id="ada">@Ada</span>, <span class="tf-mention" data-tf-person-id="bea">@Bea</span></li></ul>`
        + `<p>loose <span class="tf-mention" data-tf-person-id="cy">@Cy</span></p>`;

    it("extracts each mention with its block and excerpt", () => {
        expect(extractMentions(html)).toEqual([
            { personId: "bea", blockId: "b1", excerpt: "Ask @Bea about it" },
            { personId: "ada", blockId: "b2", excerpt: "and @Ada, @Bea" },
            { personId: "bea", blockId: "b2", excerpt: "and @Ada, @Bea" },
            { personId: "cy", blockId: null, excerpt: "loose @Cy" }
        ]);
        expect(extractMentions("<p>none</p>")).toEqual([]);
        expect(extractMentions(`<p>${"x".repeat(300)} <span class="tf-mention" data-tf-person-id="a">@A</span></p>`)[0].excerpt.length).toBe(140);
    });

    it("reports only the people new since the last save, per block", () => {
        const first = diffMentions(undefined, extractMentions(html));
        expect(first.notices).toEqual([
            { blockId: "b1", userIds: [ "bea" ], excerpt: "Ask @Bea about it" },
            { blockId: "b2", userIds: [ "ada", "bea" ], excerpt: "and @Ada, @Bea" },
            { blockId: null, userIds: [ "cy" ], excerpt: "loose @Cy" }
        ]);
        const again = diffMentions(first.keys, extractMentions(html));
        expect(again.notices).toEqual([]);
        const moved = diffMentions(first.keys, extractMentions(html.replace(`data-trilium-block-id="b1"`, `data-trilium-block-id="b9"`)));
        expect(moved.notices).toEqual([ { blockId: "b9", userIds: [ "bea" ], excerpt: "Ask @Bea about it" } ]);
    });

    it("reports only mentions added in this frame, once, and none for content it loaded", () => {
        const ledger = new MentionLedger();
        const loaded = extractMentions(html);
        ledger.learn("n1", loaded);
        // The first save after opening the note names the same people: nobody hears of it again.
        expect(ledger.take("n1", loaded)).toEqual([]);

        const added = `${html}<p data-trilium-block-id="b3">Hi <span class="tf-mention" data-tf-person-id="dan">@Dan</span></p>`;
        expect(ledger.take("n1", extractMentions(added))).toEqual([ { blockId: "b3", userIds: [ "dan" ], excerpt: "Hi @Dan" } ]);
        // Removed, then pasted or undone back: already reported.
        expect(ledger.take("n1", loaded)).toEqual([]);
        expect(ledger.take("n1", extractMentions(added))).toEqual([]);

        // Someone else's save reloaded into the editor: their mention is theirs to report.
        const theirs = `${added}<p data-trilium-block-id="b4"><span class="tf-mention" data-tf-person-id="eve">@Eve</span></p>`;
        ledger.learn("n1", extractMentions(theirs));
        expect(ledger.take("n1", extractMentions(theirs))).toEqual([]);
    });

    it("sends a failed notice again with the next save, and only that one", () => {
        const ledger = new MentionLedger();
        ledger.learn("n1", []);
        const [ first, second ] = ledger.take("n1", extractMentions(html));
        expect(first?.userIds).toEqual([ "bea" ]);
        ledger.forget("n1", second);
        expect(ledger.take("n1", extractMentions(html))).toEqual([ { blockId: "b2", userIds: [ "ada", "bea" ], excerpt: "and @Ada, @Bea" } ]);
    });

    it("learns a note no editor loaded from its first save instead of reporting it", () => {
        const ledger = new MentionLedger();
        expect(ledger.take("n2", extractMentions(html))).toEqual([]);
        expect(ledger.take("n2", extractMentions(html))).toEqual([]);
    });

    it("shows a mention by the member's current name, never by the stored one", () => {
        expect(mentionLabel("Bea", true, "Unknown person")).toBe("Bea");
        expect(mentionLabel(undefined, false, "Unknown person")).toBe("Unknown person");
        expect(mentionLabel("Boss", false, "Unknown person")).toBe("Unknown person");
        expect(mentionLabel(undefined, null, "Unknown person")).toBe("…");
    });
});

describe("people search", () => {
    const people = [ { id: "a", name: "Ada Lovelace" }, { id: "b", name: "Bea" }, { id: "c", name: "Abe" }, { id: "me", name: "Me Abby" } ];

    it("filters the member list by name, starts first, without the person searching", () => {
        expect(filterPeople(people, "ab", "me", 5).map((person) => person.id)).toEqual([ "c" ]);
        expect(filterPeople(people, "A", "me", 5).map((person) => person.id)).toEqual([ "c", "a", "b" ]);
        expect(filterPeople(people, " ", "me", 2).map((person) => person.id)).toEqual([ "a", "b" ]);
        expect(filterPeople(people, "zed", "me", 5)).toEqual([]);
    });
});

describe("unread marks", () => {
    it("marks unread notes and every ancestor through all parents, unread wins", () => {
        const parents: Record<string, string[]> = { a: [ "p" ], p: [ "root" ], b: [ "p", "q" ], q: [ "root" ], root: [ "none" ] };
        const marks = markUnread([ "a", "b", "p" ], (id) => parents[id] ?? []);
        expect(Object.fromEntries(marks)).toEqual({ a: "unread", b: "unread", p: "unread", q: "ancestor", root: "ancestor" });
        expect(markUnread([], () => []).size).toBe(0);
    });
});

describe("formatAgo", () => {
    it("says just now under a minute, then the largest unit", () => {
        const now = Date.parse("2026-11-25T10:10:00Z");
        expect(formatAgo("2026-11-25T10:09:30Z", now, "en", "just now")).toBe("just now");
        expect(formatAgo("2026-11-25T10:07:00Z", now, "en", "just now")).toBe("3 min. ago");
        expect(formatAgo("2026-11-24T10:00:00Z", now, "en", "just now")).toBe("yesterday");
        expect(formatAgo(null, now, "en", "just now")).toBe("");
    });
});
