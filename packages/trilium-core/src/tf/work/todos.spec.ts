import { describe, expect, it } from "vitest";

import becca from "../../becca/becca.js";
import type BNote from "../../becca/entities/bnote.js";
import { getContext } from "../../services/context.js";
import noteService from "../../services/notes.js";
import { collectTfDocxSource, resolveTfDocxImage, safeDocxFileName } from "./docx_source.js";
import { applyTodoState, clearTfTodoCache, listTfTodos, parseTodos, toggleTfTodo } from "./todos.js";

let counter = 0;

function createNote(parentNoteId: string, content: string, title = `todos-spec-${++counter}`): BNote {
    return getContext().init(() => noteService.createNewNote({ parentNoteId, title, content, type: "text" })).note;
}

const item = (text: string, opts: { checked?: boolean; state?: string; id?: string; nested?: string } = {}) =>
    `<li${opts.id ? ` data-trilium-block-id="${opts.id}"` : ""}${opts.state ? ` data-trilium-task-state="${opts.state}"` : ""}>`
    + `<label class="todo-list__label"><input type="checkbox" disabled="disabled"${opts.checked ? " checked=\"checked\"" : ""}>`
    + `<span class="todo-list__label__description">${text}</span></label>${opts.nested ?? ""}</li>`;
const list = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

