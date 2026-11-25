/**
 * Two-finger pinch and pan for the mind map on touch. Mind Elixir zooms with the wheel and Ctrl,
 * and its own pinch code never scales inside the frame, so two touch pointers on the map are taken
 * here: their spread drives `scale()` around their midpoint, and the midpoint's travel drives
 * `move()`. One finger keeps Mind Elixir's own pan and node dragging. The relation map and the
 * image viewer pinch through react-zoom-pan-pinch already and are left alone.
 */
import { getTfMindMap } from "../state.js";
import { distance, midpoint, type Point } from "./gestures.js";

interface MindElixirLike {
    scaleVal: number;
    scaleMin?: number;
    scaleMax?: number;
    scale(value: number, at?: Point): void;
    move(dx: number, dy: number): void;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

export function installMapGestures(isTouch: () => boolean) {
    const pointers = new Map<number, Point>();
    let gesture: { map: MindElixirLike; distance: number; mid: Point } | null = null;

    const reset = () => {
        if (pointers.size >= 2) {
            const [ a, b ] = [ ...pointers.values() ];
            if (gesture) {
                gesture.distance = distance(a, b);
                gesture.mid = midpoint(a, b);
            }
        } else {
            gesture = null;
        }
    };

    document.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch" || !isTouch()) {
            return;
        }
        const container = e.target instanceof Element ? e.target.closest(".mind-map-container") : null;
        const map = container ? getTfMindMap(container) as MindElixirLike | null : null;
        if (!map) {
            return;
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
            const [ a, b ] = [ ...pointers.values() ];
            gesture = { map, distance: distance(a, b), mid: midpoint(a, b) };
        }
    }, true);

    // Both fingers of one touch frame move in separate `pointermove` events, so the gesture is
    // applied once per animation frame from their latest positions.
    let frame = 0;
    const apply = () => {
        frame = 0;
        if (!gesture || pointers.size < 2) {
            return;
        }
        const [ a, b ] = [ ...pointers.values() ];
        const spread = distance(a, b);
        const mid = midpoint(a, b);
        const { map } = gesture;
        if (gesture.distance > 0 && Math.abs(spread - gesture.distance) > 1) {
            const next = Math.min(map.scaleMax ?? MAX_SCALE, Math.max(map.scaleMin ?? MIN_SCALE, map.scaleVal * spread / gesture.distance));
            map.scale(next, mid);
            gesture.distance = spread;
        }
        const dx = mid.x - gesture.mid.x;
        const dy = mid.y - gesture.mid.y;
        if (dx || dy) {
            map.move(dx, dy);
        }
        gesture.mid = mid;
    };

    document.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) {
            return;
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (!gesture || pointers.size < 2) {
            return;
        }
        // Mind Elixir would pan with the first finger meanwhile.
        e.stopPropagation();
        frame ||= requestAnimationFrame(apply);
    }, true);

    const end = (e: PointerEvent) => {
        if (pointers.delete(e.pointerId)) {
            reset();
        }
    };
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
}
