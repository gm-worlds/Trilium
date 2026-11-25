import { describe, expect, it } from "vitest";

import { anchoredScrollTop, autoScrollSpeed, clampTextScale, distanceToBox, formatTextScale, movedBeyond, parseTextScale, pickedIndex, pinchedTextScale, pinchFactor, snappedToOne, steppedTextScale } from "./gestures.js";
import { toggleTodoInHtml } from "./included_todos.js";
import { labelOf } from "./press.js";
import { findDropTarget, moveOpFor, planUndo, type RowBox } from "./reorder.js";

describe("text scale", () => {
    it("follows the pinch, clamps to 80-220 % and holds at 100 %", () => {
        expect(pinchFactor(100, 150)).toBe(1.5);
        expect(pinchFactor(0, 150)).toBe(1);
        expect(pinchedTextScale(1, 1.5)).toBe(1.5);
        expect(pinchedTextScale(1.2, 0.86)).toBe(1);
        expect(pinchedTextScale(1, 1.05)).toBe(1);
        expect(pinchedTextScale(1, 1.07)).toBe(1.07);
        expect(pinchedTextScale(2, 3)).toBe(2.2);
        expect(pinchedTextScale(1, 0.2)).toBe(0.8);
        expect(clampTextScale(Number.NaN)).toBe(1);
    });

    it("steps on a 10 % grid from any value", () => {
        expect(steppedTextScale(1, 1)).toBe(1.1);
        expect(steppedTextScale(1.07, 1)).toBe(1.1);
        expect(steppedTextScale(1.07, -1)).toBe(1);
        expect(steppedTextScale(0.8, -1)).toBe(0.8);
        expect(steppedTextScale(2.2, 1)).toBe(2.2);
        expect(steppedTextScale(1.2, -1)).toBeCloseTo(1.1);
    });

    it("reports the snap to 100 % once, parses stored values and formats them", () => {
        expect(snappedToOne(1.1, 1)).toBe(true);
        expect(snappedToOne(1, 1)).toBe(false);
        expect(parseTextScale("1.3")).toBe(1.3);
        expect(parseTextScale("garbage")).toBe(1);
        expect(parseTextScale(undefined)).toBe(1);
        expect(parseTextScale("9")).toBe(2.2);
        expect(formatTextScale(1.25, "en")).toBe("125%");
        expect(formatTextScale(1.25, "nl")).toBe("125%");
        // French separates the sign with a no-break space, so it never wraps.
        expect(formatTextScale(1, "fr")).toMatch(/^100[\u00a0\u202f]%$/);
    });

    it("keeps the pinched point in place", () => {
        expect(anchoredScrollTop(100, 200, 2)).toBe(400);
        expect(anchoredScrollTop(0, 0, 0.5)).toBe(0);
    });
});

