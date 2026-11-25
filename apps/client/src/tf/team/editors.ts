/**
 * Reaches the editor of a note split from the outside: the CKEditor instance of a text note and the
 * CodeMirror view of a code or Markdown note, to make them read-only while someone else has the
 * turn, to snapshot and restore their text, and to find the blocks comments hang on.
 */
import type { CKTextEditor } from "@triliumnext/ckeditor5";
import type { Editor, ModelElement } from "ckeditor5";
import type VanillaCodeMirror from "@triliumnext/codemirror";

import appContext from "../../components/app_context.js";
import type FNote from "../../entities/fnote.js";

export const TURN_LOCK_ID = "tf-turns";

export type LockableKind = "text" | "code";

/** Whether a note takes turns (text, code and Markdown), and through which editor. */
export function lockableKind(note: FNote | null | undefined): LockableKind | null {
    if (!note) {
        return null;
    }
    if (note.type === "text") {
        return "text";
    }
    if (note.type === "code" || note.isMarkdown?.()) {
        return "code";
    }
    return null;
}

export function findSplit(ntxId: string | null | undefined): HTMLElement | null {
    if (!ntxId) {
        return null;
    }
    return document.querySelector<HTMLElement>(`.note-split[data-ntx-id="${CSS.escape(ntxId)}"]`);
}

export function activeSplit() {
    return findSplit(appContext.tabManager?.getActiveContext()?.ntxId);
}

/** The editable text editor shown in `split`, if any. */
export function textEditorIn(split: Element | null): CKTextEditor | null {
    const editable = split?.querySelector<HTMLElement & { ckeditorInstance?: CKTextEditor }>(
        ".note-detail-editable-text-editor.ck-editor__editable, .note-detail-editable-text-editor .ck-editor__editable"
    );
    return editable?.ckeditorInstance ?? null;
}

/** The content root of a text note in `split`, editable or read-only. */
export function textContentIn(split: Element | null): HTMLElement | null {
    if (!split) {
        return null;
    }
    const candidates = split.querySelectorAll<HTMLElement>(".note-detail-editable-text-editor, .note-detail-readonly-text-content");
    for (const element of candidates) {
        if (element.offsetParent !== null) {
            return element;
        }
    }
    return candidates[0] ?? null;
}

let codeMirrorClass: typeof VanillaCodeMirror | null = null;
let codeMirrorModule: Promise<typeof VanillaCodeMirror> | null = null;

/** Loads the CodeMirror class once, so {@link codeViewInSync} can find views without waiting. */
export function loadCodeMirror() {
    codeMirrorModule ??= import("@triliumnext/codemirror").then((module) => {
        codeMirrorClass = module.default;
        return module.default;
    });
    return codeMirrorModule;
}

/** The CodeMirror view of a code or Markdown note in `split`, if any. */
export async function codeViewIn(split: Element | null): Promise<VanillaCodeMirror | null> {
    await loadCodeMirror();
    return codeViewInSync(split);
}

/** {@link codeViewIn} once {@link loadCodeMirror} has resolved; `null` before. */
export function codeViewInSync(split: Element | null): VanillaCodeMirror | null {
    const element = split?.querySelector<HTMLElement>(".cm-editor");
    if (!element || !codeMirrorClass) {
        return null;
    }
    const view = codeMirrorClass.findFromDOM(element);
    return view && typeof (view as VanillaCodeMirror).setReadOnly === "function" ? view as VanillaCodeMirror : null;
}

/** The block element of a text note's content with `blockId`. */
export function blockElement(root: Element | null, blockId: string): HTMLElement | null {
    return root?.querySelector<HTMLElement>(`[data-trilium-block-id="${CSS.escape(blockId)}"]`) ?? null;
}

/** The block holding `element` (or `element` itself) that can carry a block id. */
export function findBlock(editor: Editor, element: ModelElement | null): ModelElement | null {
    const schema = editor.model.schema;
    let current: ModelElement | null = element;
    while (current && current.is("element")) {
        if (schema.isBlock(current) && schema.checkAttribute(current, "blockId")) {
            return current;
        }
        current = current.parent as ModelElement | null;
    }
    return null;
}