describe("tf to-do roll-up", () => {
    it("parses nested lists, multi-state items, tables and entities", () => {
        const html = `<p>Intro</p>${list(
            item("Book &amp; pay", { id: "b1" }),
            item("Parent", { checked: true, nested: list(item("Child", { state: "doing" })) })
        )}<figure class="table"><table><tbody><tr><td>${list(item("In a cell"))}</td></tr></tbody></table></figure>`;

        const items = parseTodos(html);
        expect(items.map((i) => [ i.text, i.state, i.checked, i.blockId, i.index ])).toEqual([
            [ "Book & pay", "none", false, "b1", 0 ],
            [ "Parent", "done", true, null, 1 ],
            [ "Child", "doing", false, null, 2 ],
            [ "In a cell", "none", false, null, 3 ]
        ]);
        expect(parseTodos("<ul><li>plain</li></ul>")).toEqual([]);
        expect(parseTodos(list(item("x".repeat(400))))[0].text).toHaveLength(200);
    });

    it("reads the form the editor writes for an item with a block id and a task chip", () => {
        const html = `<ul class="todo-list"><li data-list-item-id="e42"><label class="todo-list__label todo-list__label_without-description"><input type="checkbox" checked="checked" disabled="disabled" /></label><p data-trilium-block-id="b1">Approve&nbsp;<a class="tf-chip" href="https://x/t" data-tf-kind="task" data-tf-id="t1">Approve <b>proofs</b></a> today</p></li></ul>`;
        const [ todo ] = parseTodos(html);
        expect(todo).toMatchObject({ blockId: "b1", text: "Approve today", checked: true, state: "done" });

        const unticked = applyTodoState(html, todo, "none", false);
        expect(unticked).toBe(html.replace(" checked=\"checked\"", ""));
    });

    it("rewrites only the checkbox and the state attribute", () => {
        const html = list(item("A", { id: "a" }), item("B", { state: "doing" }));
        const [ a, b ] = parseTodos(html);

        const ticked = applyTodoState(html, a, "done", true);
        expect(ticked).toBe(html.replace(`disabled="disabled">`, `disabled="disabled" checked="checked">`));
        expect(parseTodos(ticked)[0].checked).toBe(true);

        const doneB = applyTodoState(html, b, "done", true);
        expect(doneB).not.toContain("data-trilium-task-state");
        expect(parseTodos(doneB)[1]).toMatchObject({ state: "done", checked: true });

        const cancelled = applyTodoState(html, a, "cancelled", false);
        expect(parseTodos(cancelled)[0]).toMatchObject({ state: "cancelled", checked: false });
    });

    it("lists open items of a subtree in tree order and skips protected, archived and included content", () => {
        const top = createNote("root", "<p>top</p>");
        const first = createNote(top.noteId, list(item("First open"), item("First done", { checked: true })), "A first");
        const second = createNote(top.noteId, list(item("Second open", { state: "doing" })), "B second");
        const included = createNote(top.noteId, `<p>host</p><section class="include-note" data-note-id="${first.noteId}"></section>`, "C host");
        const archived = createNote(top.noteId, list(item("Archived item")), "D archived");
        getContext().init(() => archived.addLabel("archived"));
        const locked = createNote(top.noteId, list(item("Secret item")), "E locked");
        locked.isProtected = true;

        try {
            const open = listTfTodos({ scope: "subtree", noteId: top.noteId });
            expect(open.items.map((i) => i.text)).toEqual([ "First open", "Second open" ]);
            expect(open.items[1]).toMatchObject({ state: "doing", stateTitle: "Doing", completed: false, noteTitle: "B second" });
            expect(open.items[0].notePath.at(-1)).toBe(top.title);
            expect(open.total).toBe(2);
            expect(open.notes.map((n) => n.noteId)).toEqual([ first.noteId, second.noteId ]);
            expect(open.items.some((i) => i.noteId === included.noteId)).toBe(false);

            const all = listTfTodos({ scope: "subtree", noteId: top.noteId, state: "all", limit: 2 });
            expect(all.items.map((i) => i.text)).toEqual([ "First open", "First done" ]);
            expect(all.total).toBe(3);
            expect(all.next).toBe("2");
            expect(listTfTodos({ scope: "subtree", noteId: top.noteId, state: "all", cursor: "2" }).items.map((i) => i.text)).toEqual([ "Second open" ]);
        } finally {
            locked.isProtected = false;
        }
    });

    it("toggles one item through the note-save path and answers 409 on a stale base", () => {
        const note = createNote("root", list(item("Call the printer", { id: "p1" }), item("Second")));
        const base = note.blobId ?? "";

        const result = getContext().init(() => toggleTfTodo({ noteId: note.noteId, blockId: "p1", checked: true, baseBlobId: base }));
        expect(Array.isArray(result)).toBe(false);
        if (Array.isArray(result)) {
            return;
        }
        expect(result.item).toMatchObject({ text: "Call the printer", checked: true, completed: true });
        expect(result.blobId).not.toBe(base);
        expect(becca.getNoteOrThrow(note.noteId).getContent()).toContain(`checked="checked"`);

        const stale = getContext().init(() => toggleTfTodo({ noteId: note.noteId, index: 1, checked: true, baseBlobId: base }));
        expect(stale).toEqual([ 409, { conflict: true, blobId: result.blobId } ]);

        const byIndex = getContext().init(() => toggleTfTodo({ noteId: note.noteId, index: 1, state: "doing", baseBlobId: result.blobId }));
        expect(Array.isArray(byIndex) ? null : byIndex.item).toMatchObject({ text: "Second", state: "doing", checked: false });

        expect(() => getContext().init(() => toggleTfTodo({ noteId: note.noteId, index: 9, checked: true, baseBlobId: becca.getNoteOrThrow(note.noteId).blobId })))
            .toThrow(/no longer in the note/);
    });

    it("lists the open items of 2,000 notes well within a second once parsed, and cold within a few", () => {
        const top = createNote("root", "<p>Timing</p>", "todos-timing");
        const paragraph = "<p>Notes from the meeting with the printer about paper, covers and the delivery date.</p>";
        for (let i = 0; i < 2000; i++) {
            createNote(top.noteId, `<h2>Note ${i}</h2>${paragraph.repeat(4)}${list(item(`Open ${i} a`), item(`Open ${i} b`), item(`Done ${i}`, { checked: true }))}${paragraph}`);
        }

        clearTfTodoCache();
        let started = performance.now();
        const cold = listTfTodos({ scope: "subtree", noteId: top.noteId });
        const coldMs = performance.now() - started;
        started = performance.now();
        const warm = listTfTodos({ scope: "subtree", noteId: top.noteId });
        const warmMs = performance.now() - started;
        console.info(`tf todos roll-up, 2,000 notes / 4,000 open items: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`);

        expect(cold.total).toBe(4000);
        expect(cold.items).toHaveLength(500);
        expect(warm.next).toBe("500");
        expect(warmMs).toBeLessThan(1000);
        expect(coldMs).toBeLessThan(10_000);
    }, 120_000);

    it("collects the Word export source with children and included notes", () => {
        const top = createNote("root", "<p>Top text</p>", "Plan: Q1 / Q2?");
        const child = createNote(top.noteId, "<h2>Child heading</h2>", "Child");
        createNote(child.noteId, "<p>Grandchild</p>", "Grandchild");
        const host = createNote(top.noteId, `<section class="include-note" data-note-id="${child.noteId}"></section>`, "Host");

        const single = collectTfDocxSource(top.noteId, false);
        expect(single.notes.map((n) => n.title)).toEqual([ "Plan: Q1 / Q2?" ]);

        const tree = collectTfDocxSource(top.noteId, true);
        expect(tree.notes.map((n) => [ n.title, n.level ])).toEqual([ [ "Plan: Q1 / Q2?", 0 ], [ "Child", 1 ], [ "Grandchild", 2 ], [ "Host", 1 ] ]);
        expect(tree.notes.find((n) => n.noteId === host.noteId)?.html).toContain("Child heading");

        expect(safeDocxFileName("Plan: Q1 / Q2?")).toBe("Plan Q1 Q2.docx");
        expect(safeDocxFileName("///")).toBe("note.docx");
        expect(resolveTfDocxImage("https://example.com/a.png")).toBeNull();
    });
});
