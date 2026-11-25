/**
 * Reading size of note content for one person: a two-finger pinch on a text or code note changes
 * it live between 80 % and 220 %, holding at 100 %, and the "Text size" row of the note menu
 * (`TextSizeRow.tsx`) steps it by 10 %. Headings, tables and code inside the note scale with it;
 * the UI around the note does not.
 *
 * Stored in the per-person option `tfTextScale` (`packages/trilium-core/src/tf/options.ts`), so it
 * follows the person to every device and never changes anyone else's view.
 */
import options from "../../services/options.js";
import { tfHaptic } from "../bridge.js";
import { scrollParentOf } from "./drag_visuals.js";
import { anchoredScrollTop, distance, midpoint, parseTextScale, pinchedTextScale, pinchFactor, snappedToOne, steppedTextScale } from "./gestures.js";

export const TEXT_SCALE_OPTION = "tfTextScale";
const SAVE_DELAY_MS = 400;
const PINCH_AREAS = ".note-detail-editable-text, .note-detail-readonly-text, .note-detail-code";
/** Content with its own pinch: images, drawings, maps. */
const OWN_PINCH = "img, .image-viewer, .excalidraw, .mind-map-container, .map-container, .relation-map-viewport, .drawing, .ck-widget.image";

type Listener = () => void;

let scale = 1;
let saveTimer = 0;
const listeners = new Set<Listener>();

export function getTextScale() {
    return scale;
}

export function subscribeTextScale(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Shows `next` at once and saves it after a short pause. */
export function setTextScale(next: number, { save = true } = {}) {
    const previous = scale;
    scale = next;
    applyTextScale(next);
    if (snappedToOne(previous, next)) {
        tfHaptic("light");
    }
    for (const listener of listeners) {
        listener();
    }
    if (save) {
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
            void options.save(TEXT_SCALE_OPTION as never, String(scale));
        }, SAVE_DELAY_MS);
    }
}

export function stepTextScale(direction: -1 | 1) {
    setTextScale(steppedTextScale(scale, direction));
}

export function applyTextScale(value: number, root: HTMLElement = document.documentElement) {
    root.style.setProperty("--tf-text-scale", String(value));
    root.classList.toggle("tf-text-scaled", value !== 1);
}

/** Reads the stored size and starts listening for pinches. */
export function installTextSize(isTouch: () => boolean) {
    scale = parseTextScale(options.get(TEXT_SCALE_OPTION as never));
    applyTextScale(scale);

    let pinch: { start: number; base: number; scroller: HTMLElement; last: number } | null = null;

    document.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 2 || !isTouch()) {
            pinch = null;
            return;
        }
        const [ a, b ] = [ e.touches[0], e.touches[1] ];
        const targets = [ a.target, b.target ].map((target) => target instanceof Element ? target : null);
        if (targets.some((target) => !target?.closest(PINCH_AREAS) || target.closest(OWN_PINCH))) {
            pinch = null;
            return;
        }
        pinch = {
            start: distance(pointOf(a), pointOf(b)),
            base: scale,
            scroller: scrollParentOf(targets[0]),
            last: scale
        };
    }, { capture: true, passive: true });

    document.addEventListener("touchmove", (e) => {
        if (!pinch || e.touches.length !== 2) {
            return;
        }
        e.preventDefault();
        const a = pointOf(e.touches[0]);
        const b = pointOf(e.touches[1]);
        const next = pinchedTextScale(pinch.base, pinchFactor(pinch.start, distance(a, b)));
        if (next === pinch.last) {
            return;
        }
        const scroller = pinch.scroller;
        const anchor = midpoint(a, b).y - scroller.getBoundingClientRect().top;
        const top = anchoredScrollTop(scroller.scrollTop, anchor, next / pinch.last);
        pinch.last = next;
        setTextScale(next);
        scroller.scrollTop = top;
    }, { capture: true, passive: false });

    const end = (e: TouchEvent) => {
        if (pinch && e.touches.length < 2) {
            pinch = null;
        }
    };
    document.addEventListener("touchend", end, { capture: true, passive: true });
    document.addEventListener("touchcancel", end, { capture: true, passive: true });
}

function pointOf(touch: Touch) {
    return { x: touch.clientX, y: touch.clientY };
}
