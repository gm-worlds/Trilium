import { _getModelData as getModelData, _setModelData as setModelData, ButtonView, type ClassicEditor, type Editor, Essentials, Link, List, Paragraph, TodoList } from "ckeditor5";
import { describe, expect, it, vi } from "vitest";

import { createTestEditor } from "../../../test/editor-kit.js";
import BlockReferenceEditing from "../../plugins/block_reference/block_reference_editing.js";
import TodoListMultistateEditing from "../../plugins/todo_list_multistate/todo_list_multistate_editing.js";
import TfWork, { type TfChipActions, type TfChipData, type TfWorkHost } from "./tf_work.js";

const TASK_HREF = "https://tf.example/p/p1?task=t1";
const CHIP_HTML = `<a class="tf-chip" href="${TASK_HREF}" data-tf-kind="task" data-tf-id="t1">Approve proofs</a>`;
const todo = (inner: string, attrs = "") =>
    `<ul class="todo-list"><li${attrs}><label class="todo-list__label"><input type="checkbox" disabled="disabled"><span class="todo-list__label__description">${inner}</span></label></li></ul>`;

/** Like the client's parser: `/p/<project>[/d/<document>][?task=<task>]` on the app origin. */
function parseTestLink(text: string): { kind: "task" | "project" | "document"; id: string; href: string } | null {
    const match = /^https:\/\/tf\.example\/p\/(\w+)(?:\/d\/(\w+))?(?:\?task=(\w+))?$/.exec(text);
    if (match) {
        if (match[3]) {
            return { kind: "task", id: match[3], href: text };
        }
        return match[2] ? { kind: "document", id: match[2], href: text } : { kind: "project", id: match[1], href: text };
    }
    return text.startsWith("https://tf.example/") ? { kind: "task", id: "t9", href: text } : null;
}

function makeHost(overrides: Partial<TfWorkHost> = {}) {
    const drawn: { dom: HTMLElement; data: TfChipData; actions: TfChipActions }[] = [];
    const host = {
        parseLink: vi.fn(parseTestLink),
        renderChip: vi.fn((dom: HTMLElement, data: TfChipData, actions: TfChipActions) => {
            dom.textContent = `chip:${data.id}`;
            drawn.push({ dom, data, actions });
        }),
        chipTitle: vi.fn((data: TfChipData) => data.storedTitle),
        chipAdded: vi.fn(),
        linkedTodoChanged: vi.fn(),
        makeTask: vi.fn(),
        remind: vi.fn(),
        label: (key: "makeTask" | "remindMe") => (key === "makeTask" ? "Make task" : "Remind me"),
        ...overrides
    } satisfies TfWorkHost;
    return { host, drawn };
}

async function editorWith(host: TfWorkHost | undefined) {
    const editor = await createTestEditor(
        [ Essentials, Paragraph, Link, List, TodoList, TodoListMultistateEditing, BlockReferenceEditing, TfWork ],
        host ? { tfWork: host } : {}
    );
    return { editor, plugin: editor.plugins.get(TfWork) };
}

function paste(editor: ClassicEditor, text: string, html = "", method = "paste") {
    const types: Record<string, string> = { "text/plain": text, "text/html": html };
    editor.editing.view.document.fire("clipboardInput", {
        dataTransfer: { getData: (type: string) => types[type] ?? "" },
        content: editor.data.htmlProcessor.toView(html || text),
        method
    });
}

const model = (editor: Editor) => getModelData(editor.model, { withoutSelection: true });

