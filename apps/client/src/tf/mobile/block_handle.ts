/**
 * A block handle for text notes on touch. Tapping into a block shows a 44 px handle at the block's
 * left edge; dragging the handle moves the block to another place among the note's top-level
 * blocks, with an insertion line and auto-scroll, as one undo step. Upstream's `BlockDragHandle`
 * plugin is off in the mobile layout (no margin for it) and drags with HTML5 events, which a finger
 * does not fire, so the handle here is separate and moves the block through the CKEditor model the
 * way the toolbar's `moveBlockUp` and `moveBlockDown` commands do (`writer.move()`).
 *
 * The handle hides while typing and on a scroll that takes its block away; text selection, the
 * system selection menu and the platform's own drag of selected text are left alone: nothing here
 * listens to touches outside the handle.
 */
import "./block_handle.css";

import { t } from "../../services/i18n.js";
import { tfHaptic } from "../bridge.js";
import { AutoScroller, DragGhost, InsertionLine, scrollParentOf } from "./drag_visuals.js";
import { movedBeyond, type Point } from "./gestures.js";
import { findDropTarget } from "./reorder.js";

const EDITABLE = ".note-detail-editable-text .ck-editor__editable.ck-content";

/** The CKEditor surface this module needs, typed loosely to keep CKEditor out of the bundle. */
interface Editor {
    isReadOnly: boolean;
    model: {
        document: { selection: { getFirstPosition(): ModelPosition | null }; getRoot(): ModelElement };
        schema: { isObject(element: ModelElement): boolean };
        change(callback: (writer: ModelWriter) => void): void;
    };
    editing: {
        mapper: { toViewElement(element: ModelElement): unknown };
        view: { domConverter: { mapViewToDom(view: unknown): HTMLElement | undefined }; focus(): void };
    };
}
interface ModelElement {
    parent: ModelElement | null;
    getChildren(): Iterable<ModelElement>;
    childCount: number;
}
interface ModelPosition {
    getAncestors(): ModelElement[];
}
interface ModelWriter {
    move(range: unknown, position: unknown): void;
    createRangeOn(element: ModelElement): unknown;
    createPositionBefore(element: ModelElement): unknown;
    createPositionAt(parent: ModelElement, offset: number | "end"): unknown;
    setSelection(element: ModelElement, placeOrOffset: "on" | "end"): void;
}

interface Drag {
    editor: Editor;
    editable: HTMLElement;
    originIndex: number;
    start: Point;
    last: Point;
    ghost: DragGhost | null;
    line: InsertionLine;
    scroller: AutoScroller;
    gap: number | null;
}

let handle: HTMLButtonElement | null = null;
let current: { editor: Editor; editable: HTMLElement; block: HTMLElement } | null = null;
let drag: Drag | null = null;
let frame = 0;

export function installBlockHandle(isTouch: () => boolean) {
    document.addEventListener("touchend", (e) => {
        if (!isTouch() || drag || e.touches.length) {
            return;
        }
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest(".tf-block-handle")) {
            return;
        }
        const editable = target?.closest<HTMLElement>(EDITABLE);
        if (!editable) {
            hide();
            return;
        }
        // The selection moves after the tap's `click`, which follows `touchend`.
        setTimeout(() => showFor(editable), 60);
    }, { capture: true, passive: true });

    document.addEventListener("selectionchange", () => {
        if (current && !drag) {
            schedulePlace();
        }
    });
    document.addEventListener("input", (e) => {
        if (!drag && e.target instanceof Element && e.target.closest(EDITABLE)) {
            hide();
        }
    }, true);
    document.addEventListener("scroll", () => {
        if (current && !drag) {
            schedulePlace();
        }
    }, { capture: true, passive: true });
    window.addEventListener("resize", () => schedulePlace());
}

function editorOf(editable: HTMLElement) {
    return (editable as HTMLElement & { ckeditorInstance?: Editor }).ckeditorInstance ?? null;
}

/** The top-level model blocks of the editor and their DOM elements. */
function topLevelBlocks(editor: Editor) {
    const root = editor.model.document.getRoot();
    const blocks: { model: ModelElement; dom: HTMLElement }[] = [];
    for (const model of root.getChildren()) {
        const view = editor.editing.mapper.toViewElement(model);
        const dom = view ? editor.editing.view.domConverter.mapViewToDom(view) : undefined;
        if (dom) {
            blocks.push({ model, dom });
        }
    }
    return blocks;
}

function selectedTopLevel(editor: Editor) {
    const position = editor.model.document.selection.getFirstPosition();
    const root = editor.model.document.getRoot();
    const ancestors = position?.getAncestors() ?? [];
    return ancestors.find((element) => element.parent === root) ?? null;
}

function showFor(editable: HTMLElement) {
    const editor = editorOf(editable);
    if (!editor || editor.isReadOnly) {
        hide();
        return;
    }
    const model = selectedTopLevel(editor);
    const block = model ? topLevelBlocks(editor).find((b) => b.model === model)?.dom : undefined;
    if (!block) {
        hide();
        return;
    }
    current = { editor, editable, block };
    ensureHandle();
    place();
}

