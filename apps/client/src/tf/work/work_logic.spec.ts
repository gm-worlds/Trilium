import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    chipOpenTarget, chipPlaceholder, isGenuineChip, isTicker, newRequestId, todoItemAt, todoTargetsForTask, touchesTodoStructure
} from "./editor_logic.js";
import { notebookIdFromOrigin, notesOriginConfig, parseTaskforceLink, toAbsoluteHref, toHostPath } from "./links.js";
import { fromLocalParts, nextMonday, quickChoices, reminderGroup, toLocalParts, tomorrowMorning } from "./reminder_time.js";

const P = "d66e7fe3-1111-4222-8333-944455556666";
const T = "223cbf1d-aaaa-4bbb-8ccc-dddddddddddd";
const D = "0b1c2d3e-0000-4111-8222-333344445555";
const NB = "lojc2kkjk6xzqnzmptkk";
const cfg = { appOrigins: [ "https://taskforce.example.com" ], notesScheme: "https", notesBaseDomain: "example.com" };

describe("Taskforce link patterns", () => {
    it("reads tasks, documents, notes and projects like Taskforce does", () => {
        expect(parseTaskforceLink(`https://taskforce.example.com/p/${P}?tab=table&task=${T.toUpperCase()}`, cfg))
            .toEqual({ kind: "task", id: T, href: `https://taskforce.example.com/p/${P}?tab=table&task=${T.toUpperCase()}` });
        expect(parseTaskforceLink(`/p/${P}/d/${D}`, cfg)).toEqual({ kind: "document", id: D, href: `https://taskforce.example.com/p/${P}/d/${D}` });
        expect(parseTaskforceLink(`/p/${P}?overview=${P}&note=6YLne9n4Z7dz`, cfg)?.kind).toBe("note");
        expect(parseTaskforceLink(`https://taskforce.example.com/p/${P}`, cfg)).toMatchObject({ kind: "project", id: P });
        expect(parseTaskforceLink(`https://nb-${NB}.example.com/#root/abc/6YLne9n4Z7dz?ntxId=x`, cfg))
            .toEqual({ kind: "note", id: `${NB}:6YLne9n4Z7dz`, href: `https://nb-${NB}.example.com/#root/abc/6YLne9n4Z7dz?ntxId=x` });
    });

    it("refuses everything else", () => {
        for (const raw of [
            "", "//evil.example/p/x", "https://example.com/p/" + P, `javascript:alert(1)`, `/p/not-a-uuid`,
            `/p/${P}?task=nope`, `/p/${P}/d/nope`, `/p/${P}/extra`, `https://nb-${NB}.example.com/`,
            `https://nb-short.example.com/#root/x`, `ftp://taskforce.example.com/p/${P}`, "x".repeat(2001)
        ]) {
            expect(parseTaskforceLink(raw, cfg)).toBeNull();
        }
    });

    it("derives the notebook origin config and host paths", () => {
        expect(notesOriginConfig({ protocol: "http:", host: `nb-${NB}.localhost:9779` })).toEqual({ notesScheme: "http", notesBaseDomain: "localhost:9779" });
        expect(notebookIdFromOrigin(`http://nb-${NB}.localhost:9779`, { notesScheme: "http", notesBaseDomain: "localhost:9779" })).toBe(NB);
        expect(toHostPath(`https://taskforce.example.com/p/${P}?task=${T}`, cfg.appOrigins)).toBe(`/p/${P}?task=${T}`);
        expect(toHostPath("https://example.com/x", cfg.appOrigins)).toBe("https://example.com/x");
        expect(toAbsoluteHref(`/p/${P}`, cfg.appOrigins)).toBe(`https://taskforce.example.com/p/${P}`);
    });
});

describe("reminder quick choices", () => {
    const tz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = "Europe/Brussels";
    });
    afterAll(() => {
        process.env.TZ = tz;
    });

    it("computes the choices from a fixed clock", () => {
        // Wednesday 25 November 2026, 14:20:30 in Brussels (UTC+1).
        const now = new Date("2026-11-25T13:20:30Z");
        const choices = quickChoices(now).map((c) => [ c.key, c.at.toISOString() ]);
        expect(choices).toEqual([
            [ "in_1_hour", "2026-11-25T14:20:00.000Z" ],
            [ "this_evening", "2026-11-25T17:00:00.000Z" ],
            [ "tomorrow_morning", "2026-11-26T08:00:00.000Z" ],
            [ "next_monday", "2026-11-30T08:00:00.000Z" ]
        ]);
    });

    it("drops this evening when it is near or past, and a Monday looks a week ahead", () => {
        const lateMonday = new Date("2026-11-30T17:45:00Z");
        expect(quickChoices(lateMonday).map((c) => c.key)).toEqual([ "in_1_hour", "tomorrow_morning", "next_monday" ]);
        expect(nextMonday(lateMonday).toISOString()).toBe("2026-12-07T08:00:00.000Z");
    });

    it("keeps local wall-clock times across the daylight saving change", () => {
        // Saturday 28 March 2026, 12:00 (UTC+1); Sunday is the first day on UTC+2.
        const now = new Date("2026-03-28T11:00:00Z");
        expect(tomorrowMorning(now).toISOString()).toBe("2026-03-29T07:00:00.000Z");
        expect(nextMonday(now).toISOString()).toBe("2026-03-30T07:00:00.000Z");
    });

    it("round-trips the picker values and groups due times", () => {
        const at = fromLocalParts("2026-11-27", "08:05");
        expect(at?.toISOString()).toBe("2026-11-27T07:05:00.000Z");
        expect(toLocalParts(at ?? new Date(0))).toEqual({ date: "2026-11-27", time: "08:05" });
        expect(fromLocalParts("2026-11-27", "8:5")).toBeNull();

        const now = new Date("2026-11-25T13:20:00Z");
        expect(reminderGroup(new Date("2026-11-25T13:00:00Z"), now)).toBe("overdue");
        expect(reminderGroup(new Date("2026-11-25T22:59:00Z"), now)).toBe("today");
        expect(reminderGroup(new Date("2026-11-25T23:00:00Z"), now)).toBe("later");
    });
});