describe("TfWork", () => {
    it("is inert without the tfWork config: chip HTML stays an ordinary link", async () => {
        const { editor } = await editorWith(undefined);
        editor.setData(`<p>${CHIP_HTML}</p>`);

        expect(editor.model.schema.isRegistered("tfChip")).toBe(false);
        expect(editor.ui.componentFactory.has("tfMakeTask")).toBe(false);
        expect(model(editor)).toBe(`<paragraph><$text linkHref="${TASK_HREF}">Approve proofs</$text></paragraph>`);
    });

    it("keeps a chip through setData and getData, drawing it through the host while editing", async () => {
        const { host, drawn } = makeHost();
        const { editor, plugin } = await editorWith(host);
        editor.setData(`<p>See&nbsp;${CHIP_HTML}</p>`);

        expect(model(editor)).toBe(`<paragraph>See\u00a0<tfChip tfChipHref="${TASK_HREF}" tfChipId="t1" tfChipKind="task" tfChipTitle="Approve proofs"></tfChip></paragraph>`);
        expect(editor.getData()).toBe(`<p>See&nbsp;${CHIP_HTML}</p>`);
        editor.setData(editor.getData());
        expect(editor.getData()).toBe(`<p>See&nbsp;${CHIP_HTML}</p>`);
        expect(drawn[0]?.data).toEqual({ href: TASK_HREF, kind: "task", id: "t1", storedTitle: "Approve proofs" });
        const view = editor.editing.view.getDomRoot()?.querySelector(".tf-chip");
        expect(view?.getAttribute("data-tf-href")).toBe(TASK_HREF);
        expect(view?.classList.contains("tf-chip--task")).toBe(true);
        expect(plugin.getChips().map((chip) => chip.data.id)).toEqual([ "t1" ]);
    });

    it("writes the host's latest title, else the stored one, else the href", async () => {
        const { host } = makeHost({ chipTitle: vi.fn(() => "Renamed") });
        const { editor } = await editorWith(host);
        editor.setData(`<p>${CHIP_HTML}</p>`);
        expect(editor.getData()).toContain(">Renamed</a>");

        host.chipTitle.mockReturnValue("");
        expect(editor.getData()).toContain(">Approve proofs</a>");

        editor.setData(`<p><a class="tf-chip" href="${TASK_HREF}" data-tf-kind="task" data-tf-id="t1"></a></p>`);
        expect(editor.getData()).toContain(`>${TASK_HREF}</a>`);
    });

    it("reads a nested title and leaves links with an unknown kind or no id as links", async () => {
        const { editor } = await editorWith(makeHost().host);
        editor.setData(`<p><a class="tf-chip" href="https://tf.example/p/p1" data-tf-kind="project" data-tf-id="p1"><b>Big</b>  launch</a></p>`);
        expect(model(editor)).toContain(`tfChipKind="project" tfChipTitle="Big launch"`);

        editor.setData(`<p><a class="tf-chip" href="${TASK_HREF}" data-tf-kind="robot" data-tf-id="x">Odd</a><a class="tf-chip" href="${TASK_HREF}" data-tf-kind="task">No id</a></p>`);
        expect(model(editor)).not.toContain("tfChip");
        expect(model(editor)).toContain(`linkHref="${TASK_HREF}"`);
    });

    it("takes a chip only for a Taskforce link of its own kind and id; others become safe links or text", async () => {
        const { editor } = await editorWith(makeHost().host);
        editor.setData(`<p><a class="tf-chip" href="javascript:alert(1)" data-tf-kind="task" data-tf-id="t1">Boss</a></p>`);
        expect(model(editor)).toBe("<paragraph>Boss</paragraph>");

        for (const href of [ "https://evil.example/p/p1?task=t1", "https://tf.example/p/p1?task=t2" ]) {
            editor.setData(`<p><a class="tf-chip" href="${href}" data-tf-kind="task" data-tf-id="t1">Approve</a></p>`);
            expect(model(editor)).toBe(`<paragraph><$text linkHref="${href}" tfSafeLink="true">Approve</$text></paragraph>`);
            expect(editor.getData()).toBe(`<p><a href="${href}" rel="noopener noreferrer">Approve</a></p>`);
        }

        editor.execute("selectAll");
        editor.execute("unlink");
        expect(model(editor)).toBe("<paragraph>Approve</paragraph>");
    });

    it("redraws all chips, or the ones a filter accepts", async () => {
        const { host } = makeHost();
        const { editor, plugin } = await editorWith(host);
        editor.setData(`<p>${CHIP_HTML} <a class="tf-chip" href="https://tf.example/p/p1/d/d1" data-tf-kind="document" data-tf-id="d1">Doc</a></p>`);
        host.renderChip.mockClear();

        plugin.redrawChips((data) => data.kind === "document");
        expect(new Set(host.renderChip.mock.calls.map(([ , data ]) => data.id))).toEqual(new Set([ "d1" ]));

        host.renderChip.mockClear();
        plugin.redrawChips();
        expect(new Set(host.renderChip.mock.calls.map(([ , data ]) => data.id))).toEqual(new Set([ "t1", "d1" ]));
    });

    describe("block context", () => {
        it("gives the caret's block an id and its text without chips", async () => {
            const { editor, plugin } = await editorWith(makeHost().host);
            setModelData(editor.model, `<paragraph>Call  the printer[]<tfChip tfChipHref="h" tfChipId="t1" tfChipKind="task" tfChipTitle="x"></tfChip></paragraph>`);

            const context = plugin.getBlockContext();
            expect(context).toMatchObject({ text: "Call the printer", isTodo: false, checked: false });
            expect(context?.blockId).toMatch(/\S/);
            expect(plugin.findBlockById(context?.blockId ?? "")?.name).toBe("paragraph");
            expect(plugin.getBlockContext()?.blockId).toBe(context?.blockId);
        });

        it("takes the selected text, and the block's text for an explicit block", async () => {
            const { editor, plugin } = await editorWith(makeHost().host);
            setModelData(editor.model, `<paragraph listIndent="0" listItemId="a" listType="todo" todoListChecked="true">Book [the] venue</paragraph>`);
            expect(plugin.getBlockContext()).toMatchObject({ text: "the", isTodo: true, checked: true });

            const block = editor.model.document.getRoot()?.getChild(0);
            expect(block?.is("element") && plugin.getBlockContext(block)?.text).toBe("Book the venue");
        });

        it("has no block on a block object and none for a missing id", async () => {
            const { editor, plugin } = await editorWith(makeHost().host);
            editor.model.schema.register("blockWidget", { inheritAllFrom: "$blockObject" });
            editor.conversion.elementToElement({ model: "blockWidget", view: "hr" });
            setModelData(editor.model, "[<blockWidget></blockWidget>]<paragraph>x</paragraph>");
            expect(plugin.getBlockContext()).toBeNull();
            expect(plugin.findBlockById("nope")).toBeNull();
            expect(plugin.appendChip("nope", { href: "h", kind: "task", id: "t", storedTitle: "" })).toBe(false);
        });

        it("reads a chip element without attributes as an empty task chip", async () => {
            const { editor, plugin } = await editorWith(makeHost().host);
            setModelData(editor.model, "<paragraph><tfChip></tfChip></paragraph>");
            expect(plugin.getChips()[0]?.data).toEqual({ href: "", kind: "task", id: "", storedTitle: "" });
        });

        it("maps a chip's inside to its block", async () => {
            const { editor, plugin } = await editorWith(makeHost().host);
            editor.setData(`<p>${CHIP_HTML}</p>`);
            const body = editor.editing.view.getDomRoot()?.querySelector(".tf-chip__body");
            expect(plugin.blockForDom(body ?? document.body)?.name).toBe("paragraph");
        });

        it("maps between DOM nodes and blocks", async () => {
            const { editor, plugin } = await editorWith(makeHost().host);
            editor.setData("<p>One</p><p>Two</p>");
            const second = editor.model.document.getRoot()?.getChild(1);
            if (!second?.is("element")) {
                throw new Error("no second paragraph");
            }
            const dom = plugin.domForBlock(second);
            expect(dom?.textContent).toBe("Two");
            expect(plugin.blockForDom(dom?.firstChild ?? document.body)).toBe(second);
            expect(plugin.blockForDom(document.body)).toBeNull();
            expect(plugin.domForBlock(editor.model.change((writer) => writer.createElement("paragraph")))).toBeNull();
        });
    });

    describe("to-do items and tasks", () => {
        it("lists to-do items with their id and task chips", async () => {
            const { editor, plugin } = await editorWith(makeHost().host);
            editor.setData(`<p>Not a to-do</p>${todo(`Approve ${CHIP_HTML} <a class="tf-chip" href="h" data-tf-kind="project" data-tf-id="p1">P</a>`, ` data-trilium-block-id="b1"`)}${todo("Plain")}`);

            expect(plugin.getTodoBlocks().map(({ blockId, taskIds }) => ({ blockId, taskIds }))).toEqual([
                { blockId: "b1", taskIds: [ "t1" ] },
                { blockId: null, taskIds: [] }
            ]);
        });

        it("appends a chip with a space only where one is missing and tells the host", async () => {
            const { host } = makeHost();
            const { editor, plugin } = await editorWith(host);
            setModelData(editor.model, `<paragraph blockId="a">Text</paragraph><paragraph blockId="b">Spaced </paragraph><paragraph blockId="c"></paragraph>`);
            const chip = { href: "h", kind: "task" as const, id: "t2", storedTitle: "New" };

            for (const id of [ "a", "b", "c" ]) {
                expect(plugin.appendChip(id, chip)).toBe(true);
            }
            expect(model(editor)).toBe(
                `<paragraph blockId="a">Text <tfChip tfChipHref="h" tfChipId="t2" tfChipKind="task" tfChipTitle="New"></tfChip></paragraph>`
                + `<paragraph blockId="b">Spaced <tfChip tfChipHref="h" tfChipId="t2" tfChipKind="task" tfChipTitle="New"></tfChip></paragraph>`
                + `<paragraph blockId="c"><tfChip tfChipHref="h" tfChipId="t2" tfChipKind="task" tfChipTitle="New"></tfChip></paragraph>`
            );
            expect(host.chipAdded).toHaveBeenCalledTimes(3);
        });

        it("ticks and unticks the items of a task without reporting that back", async () => {
            const { host } = makeHost();
            const { editor, plugin } = await editorWith(host);
            editor.setData(todo(`Approve ${CHIP_HTML}`) + `<p>${CHIP_HTML}</p>`);
            const item = () => editor.model.document.getRoot()?.getChild(0);

            expect(plugin.setTaskTodoState("t1", false)).toBe(false);
            expect(plugin.setTaskTodoState("t1", true)).toBe(true);
            expect(item()?.getAttribute("todoListChecked")).toBe(true);
            expect(plugin.setTaskTodoState("other", true)).toBe(false);

            editor.model.change((writer) => {
                const block = item();
                if (block?.is("element")) {
                    writer.setAttribute("taskState", "inProgress", block);
                }
            });
            host.linkedTodoChanged.mockClear();
            expect(plugin.setTaskTodoState("t1", false)).toBe(true);
            expect(item()?.hasAttribute("todoListChecked")).toBe(false);
            expect(item()?.hasAttribute("taskState")).toBe(false);
            expect(host.linkedTodoChanged).not.toHaveBeenCalled();

            editor.enableReadOnlyMode("spec");
            expect(plugin.setTaskTodoState("t1", true)).toBe(false);
        });

        it("reports a person ticking a to-do item that carries a task chip", async () => {
            const { host } = makeHost();
            const { editor } = await editorWith(host);
            editor.setData(todo(`Approve ${CHIP_HTML} <a class="tf-chip" href="h" data-tf-kind="project" data-tf-id="p1">P</a>`) + todo("Plain") + "<p>Para</p>");
            const root = editor.model.document.getRoot();
            const set = (index: number, key: string, value: unknown) => editor.model.change((writer) => {
                const block = root?.getChild(index);
                if (block?.is("element")) {
                    writer.setAttribute(key, value, block);
                }
            });

            set(0, "todoListChecked", true);
            expect(host.linkedTodoChanged).toHaveBeenLastCalledWith("t1", true);
            set(0, "todoListChecked", false);
            expect(host.linkedTodoChanged).toHaveBeenLastCalledWith("t1", false);
            expect(host.linkedTodoChanged).toHaveBeenCalledTimes(2);

            set(1, "todoListChecked", true);
            set(2, "todoListChecked", true);
            set(2, "blockId", "x");
            editor.model.change((writer) => writer.insertText("!", root?.getChild(2) as never, "end"));
            expect(host.linkedTodoChanged).toHaveBeenCalledTimes(2);
        });

        it("does not watch ticks when the host does not ask", async () => {
            const { host } = makeHost({ linkedTodoChanged: undefined });
            const { editor } = await editorWith(host);
            editor.setData(todo(`Approve ${CHIP_HTML}`));
            expect(() => editor.model.change((writer) => {
                const block = editor.model.document.getRoot()?.getChild(0);
                if (block?.is("element")) {
                    writer.setAttribute("todoListChecked", true, block);
                }
            })).not.toThrow();
        });
    });

    describe("paste", () => {
        it("turns a Taskforce link into a chip as a second undo step", async () => {
            const { host } = makeHost();
            const { editor } = await editorWith(host);
            setModelData(editor.model, "<paragraph>See []</paragraph>");

            paste(editor, "https://tf.example/p/p1?task=t9", `<meta charset="utf-8"><a href="https://tf.example/p/p1?task=t9">x</a>`);
            expect(model(editor)).toBe(`<paragraph>See <tfChip tfChipHref="https://tf.example/p/p1?task=t9" tfChipId="t9" tfChipKind="task" tfChipTitle=""></tfChip></paragraph>`);
            expect(host.chipAdded).toHaveBeenCalledWith({ href: "https://tf.example/p/p1?task=t9", kind: "task", id: "t9", storedTitle: "" });

            editor.execute("undo");
            expect(model(editor)).toBe(`<paragraph>See <$text linkHref="https://tf.example/p/p1?task=t9">https://tf.example/p/p1?task=t9</$text></paragraph>`);
        });

        it("takes clipboard HTML that is the bare address or one link to it", async () => {
            const { editor } = await editorWith(makeHost().host);
            for (const html of [ "<!-- x --><meta charset='utf-8'>", "<span>https://tf.example/a</span>", "<html><body><a href=\"https://tf.example/a?x=1&amp;y=2\">t</a></body></html>" ]) {
                setModelData(editor.model, "<paragraph>[]</paragraph>");
                const url = html.includes("x=1") ? "https://tf.example/a?x=1&y=2" : "https://tf.example/a";
                paste(editor, url, html);
                expect(model(editor)).toContain("<tfChip");
            }
        });

        it("leaves every other paste to the clipboard pipeline", async () => {
            const { host } = makeHost();
            const { editor } = await editorWith(host);
            const cases: [ string, string, string? ][] = [
                [ "", "" ],
                [ "https://tf.example/a and more", "" ],
                [ "https://tf.example/a", "<p>Rich <b>text</b> https://tf.example/a</p>" ],
                [ "https://tf.example/a", "<a href=\"https://tf.example/b\">b</a>" ],
                [ "https://elsewhere.example/a", "" ],
            ];
            for (const [ text, html ] of cases) {
                setModelData(editor.model, "<paragraph>[]</paragraph>");
                paste(editor, text, html);
                expect(model(editor)).not.toContain("<tfChip");
            }

            // Any input other than a paste; stopped right after TfWork so the clipboard pipeline stays out.
            editor.editing.view.document.on("clipboardInput", (evt) => evt.stop(), { priority: 999 });
            setModelData(editor.model, "<paragraph>[]</paragraph>");
            paste(editor, "https://tf.example/a", "", "dragInsert");
            expect(model(editor)).not.toContain("<tfChip");

            editor.editing.view.document.fire("clipboardInput", { method: "paste", content: editor.data.htmlProcessor.toView("") });
            editor.enableReadOnlyMode("spec");
            paste(editor, "https://tf.example/a");
            expect(model(editor)).not.toContain("<tfChip");
            expect(host.chipAdded).not.toHaveBeenCalled();
        });
    });

    describe("chip actions", () => {
        it("turns a chip back into a link with its title, the stored one, or the address", async () => {
            const { host, drawn } = makeHost({ chipTitle: vi.fn(() => "Live title") });
            const { editor } = await editorWith(host);
            editor.setData(`<p>${CHIP_HTML}</p>`);
            expect(drawn[0]?.actions.isEditable).toBe(true);

            drawn[0]?.actions.turnIntoLink();
            expect(model(editor)).toBe(`<paragraph><$text linkHref="${TASK_HREF}">Live title</$text></paragraph>`);
            drawn[0]?.actions.turnIntoLink();
            expect(model(editor)).toBe(`<paragraph><$text linkHref="${TASK_HREF}">Live title</$text></paragraph>`);

            host.chipTitle.mockReturnValue("");
            const second = "https://tf.example/p/p1?task=t2";
            editor.setData(`<p>${CHIP_HTML}<a class="tf-chip" href="${second}" data-tf-kind="task" data-tf-id="t2"></a></p>`);
            for (const chip of drawn.slice(-2)) {
                chip.actions.turnIntoLink();
            }
            expect(model(editor)).toBe(`<paragraph><$text linkHref="${TASK_HREF}">Approve proofs</$text><$text linkHref="${second}">${second}</$text></paragraph>`);
        });

        it("does nothing to a chip in a read-only note", async () => {
            const { drawn, host } = makeHost();
            const { editor } = await editorWith(host);
            editor.setData(`<p>${CHIP_HTML}</p>`);
            editor.enableReadOnlyMode("spec");
            const chip = drawn.at(-1);
            expect(chip?.actions.isEditable).toBe(false);
            chip?.actions.turnIntoLink();
            expect(model(editor)).toContain("<tfChip");
        });
    });

    describe("toolbar buttons and host lifecycle", () => {
        it("adds the buttons the host can run, labeled by the host", async () => {
            const { host } = makeHost();
            const { editor } = await editorWith(host);
            const make = editor.ui.componentFactory.create("tfMakeTask");
            const remind = editor.ui.componentFactory.create("tfRemindMe");
            expect(make).toBeInstanceOf(ButtonView);
            expect((make as ButtonView).label).toBe("Make task");
            expect((remind as ButtonView).label).toBe("Remind me");

            (make as ButtonView).fire("execute");
            (remind as ButtonView).fire("execute");
            expect(host.makeTask).toHaveBeenCalledWith(editor);
            expect(host.remind).toHaveBeenCalledWith(editor);
        });

        it("leaves out a button the host cannot run", async () => {
            const { editor } = await editorWith(makeHost({ makeTask: undefined }).host);
            expect(editor.ui.componentFactory.has("tfMakeTask")).toBe(false);
            expect(editor.ui.componentFactory.has("tfRemindMe")).toBe(true);
        });

        it("attaches the host after init and detaches it on destroy", async () => {
            const detach = vi.fn();
            const attach = vi.fn(() => detach);
            const { editor } = await editorWith(makeHost({ attach }).host);
            expect(attach).toHaveBeenCalledWith(editor);
            await editor.destroy();
            expect(detach).toHaveBeenCalledTimes(1);
        });

        it("accepts a host without attach or without a detach function", async () => {
            const withoutAttach = await editorWith(makeHost({ attach: undefined }).host);
            await withoutAttach.editor.destroy();
            const attach = vi.fn(() => undefined);
            await editorWith(makeHost({ attach }).host);
            expect(attach).toHaveBeenCalledTimes(1);
        });
    });
});
