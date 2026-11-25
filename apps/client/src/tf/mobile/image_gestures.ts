/**
 * Images inside text notes on touch: a double tap or a two-finger pinch on an image opens it in the
 * image viewer (`showLightbox`), where pinch and pan zoom and a double tap toggles the zoom
 * (`ImageViewer.tsx`). Text-note pinches elsewhere keep changing the reading size (`text_size.ts`).
 *
 * In the viewer, react-zoom-pan-pinch spots a double tap on its own `touchstart`, and the `touchend`
 * that follows cuts its zoom animation short. So the second tap of a double tap never reaches it;
 * it gets the `dblclick` it handles for a mouse instead, at the finger's position.
 */
import appContext from "../../components/app_context.js";
import { distance, type Point } from "./gestures.js";

const CONTENT_IMAGE = ".ck-content img";
const VIEWER = ".image-viewer-root";
/** Longest gap between the two taps of a double tap, and how far apart they can land. */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_PX = 30;
/** A tap that moves further than this, or lasts longer than this, is no tap. */
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 350;

export function installImageGestures(isTouch: () => boolean) {
    type Tap = { target: Element; image: HTMLImageElement | null; at: Point; time: number };
    let down: Tap | null = null;
    let lastTap: Tap | null = null;
    let second = false;

    const isSecondTap = (tap: Tap, time: number) => !!lastTap && lastTap.target === tap.target
        && time - lastTap.time <= DOUBLE_TAP_MS && distance(lastTap.at, tap.at) <= DOUBLE_TAP_PX;

    document.addEventListener("touchstart", (e) => {
        if (!isTouch()) {
            return;
        }
        down = null;
        second = false;
        if (e.touches.length === 2) {
            const images = [ e.touches[0], e.touches[1] ].map((t) => imageAt(t.target));
            const image = images[0] ?? images[1];
            if (image) {
                openViewer(image);
            }
            return;
        }
        const element = e.target instanceof Element ? e.target : null;
        const image = imageAt(element);
        const viewer = element?.closest(VIEWER) ?? null;
        if (e.touches.length !== 1 || (!image && !viewer)) {
            return;
        }
        down = { target: image ?? viewer ?? document.body, image, at: pointOf(e.touches[0]), time: e.timeStamp };
        if (viewer && isSecondTap(down, e.timeStamp)) {
            second = true;
            e.stopPropagation();
        }
    }, { capture: true, passive: true });

    document.addEventListener("touchend", (e) => {
        const start = down;
        const wasSecond = second;
        down = null;
        second = false;
        const touch = e.changedTouches[0];
        if (!start || !touch || e.touches.length) {
            return;
        }
        const at = pointOf(touch);
        if (distance(start.at, at) > TAP_SLOP_PX || e.timeStamp - start.time > TAP_MAX_MS) {
            lastTap = null;
            return;
        }
        const tap = { ...start, at, time: e.timeStamp };
        if (!wasSecond && !isSecondTap(tap, e.timeStamp)) {
            lastTap = tap;
            return;
        }
        lastTap = null;
        e.preventDefault();
        if (start.image) {
            openViewer(start.image);
        } else {
            e.stopPropagation();
            const target = document.elementFromPoint(at.x, at.y) ?? start.target;
            target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
        }
    }, { capture: true, passive: false });
}

function pointOf(touch: Touch): Point {
    return { x: touch.clientX, y: touch.clientY };
}

function imageAt(target: EventTarget | null) {
    return target instanceof Element ? target.closest<HTMLImageElement>(CONTENT_IMAGE) : null;
}

function openViewer(image: HTMLImageElement) {
    const src = image.currentSrc || image.src;
    if (!src || document.querySelector(".lightbox-dialog.show")) {
        return;
    }
    void appContext.triggerEvent("showLightbox", { src, title: image.alt || undefined });
}