describe("a task's to-do items", () => {
    const chip = (id: string) => `<a class="tf-chip" href="https://taskforce.example.com/p/${P}?task=${id}" data-tf-kind="task" data-tf-id="${id}">T</a>`;
    const item = (inner: string, checked = false, attrs = "") =>
        `<li${attrs}><label class="todo-list__label"><input type="checkbox"${checked ? " checked=\"checked\"" : ""}><span class="todo-list__label__description">${inner}</span></label></li>`;
    const html = `<ul class="todo-list">${item(`Print ${chip(T)}`, false, ` data-trilium-block-id="b1"`)}`
        + `${item(`Other ${chip(D)}`)}`
        + `<li><label class="todo-list__label"><input type="checkbox"><span class="todo-list__label__description">Parent</span></label>`
        + `<ul class="todo-list">${item(`Nested ${chip(T)}`, true)}</ul></li></ul>`;

    it("finds the items of the task not yet in its state, counted like the engine", () => {
        expect(todoTargetsForTask(html, T, true)).toEqual([ { blockId: "b1", index: 0 } ]);
        expect(todoTargetsForTask(html, T, false)).toEqual([ { blockId: null, index: 3 } ]);
        expect(todoTargetsForTask(html, "unknown", true)).toEqual([]);
        expect(todoTargetsForTask("<p>no list</p>", T, true)).toEqual([]);
    });

    it("finds the item of a tapped checkbox in an included note", () => {
        expect(todoItemAt(html, 0)).toEqual({ blockId: "b1", index: 0, checked: false });
        expect(todoItemAt(html, 3)).toEqual({ blockId: null, index: 3, checked: true });
        expect(todoItemAt(html, 9)).toBeNull();
    });

    it("lets exactly one frame tick: the turn holder, else the first person on the note", () => {
        expect(isTicker({ selfId: "b", mine: true, holderId: null, presentIds: [ "a" ] })).toBe(true);
        expect(isTicker({ selfId: "a", mine: false, holderId: "b", presentIds: [ "b" ] })).toBe(false);
        expect(isTicker({ selfId: "a", mine: false, holderId: null, presentIds: [ "c", "b" ] })).toBe(true);
        expect(isTicker({ selfId: "b", mine: false, holderId: null, presentIds: [ "c", "a" ] })).toBe(false);
        expect(isTicker({ selfId: "b", mine: false, holderId: null, presentIds: [] })).toBe(true);
    });

    it("reads the to-do items again only after a change that can touch them", () => {
        expect(touchesTodoStructure([ { type: "insert", name: "$text" }, { type: "attribute", attributeKey: "bold" } ])).toBe(false);
        expect(touchesTodoStructure([ { type: "insert", name: "paragraph" } ])).toBe(true);
        expect(touchesTodoStructure([ { type: "remove", name: "tfChip" } ])).toBe(true);
        expect(touchesTodoStructure([ { type: "attribute", attributeKey: "todoListChecked" } ])).toBe(true);
        expect(touchesTodoStructure([])).toBe(false);
    });
});

describe("chips", () => {
    const parse = (href: string) => parseTaskforceLink(href, cfg);
    const taskHref = `https://taskforce.example.com/p/${P}?task=${T}`;

    it("takes a chip only for a Taskforce link of its own kind and id", () => {
        expect(isGenuineChip(taskHref, "task", T, parse)).toBe(true);
        expect(isGenuineChip(taskHref, "task", T.toUpperCase(), parse)).toBe(true);
        expect(isGenuineChip(taskHref, "task", D, parse)).toBe(false);
        expect(isGenuineChip(taskHref, "project", P, parse)).toBe(false);
        expect(isGenuineChip(`https://evil.example/p/${P}?task=${T}`, "task", T, parse)).toBe(false);
        expect(isGenuineChip("javascript:alert(1)", "task", T, parse)).toBe(false);
    });

    it("opens what Taskforce answered, else the checked link, never a raw href", () => {
        const host = (href: string) => toHostPath(href, cfg.appOrigins);
        expect(chipOpenTarget({ href: taskHref, kind: "task", id: T }, { href: `/p/${P}?task=${T}` }, parse, host)).toBe(`/p/${P}?task=${T}`);
        expect(chipOpenTarget({ href: taskHref, kind: "task", id: T }, null, parse, host)).toBe(`/p/${P}?task=${T}`);
        expect(chipOpenTarget({ href: taskHref, kind: "task", id: T }, { href: "javascript:alert(1)" }, parse, host)).toBe(`/p/${P}?task=${T}`);
        expect(chipOpenTarget({ href: "javascript:alert(1)", kind: "task", id: T }, null, parse, host)).toBeNull();
        expect(chipOpenTarget({ href: "https://evil.example/x", kind: "task", id: T }, null, parse, host)).toBeNull();
        expect(chipOpenTarget({ href: taskHref, kind: "task", id: D }, null, parse, host)).toBeNull();
    });

    it("names a chip without a title by its host at most", () => {
        expect(chipPlaceholder(taskHref)).toBe("taskforce.example.com");
        expect(chipPlaceholder("not a link")).toBe("");
    });
});

describe("request ids", () => {
    it("makes version 4 UUIDs", () => {
        expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(newRequestId((bytes) => bytes.fill(255))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
        expect(newRequestId()).not.toBe(newRequestId());
    });
});
