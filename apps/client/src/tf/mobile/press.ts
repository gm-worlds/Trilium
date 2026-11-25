/**
 * Press feedback on touch. Every tappable control takes `.tf-pressed` on touch down, so the pressed
 * look shows within a frame and leaves when the finger lifts, slides off or the page scrolls; the
 * click itself stays the browser's, on release.
 *
 * Dense rows (`DENSE_ROWS`: the formatting toolbar above the keyboard, its sub-toolbars and the
 * launch bar) add a press preview like the iPhone keyboard's key pop: a finger that rests for
 * `PRESS_PREVIEW_DELAY_MS` shows the button's name above the finger, sliding moves the highlight
 * and the name to the button under the finger, lifting activates that button, and sliding more
 * than `PRESS_CANCEL_PX` away from the row cancels. A finger that moves past `PRESS_SLOP_PX`
 * before the delay scrolls the row, or swipes the tabs on the launch bar, as usual.
 */
import "./press.css";

import { tfHaptic } from "../bridge.js";
import { type Box, movedBeyond, PRESS_PREVIEW_DELAY_MS, PRESS_SLOP_PX, pickedIndex, type Point } from "./gestures.js";

export const TAPPABLE = [
    "button", "a[href]", "summary", "[role='button']", "[role='menuitem']", "[role='tab']", "[role='option']",
    ".icon-action", ".launcher-button", ".tn-tool-button", ".ck-button", ".dropdown-item",
    ".mobile-navigator-row", ".fancytree-node", ".tab-row-widget .note-tab"
].join(", ");

export const DENSE_ROWS = ".ck-toolbar, [role='toolbar'], #launcher-pane";
const ROW_BUTTONS = ".ck-button, button, .launcher-button, [role='button']";
const PRESSED = "tf-pressed";
/** The keyboard shortcut CKEditor appends to a tooltip, such as " (⌘Z)" or " (Ctrl+Shift+X)". */
const SHORTCUT_SUFFIX = /\s*\((?:[⌘⌥⇧⌃]|Ctrl|Alt|Shift|Cmd)[^)]*\)\s*$/;

export function installPressFeedback(isTouch: () => boolean) {
    let pressed: Element | null = null;
    const setPressed = (element: Element | null) => {
        if (element === pressed) {
            return;
        }
        pressed?.classList.remove(PRESSED);
        pressed = element;
        pressed?.classList.add(PRESSED);
    };

    document.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch" || !isTouch() || !e.isPrimary || !(e.target instanceof Element)) {
            return;
        }
        const target = e.target.closest(TAPPABLE);
        setPressed(target && !isDisabled(target) ? target : null);
    }, true);
    const release = (e: PointerEvent) => {
        if (e.pointerType === "touch" && !picker.active) {
            setPressed(null);
        }
    };
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    document.addEventListener("scroll", () => {
        if (!picker.active) {
            setPressed(null);
        }
    }, true);

    const picker = new RowPicker(setPressed);
    document.addEventListener("touchstart", (e) => picker.start(e, isTouch()), { capture: true, passive: true });
    document.addEventListener("touchmove", (e) => picker.move(e), { capture: true, passive: false });
    document.addEventListener("touchend", (e) => picker.end(e), { capture: true, passive: false });
    document.addEventListener("touchcancel", () => picker.cancel(), true);
    // While picking, the launch bar's tab swipe and the edge swipe of the tree see no movement.
    document.addEventListener("pointermove", (e) => {
        if (picker.active && e.pointerType === "touch") {
            e.stopPropagation();
        }
    }, true);
    document.addEventListener("contextmenu", (e) => {
        if (!picker.active) {
            return;
        }
        // The formatting toolbar has no menus of its own; elsewhere a held button opens its menu.
        if (picker.inEditorToolbar()) {
            e.preventDefault();
        } else {
            picker.cancel();
        }
    }, true);
}

/** The slide-to-pick gesture on one dense row. */
class RowPicker {
    active = false;
    private row: Element | null = null;
    private buttons: Element[] = [];
    private current: Element | null = null;
    private start0: Point = { x: 0, y: 0 };
    private last: Point = { x: 0, y: 0 };
    private timer: number | undefined;
    private label: HTMLElement | null = null;

    constructor(private readonly setPressed: (element: Element | null) => void) {}