function ensureHandle() {
    if (handle) {
        return handle;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tf-block-handle";
    button.setAttribute("aria-label", t("tf.block_handle"));
    button.innerHTML = "<span class=\"bx bx-grid-vertical\" aria-hidden=\"true\"></span>";
    button.addEventListener("touchstart", onHandleStart, { passive: false });
    button.addEventListener("touchmove", onHandleMove, { passive: false });
    button.addEventListener("touchend", onHandleEnd, { passive: false });
    button.addEventListener("touchcancel", () => endDrag(false));
    button.addEventListener("contextmenu", (e) => e.preventDefault());
    document.body.append(button);
    handle = button;
    return button;
}

function schedulePlace() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
        if (!current) {
            return;
        }
        // Follow the selection to another block.
        const model = selectedTopLevel(current.editor);
        const block = model ? topLevelBlocks(current.editor).find((b) => b.model === model)?.dom : undefined;
        if (block) {
            current.block = block;
        }
        place();
    });
}

function place() {
    if (!current || !handle) {
        return;
    }
    const { block, editable } = current;
    if (!block.isConnected || !editable.isConnected) {
        hide();
        return;
    }
    const rect = block.getBoundingClientRect();
    const scroller = scrollParentOf(editable).getBoundingClientRect();
    const lineTop = rect.top + Math.min(rect.height, 28) / 2;
    const visible = lineTop > Math.max(scroller.top, 0) && lineTop < Math.min(scroller.bottom, window.innerHeight);
    handle.classList.toggle("is-shown", visible);
    const editableRect = editable.getBoundingClientRect();
    const x = Math.max(2, Math.min(rect.left, editableRect.left) - 30);
    handle.style.translate = `${Math.round(x)}px ${Math.round(lineTop - 22)}px`;
}

function hide() {
    current = null;
    handle?.classList.remove("is-shown");
}

function onHandleStart(e: TouchEvent) {
    if (!current || e.touches.length !== 1) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const { editor, editable, block } = current;
    const blocks = topLevelBlocks(editor);
    const originIndex = blocks.findIndex((b) => b.dom === block);
    if (originIndex < 0) {
        return;
    }
    const touch = e.touches[0];
    const start = { x: touch.clientX, y: touch.clientY };
    const scrollElement = scrollParentOf(editable);
    const state: Drag = {
        editor,
        editable,
        originIndex,
        start,
        last: start,
        ghost: null,
        line: new InsertionLine(),
        scroller: new AutoScroller(scrollElement, () => aim(state)),
        gap: null
    };
    drag = state;
    handle?.classList.add("is-pressed");
}

function onHandleMove(e: TouchEvent) {
    const touch = e.touches[0];
    if (!drag || !touch) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const point = { x: touch.clientX, y: touch.clientY };
    drag.last = point;
    if (!drag.ghost) {
        if (!movedBeyond(drag.start, point, 4) || !current) {
            return;
        }
        drag.ghost = new DragGhost(current.block, drag.start.x, drag.start.y, "tf-drag-ghost--block");
        current.block.classList.add("tf-drag-source");
        document.body.classList.add("tf-dragging");
        tfHaptic("light");
    }
    drag.ghost.moveTo(point.x, point.y);
    handle?.classList.remove("is-shown");
    aim(drag);
    drag.scroller.update(point.y);
}

function onHandleEnd(e: TouchEvent) {
    if (!drag) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    endDrag(!!drag.ghost);
}

function aim(state: Drag) {
    const blocks = topLevelBlocks(state.editor);
    const boxes = blocks.map(({ dom }) => {
        const rect = dom.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, canHoldChildren: false };
    });
    const result = findDropTarget(state.last.y, boxes, state.originIndex, null, 0);
    if (result.target.kind !== "gap" || result.isNoop || boxes.length === 0) {
        state.gap = null;
        state.line.show(null);
        return;
    }
    const gap = result.target.gap;
    state.gap = gap;
    const editableRect = state.editable.getBoundingClientRect();
    const y = gap === 0 ? boxes[0].top - 2
        : gap >= boxes.length ? boxes[boxes.length - 1].bottom + 2
            : (boxes[gap - 1].bottom + boxes[gap].top) / 2;
    state.line.show({ y, left: editableRect.left + 4, right: editableRect.right - 4 });
}

function endDrag(commit: boolean) {
    const state = drag;
    drag = null;
    handle?.classList.remove("is-pressed");
    if (!state) {
        return;
    }
    state.scroller.stop();
    state.ghost?.remove();
    state.line.remove();
    current?.block.classList.remove("tf-drag-source");
    document.body.classList.remove("tf-dragging");
    if (!commit || state.gap === null) {
        schedulePlace();
        return;
    }
    moveBlock(state.editor, state.originIndex, state.gap);
    tfHaptic("success");
    schedulePlace();
}

/** Moves the top-level block at `from` to gap `gap` (0 = before the first block). */
export function moveBlock(editor: Editor, from: number, gap: number) {
    const root = editor.model.document.getRoot();
    const blocks = [ ...root.getChildren() ];
    const source = blocks[from];
    if (!source || gap === from || gap === from + 1) {
        return;
    }
    editor.model.change((writer) => {
        const target = gap < blocks.length ? writer.createPositionBefore(blocks[gap]) : writer.createPositionAt(root, "end");
        writer.move(writer.createRangeOn(source), target);
        writer.setSelection(source, editor.model.schema.isObject(source) ? "on" : "end");
    });
    editor.editing.view.focus();
}
