/**
 * Touch dragging for the Fancytree note tree (the desktop layout, which a tablet gets when its
 * browser reports no `Mobi`, or when Taskforce asks for it). Fancytree's `dnd5` extension listens
 * for HTML5 drag events, which a finger does not start reliably, so this drives the same callbacks
 * from touch events instead: `dragStart()` decides what may be dragged, `dragEnter()` where it may
 * land, and `dragDrop()` performs the move through `services/branches.ts`. Fancytree's own rules
 * (no drop on the node itself or below it) are applied before `dragEnter()`, as `dnd5` does.
 *
 * Hold 350 ms to lift; let go without moving for the context menu; held 600 ms over a closed folder,
 * it opens. A toast with "Undo" follows every move. `touchstart` is passive and the other touch
 * listeners exist only while a node is pressed or lifted (`touch_session.ts`), so scrolling the tree
 * never waits for them.
 */
import ws from "../../services/ws.js";
import { tfHaptic } from "../bridge.js";
import { AutoScroller, DragGhost, InsertionLine, scrollParentOf } from "./drag_visuals.js";
import { LIFT_DELAY_MS, movedBeyond, type Point } from "./gestures.js";
import { offerUndo, type PreparedUndo, prepareUndo } from "./moves.js";
import type { MoveOp } from "./reorder.js";
import { GestureListeners, listenModeFor, lockScroll, preventIfCancelable, swallowNextClick } from "./touch_session.js";

type HitMode = "before" | "after" | "over";

interface FakeDataTransfer {
    types: string[];
    files: File[];
    dropEffect: string;
    effectAllowed: string;
    setData(type: string, value: string): void;
    getData(type: string): string;
    setDragImage(): void;
}

interface Drag {
    node: Fancytree.FancytreeNode;
    span: HTMLElement;
    start: Point;
    last: Point;
    ghost: DragGhost;
    line: InsertionLine;
    scroller: AutoScroller;
    dataTransfer: FakeDataTransfer;
    target: { node: Fancytree.FancytreeNode; hitMode: HitMode } | null;
    expandTimer: number;
    expandFor: Fancytree.FancytreeNode | null;
    insideSpan: HTMLElement | null;
    moved: boolean;
    unlock: () => void;
}

type State =
    | { kind: "idle" }
    | { kind: "pressed"; span: HTMLElement; start: Point; timer: number }
    | { kind: "drag"; drag: Drag };

const AUTO_EXPAND_MS = 600;
let state: State = { kind: "idle" };
let allowContextMenu = false;
const listeners = new GestureListeners({ move: onTouchMove, end: onTouchEnd, cancel: () => cancel() });

function setState(next: State) {
    state = next;
    listeners.set(listenModeFor(next.kind === "drag" ? "owned" : next.kind));
}

export function installTreeDrag(isTouch: () => boolean) {
    document.addEventListener("touchstart", (e) => onTouchStart(e, isTouch), { capture: true, passive: true });
    document.addEventListener("contextmenu", (e) => {
        if (state.kind !== "idle" && !allowContextMenu) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
    // The platform's own drag of a draggable node (iPadOS, Android) would compete with this one.
    document.addEventListener("dragstart", (e) => {
        if (state.kind !== "idle" && e.target instanceof Element && e.target.closest(".fancytree-node")) {
            e.preventDefault();
        }
    }, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && state.kind !== "idle") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
        }
    }, true);
}

function treeOf(element: Element) {
    try {
        return $.ui.fancytree.getTree(element as HTMLElement) as Fancytree.Fancytree | null;
    } catch {
        return null;
    }
}

function nodeOf(element: Element) {
    return $.ui.fancytree.getNode(element as HTMLElement) as Fancytree.FancytreeNode | null;
}

function dnd5Of(tree: Fancytree.Fancytree) {
    return (tree.options as unknown as { dnd5?: {
        dragStart(node: Fancytree.FancytreeNode, data: object): boolean;
        dragEnter(node: Fancytree.FancytreeNode, data: object): boolean | string[] | HitMode;
        dragDrop(node: Fancytree.FancytreeNode, data: object): Promise<void> | void;
    } }).dnd5;
}

