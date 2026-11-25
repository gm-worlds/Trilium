/**
 * Reordering and moving notes by touch in the phone navigator (`MobileNoteNavigator`).
 *
 * - A finger resting 350 ms on a row lifts it. Moving it shows an insertion line between rows; held
 *   500 ms over the middle of another row, that row lights up and a drop puts the note inside it.
 *   Near the top or bottom edge the list scrolls by itself.
 * - Lifting and letting go without moving opens the row's context menu (it used to open while the
 *   finger was still down, after 400 ms). Each row also has a visible "more" button for that menu
 *   (`navigator_row_tools.tsx`), so the two gestures never compete.
 * - Escape, a second finger, or letting go where the row started cancels.
 *
 * The navigator rows' own long-press handlers never see these touches: the listeners here run in
 * the capture phase on `document` and stop the events at the row.
 */
import froca from "../../services/froca.js";
import { tfHaptic } from "../bridge.js";
import { AutoScroller, DragGhost, InsertionLine } from "./drag_visuals.js";
import { LIFT_DELAY_MS, movedBeyond, type Point } from "./gestures.js";
import { moveWithUndo } from "./moves.js";
import { type Dwell, type DropResult, findDropTarget, moveOpFor } from "./reorder.js";

const ROW = ".mobile-navigator-row";
const LIST = ".mobile-navigator-list";

type State =
    | { kind: "idle" }
    | { kind: "pressed"; row: HTMLElement; start: Point; timer: number }
    | { kind: "lifted"; drag: Drag }
    | { kind: "dragging"; drag: Drag };

interface Drag {
    row: HTMLElement;
    list: HTMLElement;
    start: Point;
    last: Point;
    ghost: DragGhost;
    line: InsertionLine;
    scroller: AutoScroller;
    dwell: Dwell | null;
    dwellTimer: number;
    result: DropResult | null;
    insideRow: HTMLElement | null;
}

let state: State = { kind: "idle" };
let allowContextMenu = false;

export function installNavigatorDrag(isTouch: () => boolean) {
    const capture = { capture: true, passive: false } as const;
    document.addEventListener("touchstart", (e) => onTouchStart(e, isTouch), capture);
    document.addEventListener("touchmove", onTouchMove, capture);
    document.addEventListener("touchend", onTouchEnd, capture);
    document.addEventListener("touchcancel", () => cancel(), capture);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && state.kind !== "idle") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
        }
    }, true);
}

/** Ids a row's `TfNavigatorRowTools` carries: `{ noteId, parentNoteId, notePath }`. */
export function rowInfo(row: Element) {
    const tools = row.querySelector<HTMLElement>(":scope > .tf-row-tools");
    if (!tools) {
        return null;
    }
    const { noteId, parentNoteId, notePath } = tools.dataset;
    return noteId && parentNoteId && notePath ? { noteId, parentNoteId, notePath } : null;
}

function isDraggable(row: HTMLElement) {
    const info = rowInfo(row);
    return !!info && !info.noteId.startsWith("_") && !info.parentNoteId.startsWith("_")
        && !!row.closest(LIST) && !row.classList.contains("is-pending");
}

function onTouchStart(e: TouchEvent, isTouch: () => boolean) {
    if (state.kind !== "idle") {
        // A second finger ends the drag.
        cancel();
        return;
    }
    const target = e.target instanceof Element ? e.target : null;
    const row = target?.closest<HTMLElement>(ROW);
    if (!row || !isTouch() || e.touches.length !== 1 || target?.closest(".tf-row-more") || !isDraggable(row)) {
        return;
    }
    e.stopPropagation();
    const touch = e.touches[0];
    const start = { x: touch.clientX, y: touch.clientY };
    state = { kind: "pressed", row, start, timer: window.setTimeout(() => lift(), LIFT_DELAY_MS) };
}