    start(e: TouchEvent, touch: boolean) {
        this.cancel();
        if (!touch || e.touches.length !== 1 || !(e.target instanceof Element)) {
            return;
        }
        const button = e.target.closest(ROW_BUTTONS);
        const row = button?.closest(DENSE_ROWS);
        if (!button || !row || isDisabled(button)) {
            return;
        }
        this.row = row;
        this.current = button;
        this.start0 = this.last = pointOf(e.touches[0]);
        this.timer = window.setTimeout(() => this.enter(), PRESS_PREVIEW_DELAY_MS);
    }

    move(e: TouchEvent) {
        if (!this.row) {
            return;
        }
        if (e.touches.length !== 1) {
            this.cancel();
            return;
        }
        this.last = pointOf(e.touches[0]);
        if (!this.active) {
            if (movedBeyond(this.start0, this.last, PRESS_SLOP_PX)) {
                // A quick drag: the row scrolls and the press ends.
                this.cancel();
                this.setPressed(null);
            }
            return;
        }
        e.stopPropagation();
        if (e.cancelable) {
            e.preventDefault();
        }
        const index = pickedIndex(this.last, boxOf(this.row), this.buttons.map(boxOf));
        this.highlight(index < 0 ? null : this.buttons[index]);
    }

    inEditorToolbar() {
        return !!this.row?.matches(".ck-toolbar");
    }

    end(e: TouchEvent) {
        if (!this.active || document.body.classList.contains("context-menu-shown")) {
            this.cancel();
            return;
        }
        // The browser's own click would land on the button the finger first touched.
        if (e.cancelable) {
            e.preventDefault();
        }
        const chosen = this.current;
        this.cancel();
        this.setPressed(null);
        if (chosen instanceof HTMLElement && !isDisabled(chosen)) {
            chosen.click();
        }
    }

    cancel() {
        window.clearTimeout(this.timer);
        this.timer = undefined;
        if (this.active) {
            this.setPressed(null);
        }
        this.active = false;
        this.row = null;
        this.buttons = [];
        this.current = null;
        this.label?.remove();
        this.label = null;
    }

    private enter() {
        const row = this.row;
        if (!row || !this.current) {
            return;
        }
        this.active = true;
        this.buttons = [ ...row.querySelectorAll(ROW_BUTTONS) ].filter((button) =>
            button.closest(DENSE_ROWS) === row && !isDisabled(button) && isShown(button));
        const first = this.current;
        this.current = null;
        this.highlight(first);
    }

    private highlight(button: Element | null) {
        if (button === this.current) {
            return;
        }
        const changed = this.current !== null || button !== null;
        this.current = button;
        this.setPressed(button);
        if (!button) {
            this.label?.remove();
            this.label = null;
            return;
        }
        this.showLabel(button);
        if (changed) {
            tfHaptic("light");
        }
    }

    private showLabel(button: Element) {
        const text = labelOf(button);
        if (!text) {
            this.label?.remove();
            this.label = null;
            return;
        }
        if (!this.label) {
            this.label = document.createElement("div");
            this.label.className = "tf-press-label";
            this.label.setAttribute("aria-hidden", "true");
            document.body.appendChild(this.label);
        }
        const label = this.label;
        label.textContent = text;
        const rect = button.getBoundingClientRect();
        const width = label.offsetWidth;
        const height = label.offsetHeight;
        const gap = 10;
        const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
        // Always above the finger, even when that crosses the top of the button's row.
        const top = Math.max(4, Math.min(rect.top, this.last.y - 24) - gap - height);
        label.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
        label.classList.remove("tf-press-label-in");
        void label.offsetWidth;
        label.classList.add("tf-press-label-in");
    }
}

/** The name a button's tooltip or label carries. */
export function labelOf(button: Element) {
    const direct = button.getAttribute("aria-label")
        ?? button.getAttribute("data-cke-tooltip-text")
        ?? button.getAttribute("data-bs-original-title")
        ?? button.getAttribute("title");
    if (direct?.trim()) {
        return direct.replace(SHORTCUT_SUFFIX, "").trim();
    }
    const labelledBy = button.getAttribute("aria-labelledby");
    const byId = labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : "";
    return byId || button.querySelector(".ck-button__label")?.textContent?.trim() || button.textContent?.trim() || "";
}

function isDisabled(element: Element) {
    return element.matches(":disabled, [aria-disabled='true'], .ck-disabled, .disabled");
}

function isShown(element: Element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function pointOf(touch: Touch): Point {
    return { x: touch.clientX, y: touch.clientY };
}

function boxOf(element: Element): Box {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { left, top, right, bottom };
}
