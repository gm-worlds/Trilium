/**
 * Keeps what is being typed in view as the visible area changes: after a host `viewport` message,
 * a resize of the frame (the host shrinks it for the on-screen keyboard, a rotation, split view) and
 * while typing, the caret or the focused field is scrolled above the keyboard and the floating
 * formatting toolbar. Also keeps each scroller's position through a rotation, where the content
 * reflows to another width.
 */
import { scrollParentOf } from "./drag_visuals.js";
import { TF_VIEWPORT_EVENT } from "../theme.js";

/** Room kept between the caret and the toolbar or keyboard above which it must stay. */
const CARET_MARGIN_PX = 16;
const SCROLLERS = ".scrolling-container, .mobile-navigator-scroll, .note-detail-printable, .options-section-container";

let keyboardInset = 0;
let frame = 0;

export function installKeyboardFollow() {
    window.addEventListener(TF_VIEWPORT_EVENT, (e) => {
        keyboardInset = Math.max(0, Number((e as CustomEvent<{ keyboardInset?: number }>).detail?.keyboardInset) || 0);
        scheduleReveal();
    });
    window.addEventListener("resize", scheduleReveal);
    window.visualViewport?.addEventListener("resize", scheduleReveal);
    document.addEventListener("focusin", (e) => {
        if (isTextField(e.target)) {
            // The keyboard opens after the focus; reveal once it has.
            setTimeout(scheduleReveal, 350);
        }
    });
    document.addEventListener("input", (e) => {
        if (isTextField(e.target)) {
            scheduleReveal();
        }
    }, true);
    installScrollKeeper();
}

function isTextField(target: EventTarget | null) {
    return target instanceof HTMLElement
        && (target.isContentEditable || target.matches("input:not([type=checkbox], [type=radio], [type=range]), textarea"));
}

function scheduleReveal() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => requestAnimationFrame(revealFocus));
}

/** The lowest visible y the caret may reach: above the keyboard and above a floating toolbar. */
export function visibleBottom() {
    let bottom = (window.visualViewport?.height ?? window.innerHeight) - keyboardInset;
    for (const toolbar of document.querySelectorAll<HTMLElement>(".mobile-editor-toolbar, .classic-toolbar-island")) {
        const rect = toolbar.getBoundingClientRect();
        if (rect.height > 0 && rect.top < bottom && rect.bottom > bottom - 160) {
            bottom = Math.min(bottom, rect.top);
        }
    }
    return bottom - CARET_MARGIN_PX;
}

function caretRect(): DOMRect | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return null;
    }
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    if (rects.length) {
        return rects[rects.length - 1];
    }
    const node = range.endContainer;
    const element = node instanceof Element ? node : node.parentElement;
    return element?.getBoundingClientRect() ?? null;
}

export function revealFocus() {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !isTextField(active)) {
        return;
    }
    const rect = active.isContentEditable ? caretRect() : active.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) {
        return;
    }
    const bottom = visibleBottom();
    const scroller = scrollParentOf(active.isContentEditable ? (caretAnchor() ?? active) : active);
    const top = Math.max(scroller.getBoundingClientRect().top, 0) + CARET_MARGIN_PX;
    const caretBottom = active.isContentEditable ? rect.bottom : Math.min(rect.bottom, rect.top + 48);
    if (caretBottom > bottom) {
        scroller.scrollTop += caretBottom - bottom;
    } else if (rect.top < top) {
        scroller.scrollTop -= top - rect.top;
    }
}

function caretAnchor() {
    const node = document.getSelection()?.focusNode;
    return node instanceof Element ? node : node?.parentElement ?? null;
}

/**
 * Keeps each scroller on the same content through a width change (a rotation reflows the content
 * to another height): the block at its top edge stays there, cut at the same share of its height,
 * or, without one, the same share of the scrollable height stays scrolled.
 */
function installScrollKeeper() {
    const kept = new WeakMap<Element, { share: number; anchor: Element | null; within: number }>();
    const pending = new Set<HTMLElement>();
    let frame = 0;
    let width = window.innerWidth;

    const record = () => {
        frame = 0;
        for (const scroller of pending) {
            const range = scroller.scrollHeight - scroller.clientHeight;
            const box = scroller.getBoundingClientRect();
            const anchor = anchorIn(scroller, box);
            kept.set(scroller, {
                share: range > 0 ? scroller.scrollTop / range : 0,
                anchor,
                within: anchor ? shareAbove(anchor.getBoundingClientRect(), box.top) : 0
            });
        }
        pending.clear();
    };

    document.addEventListener("scroll", (e) => {
        const target = e.target;
        if (target instanceof HTMLElement && target.matches(SCROLLERS)) {
            pending.add(target);
            frame ||= requestAnimationFrame(record);
        }
    }, { capture: true, passive: true });

    window.addEventListener("resize", () => {
        if (window.innerWidth === width) {
            return;
        }
        width = window.innerWidth;
        requestAnimationFrame(() => {
            for (const scroller of document.querySelectorAll<HTMLElement>(SCROLLERS)) {
                const state = kept.get(scroller);
                if (!state) {
                    continue;
                }
                if (state.anchor?.isConnected && scroller.contains(state.anchor)) {
                    const top = scroller.getBoundingClientRect().top;
                    const rect = state.anchor.getBoundingClientRect();
                    scroller.scrollTop += rect.top + state.within * rect.height - top;
                } else {
                    scroller.scrollTop = state.share * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                }
            }
            scheduleReveal();
        });
    });
}

/** How much of `rect`, as a share of its height, lies above `top`. */
function shareAbove(rect: DOMRect, top: number) {
    return rect.height > 0 ? Math.min(1, Math.max(0, (top - rect.top) / rect.height)) : 0;
}

/** The first block of note content below the top edge of `scroller`, else the element there. */
function anchorIn(scroller: HTMLElement, box: DOMRect) {
    const blocks = scroller.querySelector(".ck-content")?.children;
    if (blocks?.length) {
        let low = 0;
        let high = blocks.length - 1;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (blocks[middle].getBoundingClientRect().bottom > box.top) {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        return blocks[low];
    }
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
    return hit && hit !== scroller && scroller.contains(hit) ? hit : null;
}