function onTouchStart(e: TouchEvent, isTouch: () => boolean) {
    if (state.kind !== "idle") {
        cancel();
        return;
    }
    const span = e.target instanceof Element ? e.target.closest<HTMLElement>(".fancytree-node") : null;
    if (!span || !isTouch() || e.touches.length !== 1 || e.target instanceof Element && e.target.closest(".fancytree-expander, .tree-item-button, .add-note-button")) {
        return;
    }
    const touch = e.touches[0];
    const start = { x: touch.clientX, y: touch.clientY };
    setState({ kind: "pressed", span, start, timer: window.setTimeout(() => lift(), LIFT_DELAY_MS) });
}

function onTouchMove(e: TouchEvent) {
    const touch = e.touches[0];
    if (!touch || state.kind === "idle") {
        return;
    }
    const point = { x: touch.clientX, y: touch.clientY };
    if (state.kind === "pressed") {
        if (movedBeyond(state.start, point)) {
            clearTimeout(state.timer);
            setState({ kind: "idle" });
        }
        return;
    }
    preventIfCancelable(e);
    e.stopPropagation();
    const drag = state.drag;
    drag.last = point;
    drag.ghost.moveTo(point.x, point.y);
    if (!drag.moved && movedBeyond(drag.start, point)) {
        drag.moved = true;
    }
    if (drag.moved) {
        aim(drag);
        drag.scroller.update(point.y);
    }
}

function onTouchEnd(e: TouchEvent) {
    if (state.kind === "pressed") {
        clearTimeout(state.timer);
        setState({ kind: "idle" });
        return;
    }
    if (state.kind !== "drag") {
        return;
    }
    preventIfCancelable(e);
    e.stopPropagation();
    swallowNextClick();
    const drag = state.drag;
    if (!drag.moved) {
        finish(drag);
        allowContextMenu = true;
        try {
            drag.span.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: drag.last.x, clientY: drag.last.y, button: 2 }));
        } finally {
            allowContextMenu = false;
        }
        return;
    }
    void drop(drag);
}

function lift() {
    if (state.kind !== "pressed") {
        return;
    }
    const { span, start } = state;
    const node = nodeOf(span);
    const tree = treeOf(span);
    const dnd5 = tree && dnd5Of(tree);
    if (!node || !tree || !dnd5) {
        setState({ kind: "idle" });
        return;
    }

    const store = new Map<string, string>();
    const dataTransfer: FakeDataTransfer = {
        types: [],
        files: [],
        dropEffect: "move",
        effectAllowed: "all",
        setData(type, value) {
            store.set(type, value);
            if (!this.types.includes(type)) {
                this.types.push(type);
            }
        },
        getData: (type) => store.get(type) ?? "",
        setDragImage() {}
    };
    if (!dnd5.dragStart(node, { node, tree, dataTransfer, options: tree.options })) {
        setState({ kind: "idle" });
        return;
    }

    tfHaptic("light");
    const ghost = new DragGhost(span, start.x, start.y, "tf-drag-ghost--tree");
    document.body.classList.add("tf-dragging");
    span.classList.add("tf-drag-source");
    const scrollElement = scrollParentOf(span);
    const drag: Drag = {
        node,
        span,
        start,
        last: start,
        ghost,
        line: new InsertionLine(),
        scroller: new AutoScroller(scrollElement, () => aim(drag)),
        dataTransfer,
        target: null,
        expandTimer: 0,
        expandFor: null,
        insideSpan: null,
        moved: false,
        unlock: lockScroll(scrollElement)
    };
    setState({ kind: "drag", drag });
}

