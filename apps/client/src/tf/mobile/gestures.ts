/**
 * Gesture maths for the touch layer: pinch scale, text size steps and snapping, auto-scroll speed
 * near an edge, and the press that turns into a lift. Pure functions, unit-tested in
 * `gestures.spec.ts`.
 */

export interface Point {
    x: number;
    y: number;
}

export const TEXT_SCALE_MIN = 0.8;
export const TEXT_SCALE_MAX = 2.2;
/** A pinch that ends this close to 100 % lands on 100 %. */
export const TEXT_SCALE_SNAP = 0.06;
/** One press of the minus or plus button. */
export const TEXT_SCALE_STEP = 0.1;

/** How long a finger rests on a row or a tree node before the row lifts. */
export const LIFT_DELAY_MS = 350;
/** How long a lifted row rests over another row before a drop puts it inside. */
export const DROP_INSIDE_DELAY_MS = 500;
/** A finger that moves further than this before the lift scrolls instead. */
export const LIFT_SLOP_PX = 8;
/** Edge band in which a drag scrolls the list by itself. */
export const AUTO_SCROLL_EDGE_PX = 56;
/** Fastest auto-scroll, in CSS pixels per frame. */
export const AUTO_SCROLL_MAX_PX = 18;

export function distance(a: Point, b: Point) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The factor two fingers that started `startDistance` apart have pinched to. */
export function pinchFactor(startDistance: number, currentDistance: number) {
    if (startDistance <= 0 || !Number.isFinite(startDistance) || !Number.isFinite(currentDistance)) {
        return 1;
    }
    return currentDistance / startDistance;
}

export function clampTextScale(scale: number) {
    if (!Number.isFinite(scale)) {
        return 1;
    }
    return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, scale));
}

/**
 * The text scale a pinch shows: `base` times the pinch factor, clamped, held at 100 % while it is
 * within {@link TEXT_SCALE_SNAP} of it, and rounded to whole percent.
 */
export function pinchedTextScale(base: number, factor: number) {
    const raw = clampTextScale(base * factor);
    if (Math.abs(raw - 1) < TEXT_SCALE_SNAP) {
        return 1;
    }
    return Math.round(raw * 100) / 100;
}

/** One minus or plus step from `scale`, landing on the 10 % grid. */
export function steppedTextScale(scale: number, direction: -1 | 1) {
    const percent = Math.round(clampTextScale(scale) * 100);
    const step = TEXT_SCALE_STEP * 100;
    const onGrid = direction > 0 ? Math.floor(percent / step) * step + step : Math.ceil(percent / step) * step - step;
    return clampTextScale(onGrid / 100);
}

/** Whether a scale change crossed into 100 % (the moment for a haptic tick). */
export function snappedToOne(previous: number, next: number) {
    return next === 1 && previous !== 1;
}

/** Parses a stored text scale; anything unusable is 100 %. */
export function parseTextScale(value: unknown) {
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
    return Number.isFinite(parsed) && parsed > 0 ? clampTextScale(parsed) : 1;
}

export function formatTextScale(scale: number) {
    return `${Math.round(scale * 100)} %`;
}

/**
 * The scroll offset that keeps the content point under `anchor` (a distance from the top of the
 * scroller) in place when the content grows by `ratio`.
 */
export function anchoredScrollTop(scrollTop: number, anchor: number, ratio: number) {
    return Math.max(0, (scrollTop + anchor) * ratio - anchor);
}

/**
 * Pixels per frame to scroll a list whose visible part spans `top` to `bottom` while a finger is
 * at `y`: negative near the top edge, positive near the bottom one, 0 in between. Speed grows with
 * how deep the finger is in the edge band.
 */
export function autoScrollSpeed(y: number, top: number, bottom: number, edge = AUTO_SCROLL_EDGE_PX, max = AUTO_SCROLL_MAX_PX) {
    if (bottom - top <= edge * 2) {
        edge = Math.max(8, (bottom - top) / 4);
    }
    if (y < top + edge) {
        const depth = Math.min(1, (top + edge - y) / edge);
        return -Math.max(1, Math.round(max * depth * depth));
    }
    if (y > bottom - edge) {
        const depth = Math.min(1, (y - (bottom - edge)) / edge);
        return Math.max(1, Math.round(max * depth * depth));
    }
    return 0;
}

/** Whether a finger that started at `start` and is now at `now` has moved past the lift slop. */
export function movedBeyond(start: Point, now: Point, slop = LIFT_SLOP_PX) {
    return distance(start, now) > slop;
}

/**
 * How long a finger rests on a button of a dense row before its name pops up above the finger and
 * sliding picks a neighbour. A finger that moves further than {@link PRESS_SLOP_PX} sooner scrolls
 * the row instead.
 */
export const PRESS_PREVIEW_DELAY_MS = 120;
export const PRESS_SLOP_PX = 8;
/** A finger further than this from the row while picking cancels the press. */
export const PRESS_CANCEL_PX = 28;

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Distance from `point` to the nearest edge of `box`, 0 inside it. */
export function distanceToBox(point: Point, box: Box) {
    const dx = Math.max(box.left - point.x, 0, point.x - box.right);
    const dy = Math.max(box.top - point.y, 0, point.y - box.bottom);
    return Math.hypot(dx, dy);
}

/**
 * Index of the box a finger at `point` picks while sliding along a row: the one under it, else the
 * nearest. `-1` once the finger is more than `cancel` away from `row`, or when there are no boxes.
 */
export function pickedIndex(point: Point, row: Box, boxes: Box[], cancel = PRESS_CANCEL_PX) {
    if (!boxes.length || distanceToBox(point, row) > cancel) {
        return -1;
    }
    let best = -1;
    let bestDistance = Infinity;
    for (const [ index, box ] of boxes.entries()) {
        const d = distanceToBox(point, box);
        if (d < bestDistance) {
            best = index;
            bestDistance = d;
        }
    }
    return best;
}
