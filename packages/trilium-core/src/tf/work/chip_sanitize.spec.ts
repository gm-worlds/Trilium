import { describe, expect, it } from "vitest";

import { sanitizeHtml } from "../../services/sanitizer.js";

/**
 * The exact HTML the `TfWork` editor plugin writes for a chip (`packages/ckeditor5/src/tf/work/tf_work.spec.ts`
 * asserts `editor.getData()` against the same string), so a saved chip survives the server's sanitizer.
 */
const CHIP = `<a class="tf-chip" href="https://tf.example/p/p1?task=t1" data-tf-kind="task" data-tf-id="t1">Approve proofs</a>`;

describe("TfWork chips through the note sanitizer", () => {
    it("keeps a chip, in a paragraph and at the end of a to-do item with a block id", () => {
        const paragraph = `<p>See&nbsp;${CHIP}</p>`;
        const item = `<ul class="todo-list"><li data-trilium-block-id="b1"><label class="todo-list__label"><input type="checkbox" checked="checked" disabled="disabled" /><span class="todo-list__label__description">Approve&nbsp;${CHIP}</span></label></li></ul>`;

        // sanitize-html writes `&nbsp;` back as the U+00A0 character it stands for.
        const decoded = (html: string) => html.replaceAll("&nbsp;", "\u00a0");
        expect(sanitizeHtml(paragraph)).toBe(decoded(paragraph));
        expect(sanitizeHtml(item)).toBe(decoded(item));
    });

    it("drops a script address from a forged chip and keeps its text", () => {
        const forged = `<p><a class="tf-chip" href="javascript:alert(1)" data-tf-kind="task" data-tf-id="t1">Click</a></p>`;

        expect(sanitizeHtml(forged)).toBe(`<p><a class="tf-chip" data-tf-kind="task" data-tf-id="t1">Click</a></p>`);
    });
});
