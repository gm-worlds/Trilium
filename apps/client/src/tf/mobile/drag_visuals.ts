/**
 * What a touch drag draws: the lifted copy that follows the finger, the insertion line between
 * rows or blocks, and the scrolling of a list while the finger rests near its top or bottom edge.
 * Used by `navigator_drag.ts`, `tree_drag.ts` and `block_handle.ts`; styles in `drag.css`.
 */
import "./drag.css";

import { autoScrollSpeed } from "./gestures.js";

export class DragGhost {
    private readonly element: HTMLElement;
    private offsetX = 0;
    private offsetY = 0;

    /** Copies `source` into a lifted ghost under the finger at `(x, y)`. */
    constructor(source: HTMLElement, x: number, y: number, className = "") {
        const rect = source.getBoundingClientRect();
        const ghost = source.cloneNode(true) as HTMLElement;
        ghost.removeAttribute("id");
        for (const withId of ghost.querySelectorAll("[id]")) {
            withId.removeAttribute("id");
        }
        const wrapper = document.createElement("div");
        wrapper.className = `tf-drag-ghost ${className}`.trim();
        wrapper.setAttribute("aria-hidden", "true");
        wrapper.style.width = `${rect.width}px`;
        wrapper.append(ghost);
        document.body.append(wrapper);
        this.element = wrapper;
        this.offsetX = x - rect.left;
        this.offsetY = y - rect.top;
        this.moveTo(x, y);
        requestAnimationFrame(() => wrapper.classList.add("is-lifted"));
    }

    moveTo(x: number, y: number) {
        this.element.style.translate = `${Math.round(x - this.offsetX)}px ${Math.round(y - this.offsetY)}px`;
    }

    remove() {
        this.element.remove();
    }
}

/** A horizontal line drawn between two rows or blocks, inside `container`'s visible box. */
export class InsertionLine {
    private readonly element: HTMLElement;

    constructor() {
        this.element = document.createElement("div");
        this.element.className = "tf-insertion-line";
        this.element.setAttribute("aria-hidden", "true");
        document.body.append(this.element);
    }

    /** Shows the line at viewport `y` from `left` to `right`, or hides it for `null`. */
    show(at: { y: number; left: number; right: number } | null) {
        if (!at) {
            this.element.classList.remove("is-shown");
            return;
        }
        this.element.style.translate = `${Math.round(at.left)}px ${Math.round(at.y - 1)}px`;
        this.element.style.width = `${Math.max(0, Math.round(at.right - at.left))}px`;
        this.element.classList.add("is-shown");
    }

    remove() {
        this.element.remove();
    }
}

/**
 * Scrolls `scroller` while the finger is in its top or bottom edge band. `onScroll` runs after each
 * step, so the caller can aim again at what moved under the finger.
 */
export class AutoScroller {
    private frame = 0;
    private y = 0;

    constructor(private readonly scroller: HTMLElement, private readonly onScroll: () => void) {}

    update(y: number) {
        this.y = y;
        if (!this.frame) {
            this.frame = requestAnimationFrame(this.step);
        }
    }

    stop() {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
    }

    private readonly step = () => {
        this.frame = 0;
        const rect = this.scroller.getBoundingClientRect();
        const top = Math.max(rect.top, 0);
        const bottom = Math.min(rect.bottom, window.innerHeight);
        const speed = autoScrollSpeed(this.y, top, bottom);
        if (!speed) {
            return;
        }
        const before = this.scroller.scrollTop;
        this.scroller.scrollTop = before + speed;
        if (this.scroller.scrollTop !== before) {
            this.onScroll();
        }
        this.frame = requestAnimationFrame(this.step);
    };
}

/** The nearest ancestor of `element` that scrolls vertically, or the document's scroller. */
export function scrollParentOf(element: Element | null): HTMLElement {
    for (let el = element?.parentElement ?? null; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
            return el;
        }
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
