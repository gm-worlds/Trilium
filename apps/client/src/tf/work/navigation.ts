/**
 * Opening a note at one of its blocks or to-do items, from the reminders and to-do lists.
 */
import { assignBlockId } from "@triliumnext/ckeditor5";

import appContext from "../../components/app_context.js";

const FIND_ITEM_TIMEOUT_MS = 4000;
const HIGHLIGHT_MS = 1600;

/**
 * Opens `noteId` in the active tab. With a `blockId`, Trilium scrolls to that block; with only an
 * `index`, the `index`-th to-do item is scrolled to once the editor shows it, and gets a block id
 * then (so the next jump to it, from anywhere, has one).
 */
export async function openNoteAt(noteId: string, blockId?: string | null, todoIndex?: number) {
    const viewScope = blockId ? { block: blockId } : {};
    const context = appContext.tabManager.getActiveContext();
    if (context) {
        await context.setNote(noteId, { viewScope });
    } else {
        await appContext.tabManager.openTabWithNoteWithHoisting(noteId, { activate: true, viewScope });
    }
    if (blockId || todoIndex === undefined) {
        return;
    }
    const active = appContext.tabManager.getActiveContext();
    if (!active) {
        return;
    }
    const item = await waitForTodoItem(active.ntxId ?? "", todoIndex);
    if (!item) {
        return;
    }
    item.scrollIntoView({ block: "center", behavior: "smooth" });
    item.classList.add("tf-todo-highlight");
    setTimeout(() => item.classList.remove("tf-todo-highlight"), HIGHLIGHT_MS);

    const editor = await active.getTextEditor().catch(() => null);
    if (editor && !editor.isReadOnly) {
        const paragraph = item.querySelector<HTMLElement>(":scope > .todo-list__label .todo-list__label__description, :scope > .todo-list__label__description, :scope > p") ?? item;
        const viewElement = editor.editing.view.domConverter.mapDomToView(paragraph);
        const block = viewElement?.is("element") ? editor.editing.mapper.toModelElement(viewElement) : null;
        if (block) {
            assignBlockId(editor.model, block);
        }
    }
}

async function waitForTodoItem(ntxId: string, index: number): Promise<HTMLElement | null> {
    const until = Date.now() + FIND_ITEM_TIMEOUT_MS;
    while (Date.now() < until) {
        for (const scope of document.querySelectorAll(`[data-ntx-id="${CSS.escape(ntxId)}"]`)) {
            const item = scope.querySelectorAll<HTMLElement>(".ck-content ul.todo-list > li")[index];
            if (item) {
                return item;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return null;
}