function onTouchMove(e: TouchEvent) {
    const touch = e.touches[0];
    if (!touch) {
        return;
    }
    const point = { x: touch.clientX, y: touch.clientY };
    if (state.kind === "pressed") {
        if (movedBeyond(state.start, point)) {
            clearTimeout(state.timer);
            state = { kind: "idle" };
        }
        return;
    }
    if (state.kind === "idle") {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const drag = state.drag;
    if (state.kind === "lifted" && movedBeyond(drag.start, point)) {
        state = { kind: "dragging", drag };
    }
    drag.last = point;
    drag.ghost.moveTo(point.x, point.y);
    if (state.kind === "dragging") {
        aim(drag);
        drag.scroller.update(point.y);
    }
}

function onTouchEnd(e: TouchEvent) {
    if (state.kind === "pressed") {
        clearTimeout(state.timer);
        state = { kind: "idle" };
        return;
    }
    if (state.kind === "idle") {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const current = state;
    if (current.kind === "lifted") {
        const { row, last } = current.drag;
        finish(current.drag);
        openRowMenu(row, last);
        return;
    }
    void drop(current.drag);
}

/** Native long-press menus (Android) stay away while a row is held or dragged. */
function onContextMenu(e: Event) {
    if (state.kind !== "idle" && !allowContextMenu) {
        e.preventDefault();
        e.stopPropagation();
    }
}

function lift() {
    if (state.kind !== "pressed") {
        return;
    }
    const { row, start } = state;
    const list = row.closest<HTMLElement>(LIST);
    const scrollElement = row.closest<HTMLElement>(".mobile-navigator-scroll");
    if (!list || !scrollElement) {
        state = { kind: "idle" };
        return;
    }
    tfHaptic("light");
    const ghost = new DragGhost(row, start.x, start.y, "tf-drag-ghost--row");
    document.body.classList.add("tf-dragging");
    row.classList.add("tf-drag-source");
    const drag: Drag = {
        row,
        list,
        start,
        last: start,
        ghost,
        line: new InsertionLine(),
        scroller: new AutoScroller(scrollElement, () => aim(drag)),
        dwell: null,
        dwellTimer: 0,
        result: null,
        insideRow: null
    };
    state = { kind: "lifted", drag };
}

function rowsOf(list: HTMLElement) {
    return [ ...list.querySelectorAll<HTMLElement>(`:scope > ${ROW}`) ];
}

function aim(drag: Drag) {
    const rows = rowsOf(drag.list);
    const originIndex = rows.indexOf(drag.row);
    const boxes = rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, canHoldChildren: !row.classList.contains("is-pending") };
    });
    const result = findDropTarget(drag.last.y, boxes, originIndex, drag.dwell, performance.now());
    drag.result = result;

    clearTimeout(drag.dwellTimer);
    if (result.dwell && result.target.kind !== "inside") {
        drag.dwellTimer = window.setTimeout(() => aim(drag), 520 - (performance.now() - result.dwell.since));
    }
    drag.dwell = result.dwell;

    const insideRow = result.target.kind === "inside" ? rows[result.target.index] : null;
    if (insideRow !== drag.insideRow) {
        drag.insideRow?.classList.remove("tf-drop-inside");
        insideRow?.classList.add("tf-drop-inside");
        if (insideRow) {
            tfHaptic("light");
        }
        drag.insideRow = insideRow;
    }

    if (result.target.kind !== "gap" || result.isNoop || rows.length === 0) {
        drag.line.show(null);
        return;
    }
    const gap = result.target.gap;
    const listRect = drag.list.getBoundingClientRect();
    const y = gap === 0 ? boxes[0].top
        : gap >= boxes.length ? boxes[boxes.length - 1].bottom
            : (boxes[gap - 1].bottom + boxes[gap].top) / 2;
    drag.line.show({ y, left: listRect.left + 12, right: listRect.right - 12 });
}

async function drop(drag: Drag) {
    aim(drag);
    const result = drag.result;
    const rows = rowsOf(drag.list);
    const source = rowInfo(drag.row);
    finish(drag);
    if (!result || result.isNoop || !source) {
        return;
    }

    const branchIds = rows.map((row) => {
        const info = rowInfo(row);
        return info ? froBranchId(info.parentNoteId, info.noteId) : "";
    });
    const op = moveOpFor(result.target, branchIds);
    const branchId = froBranchId(source.parentNoteId, source.noteId);
    if (!op || !op.branchId || !branchId) {
        return;
    }
    const targetRow = result.target.kind === "inside" ? rows[result.target.index] : null;
    await moveWithUndo({ branchId, op, targetNotePath: targetRow ? rowInfo(targetRow)?.notePath : undefined });
}

function froBranchId(parentNoteId: string, noteId: string) {
    return froca.getNoteFromCache(parentNoteId)?.childToBranch[noteId] ?? "";
}

function finish(drag: Drag) {
    clearTimeout(drag.dwellTimer);
    drag.scroller.stop();
    drag.ghost.remove();
    drag.line.remove();
    drag.row.classList.remove("tf-drag-source");
    drag.insideRow?.classList.remove("tf-drop-inside");
    document.body.classList.remove("tf-dragging");
    state = { kind: "idle" };
}

function cancel() {
    if (state.kind === "pressed") {
        clearTimeout(state.timer);
        state = { kind: "idle" };
    } else if (state.kind !== "idle") {
        finish(state.drag);
    }
}

/** Opens the row's context menu (its `onContextMenu`) at `at`. */
export function openRowMenu(row: HTMLElement, at: Point) {
    allowContextMenu = true;
    try {
        row.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: at.x,
            clientY: at.y,
            button: 2
        }));
    } finally {
        allowContextMenu = false;
    }
}