function aim(drag: Drag) {
    const element = document.elementFromPoint(drag.last.x, drag.last.y);
    const span = element?.closest<HTMLElement>(".fancytree-node") ?? null;
    const node = span ? nodeOf(span) : null;
    const tree = treeOf(drag.span);
    let target: Drag["target"] = null;

    if (span && node && tree && node.tree === drag.node.tree && node !== drag.node && !node.isDescendantOf(drag.node)) {
        const rect = span.getBoundingClientRect();
        const zone = (drag.last.y - rect.top) / Math.max(1, rect.height);
        const wanted: HitMode = zone < 0.25 ? "before" : zone > 0.75 ? "after" : "over";
        const response = dnd5Of(tree)?.dragEnter(node, { node, otherNode: drag.node, tree, dataTransfer: drag.dataTransfer });
        const allowed = allowedModes(response);
        const hitMode = allowed.includes(wanted) ? wanted : null;
        if (hitMode && !isVoidMove(drag.node, node, hitMode)) {
            target = { node, hitMode };
        }
    }
    drag.target = target;

    const insideSpan = target?.hitMode === "over" ? (target.node.span as HTMLElement) : null;
    if (insideSpan !== drag.insideSpan) {
        drag.insideSpan?.classList.remove("tf-drop-inside");
        insideSpan?.classList.add("tf-drop-inside");
        drag.insideSpan = insideSpan;
    }

    if (target && target.hitMode !== "over") {
        const rect = (target.node.span as HTMLElement).getBoundingClientRect();
        const title = (target.node.span as HTMLElement).querySelector(".fancytree-title")?.getBoundingClientRect() ?? rect;
        drag.line.show({ y: target.hitMode === "before" ? rect.top : rect.bottom, left: title.left, right: rect.right - 8 });
    } else {
        drag.line.show(null);
    }

    const expandFor = target?.hitMode === "over" && target.node.hasChildren() && !target.node.isExpanded() ? target.node : null;
    if (expandFor !== drag.expandFor) {
        clearTimeout(drag.expandTimer);
        drag.expandFor = expandFor;
        if (expandFor) {
            drag.expandTimer = window.setTimeout(() => {
                void expandFor.setExpanded(true);
            }, AUTO_EXPAND_MS);
        }
    }
}

function allowedModes(response: unknown): HitMode[] {
    if (response === true) {
        return [ "over", "before", "after" ];
    }
    if (typeof response === "string") {
        return [ response as HitMode ];
    }
    if (Array.isArray(response)) {
        return response.filter((mode): mode is HitMode => mode === "over" || mode === "before" || mode === "after");
    }
    return [];
}

/** A drop that would leave the node where it is (`dnd5`'s "void move"). */
function isVoidMove(source: Fancytree.FancytreeNode, target: Fancytree.FancytreeNode, hitMode: HitMode) {
    return (hitMode === "before" && target === source.getNextSibling())
        || (hitMode === "after" && target === source.getPrevSibling());
}

async function drop(drag: Drag) {
    aim(drag);
    const target = drag.target;
    const tree = treeOf(drag.span);
    const dnd5 = tree && dnd5Of(tree);
    finish(drag);
    if (!target || !dnd5 || !tree) {
        return;
    }

    const branchId = drag.node.data.branchId as string;
    const undo = prepareUndo(branchId);
    const targetBranchId = target.node.data.branchId as string;
    const op: MoveOp = target.hitMode === "over" ? { kind: "into", branchId: targetBranchId }
        : { kind: target.hitMode, branchId: targetBranchId };

    await dnd5.dragDrop(target.node, {
        node: target.node,
        otherNode: drag.node,
        tree,
        hitMode: target.hitMode,
        dataTransfer: drag.dataTransfer
    });
    // `dragDrop()` starts the move without waiting for it, so the note's place is watched instead.
    if (undo && await placeChanged(branchId, undo)) {
        tfHaptic("success");
        offerUndo(undo, op);
    }
}

async function placeChanged(branchId: string, before: PreparedUndo) {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await ws.waitForMaxKnownEntityChangeId();
        const now = prepareUndo(branchId);
        if (!now || JSON.stringify(now.plan) !== JSON.stringify(before.plan)) {
            return true;
        }
    }
    return false;
}

function finish(drag: Drag) {
    clearTimeout(drag.expandTimer);
    drag.scroller.stop();
    drag.ghost.remove();
    drag.line.remove();
    drag.span.classList.remove("tf-drag-source");
    drag.insideSpan?.classList.remove("tf-drop-inside");
    drag.unlock();
    document.body.classList.remove("tf-dragging");
    setState({ kind: "idle" });
}

function cancel() {
    if (state.kind === "pressed") {
        clearTimeout(state.timer);
    } else if (state.kind === "drag") {
        finish(state.drag);
    }
    setState({ kind: "idle" });
}