describe("drag helpers", () => {
    it("scrolls faster deeper into an edge band and not in the middle", () => {
        expect(autoScrollSpeed(400, 0, 800)).toBe(0);
        expect(autoScrollSpeed(2, 0, 800)).toBeLessThan(autoScrollSpeed(40, 0, 800));
        expect(autoScrollSpeed(2, 0, 800)).toBeLessThan(0);
        expect(autoScrollSpeed(798, 0, 800)).toBeGreaterThan(autoScrollSpeed(760, 0, 800));
        expect(autoScrollSpeed(800, 0, 800)).toBe(18);
    });

    it("treats small finger travel as a hold", () => {
        expect(movedBeyond({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(false);
        expect(movedBeyond({ x: 0, y: 0 }, { x: 9, y: 0 })).toBe(true);
    });
});

describe("drop targets", () => {
    const rows: RowBox[] = [
        { top: 0, bottom: 48, canHoldChildren: true },
        { top: 48, bottom: 96, canHoldChildren: true },
        { top: 96, bottom: 144, canHoldChildren: true },
        { top: 144, bottom: 192, canHoldChildren: false }
    ];

    it("aims between rows at their edges and treats the origin's own gaps as no move", () => {
        expect(findDropTarget(5, rows, 0, null, 0)).toMatchObject({ target: { kind: "gap", gap: 0 }, isNoop: true });
        expect(findDropTarget(140, rows, 0, null, 0)).toMatchObject({ target: { kind: "gap", gap: 3 }, isNoop: false });
        expect(findDropTarget(90, rows, 2, null, 0)).toMatchObject({ target: { kind: "gap", gap: 2 }, isNoop: true });
        expect(findDropTarget(-20, rows, 2, null, 0)).toMatchObject({ target: { kind: "gap", gap: 0 }, isNoop: false });
        expect(findDropTarget(400, rows, 3, null, 0)).toMatchObject({ target: { kind: "gap", gap: 4 }, isNoop: true });
    });

    it("aims inside a row after a 500 ms rest on its middle, never inside itself or a leaf", () => {
        const first = findDropTarget(120, rows, 0, null, 1000);
        expect(first.target).toEqual({ kind: "gap", gap: 3 });
        expect(first.dwell).toEqual({ index: 2, since: 1000 });
        const later = findDropTarget(118, rows, 0, first.dwell, 1500);
        expect(later.target).toEqual({ kind: "inside", index: 2 });
        expect(later.isNoop).toBe(false);
        expect(findDropTarget(72, rows, 1, { index: 1, since: 0 }, 5000).target.kind).toBe("gap");
        expect(findDropTarget(168, rows, 0, { index: 3, since: 0 }, 5000).target.kind).toBe("gap");
        const moved = findDropTarget(72, rows, 0, first.dwell, 1600);
        expect(moved.dwell).toEqual({ index: 1, since: 1600 });
    });

    it("turns targets into branch operations", () => {
        const ids = [ "a", "b", "c" ];
        expect(moveOpFor({ kind: "gap", gap: 0 }, ids)).toEqual({ kind: "before", branchId: "a" });
        expect(moveOpFor({ kind: "gap", gap: 3 }, ids)).toEqual({ kind: "after", branchId: "c" });
        expect(moveOpFor({ kind: "inside", index: 1 }, ids)).toEqual({ kind: "into", branchId: "b" });
        expect(moveOpFor({ kind: "gap", gap: 0 }, [])).toBeNull();
    });

    it("plans the way back next to the old neighbours", () => {
        expect(planUndo([ "a", "b", "c" ], "b", "p")).toEqual({ kind: "after", branchId: "a" });
        expect(planUndo([ "a", "b", "c" ], "a", "p")).toEqual({ kind: "before", branchId: "b" });
        expect(planUndo([ "a" ], "a", "p")).toEqual({ kind: "into", parentNoteId: "p" });
    });
});

describe("press preview", () => {
    const row = { left: 0, top: 500, right: 300, bottom: 544 };
    const boxes = [ 0, 1, 2 ].map((i) => ({ left: i * 100, top: 500, right: i * 100 + 44, bottom: 544 }));

    it("picks the button under the finger, else the nearest, and cancels away from the row", () => {
        expect(distanceToBox({ x: 10, y: 520 }, boxes[0])).toBe(0);
        expect(distanceToBox({ x: 47, y: 496 }, boxes[0])).toBe(5);
        expect(pickedIndex({ x: 120, y: 520 }, row, boxes)).toBe(1);
        expect(pickedIndex({ x: 80, y: 520 }, row, boxes)).toBe(1);
        expect(pickedIndex({ x: 60, y: 520 }, row, boxes)).toBe(0);
        expect(pickedIndex({ x: 120, y: 480 }, row, boxes)).toBe(1);
        expect(pickedIndex({ x: 120, y: 460 }, row, boxes)).toBe(-1);
        expect(pickedIndex({ x: 120, y: 520 }, row, [])).toBe(-1);
    });

    it("names a button from its tooltip without the shortcut, or from its label", () => {
        const button = document.createElement("button");
        button.setAttribute("data-cke-tooltip-text", "Undo (⌘Z)");
        expect(labelOf(button)).toBe("Undo");
        button.setAttribute("data-cke-tooltip-text", "Bold (Ctrl+B)");
        expect(labelOf(button)).toBe("Bold");
        button.setAttribute("aria-label", "Heading (level 2)");
        expect(labelOf(button)).toBe("Heading (level 2)");

        const labelled = document.createElement("button");
        const label = document.createElement("span");
        label.id = "tf-label-test";
        label.textContent = "Insert";
        document.body.append(label, labelled);
        labelled.setAttribute("aria-labelledby", "tf-label-test");
        expect(labelOf(labelled)).toBe("Insert");
        label.remove();
        labelled.remove();
    });
});

describe("included to-dos", () => {
    it("ticks and unticks the n-th to-do of a note's HTML", () => {
        const item = (text: string, checked = false) =>
            `<li><label class="todo-list__label"><input type="checkbox" disabled="disabled"${checked ? " checked=\"checked\"" : ""}><span class="todo-list__label__description">${text}</span></label></li>`;
        const html = `<p>Before</p><ul class="todo-list">${item("One")}${item("Two", true)}</ul>`;
        const ticked = toggleTodoInHtml(html, 0) ?? "";
        const doc = new DOMParser().parseFromString(ticked, "text/html");
        expect([ ...doc.querySelectorAll("input") ].map((i) => i.hasAttribute("checked"))).toEqual([ true, true ]);
        const unticked = new DOMParser().parseFromString(toggleTodoInHtml(html, 1) ?? "", "text/html");
        expect([ ...unticked.querySelectorAll("input") ].map((i) => i.hasAttribute("checked"))).toEqual([ false, false ]);
        expect(unticked.querySelector("p")?.textContent).toBe("Before");
        expect(toggleTodoInHtml(html, 2)).toBeNull();
    });
});
