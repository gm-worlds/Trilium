import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIFT_DELAY_MS } from "./gestures.js";
import { installImageGestures } from "./image_gestures.js";
import { installNavigatorDrag } from "./navigator_drag.js";
import { asContainer } from "./navigator_row_tools.js";
import { installPressFeedback } from "./press.js";
import { installTextSize } from "./text_size.js";
import { GestureListeners, listenModeFor, lockScroll, swallowNextClick } from "./touch_session.js";
import { installTreeDrag } from "./tree_drag.js";

type Registered = { target: string; type: string; passive: boolean };

/** Every touch listener added to `window` or `document` from now on, and whether it is passive. */
function recordTouchListeners() {
    const live = new Map<unknown, Registered>();
    const ever: Registered[] = [];
    for (const [ name, target ] of [ [ "window", window ], [ "document", document ] ] as const) {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        vi.spyOn(target, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
            if (type.startsWith("touch") && listener) {
                const entry = { target: name, type, passive: typeof options === "object" && !!options.passive };
                ever.push(entry);
                live.set(listener, entry);
            }
            add(type, listener, options);
        });
        vi.spyOn(target, "removeEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
            if (type.startsWith("touch")) {
                live.delete(listener);
            }
            remove(type, listener, options);
        });
    }
    return { live: () => [ ...live.values() ], ever };
}

function touch(type: string, target: Element, x: number, y: number, end = false) {
    const point = new Touch({ identifier: 1, target, clientX: x, clientY: y });
    target.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: end ? [] : [ point ],
        changedTouches: [ point ]
    }));
}

function navigatorRow() {
    document.body.innerHTML = `
        <div class="mobile-navigator-scroll">
            <div class="mobile-navigator-list">
                <div class="mobile-navigator-row">
                    <span class="mobile-navigator-title-group"><span class="mobile-navigator-row-title">Launch plan</span></span>
                    <span class="tf-row-tools" data-note-id="n1" data-parent-note-id="p1" data-note-path="root/p1/n1"></span>
                </div>
            </div>
        </div>`;
    const row = document.querySelector<HTMLElement>(".mobile-navigator-row");
    if (!row) throw new Error("no row");
    return row;
}

describe("touch listeners of a gesture", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("listen passively while pressed and block only once the gesture owns the finger", () => {
        expect([ listenModeFor("idle"), listenModeFor("pressed"), listenModeFor("owned") ]).toEqual([ "none", "watch", "block" ]);

        const recorded = recordTouchListeners();
        const listeners = new GestureListeners({ move: () => {}, end: () => {} });
        listeners.set("watch");
        expect(recorded.live()).toEqual([
            { target: "window", type: "touchmove", passive: true },
            { target: "window", type: "touchend", passive: true }
        ]);
        listeners.set("block");
        expect(recorded.live().map((l) => l.passive)).toEqual([ false, false ]);
        listeners.set("none");
        expect(recorded.live()).toEqual([]);
    });

    it("never block a scroll over the navigator, and block a lifted row until it drops", () => {
        const recorded = recordTouchListeners();
        installNavigatorDrag(() => true);
        const row = navigatorRow();

        // A plain scroll: the finger moves away before the lift.
        touch("touchstart", row, 100, 100);
        touch("touchmove", row, 100, 140);
        touch("touchend", row, 100, 140, true);
        vi.advanceTimersByTime(LIFT_DELAY_MS * 2);
        expect(recorded.ever.filter((l) => !l.passive)).toEqual([]);
        expect(recorded.live().filter((l) => l.type !== "touchstart")).toEqual([]);

        // A hold lifts the row: now the moves can be cancelled and the list is locked.
        touch("touchstart", row, 100, 100);
        vi.advanceTimersByTime(LIFT_DELAY_MS + 10);
        expect(recorded.live().filter((l) => !l.passive).map((l) => l.type).sort()).toEqual([ "touchcancel", "touchend", "touchmove" ]);
        const scroller = document.querySelector(".mobile-navigator-scroll");
        expect(scroller?.classList.contains("tf-gesture-lock")).toBe(true);

        touch("touchend", row, 100, 100, true);
        expect(recorded.live().filter((l) => l.type !== "touchstart")).toEqual([]);
        expect(scroller?.classList.contains("tf-gesture-lock")).toBe(false);
    });

    it("never block a scroll or a pinch over the tree, a toolbar, an image or a table", () => {
        const recorded = recordTouchListeners();
        installTreeDrag(() => true);
        installPressFeedback(() => true);
        installTextSize(() => true);
        installImageGestures(() => true);
        document.body.innerHTML = `
            <div class="tree-wrapper"><span class="fancytree-node"><span class="fancytree-title">Plan</span></span></div>
            <div class="ck-toolbar"><button class="ck-button">Bold</button></div>
            <div class="scrolling-container"><div class="note-detail-editable-text"><div class="ck-content">
                <p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></p>
                <table><tbody><tr><td>Cell</td></tr></tbody></table>
            </div></div></div>`;
        const [ node, button, image, cell ] = [ ".fancytree-node", ".ck-button", "img", "td" ].map((selector) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(selector);
            return element;
        });

        for (const target of [ node, button, image, cell ]) {
            touch("touchstart", target, 50, 50);
            touch("touchmove", target, 50, 90);
            touch("touchend", target, 50, 90, true);
        }
        for (const target of [ image, cell ]) {
            const fingers = [ new Touch({ identifier: 1, target, clientX: 40, clientY: 40 }), new Touch({ identifier: 2, target, clientX: 80, clientY: 80 }) ];
            target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: fingers, changedTouches: fingers }));
            target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: fingers, changedTouches: fingers }));
            target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: fingers }));
        }
        vi.advanceTimersByTime(1000);
        expect(recorded.ever.filter((l) => !l.passive)).toEqual([]);
        expect(recorded.ever.length).toBeGreaterThan(4);
    });

    it("lock a scroller and release it, but never the page itself", () => {
        const scroller = document.createElement("div");
        const unlock = lockScroll(scroller);
        expect(scroller.classList.contains("tf-gesture-lock")).toBe(true);
        unlock();
        expect(scroller.classList.contains("tf-gesture-lock")).toBe(false);
        lockScroll(document.documentElement);
        expect(document.documentElement.classList.contains("tf-gesture-lock")).toBe(false);
    });

    it("let clicks dispatched by code pass the swallower, which ends on its own", () => {
        const button = document.createElement("button");
        document.body.append(button);
        const clicked = vi.fn();
        button.addEventListener("click", clicked);
        swallowNextClick();
        button.click();
        expect(clicked).toHaveBeenCalledTimes(1);
        const removed = vi.spyOn(window, "removeEventListener");
        vi.advanceTimersByTime(1000);
        expect(removed.mock.calls.map(([ type ]) => type)).toContain("click");
    });
});

describe("navigator rows for assistive technology", () => {
    it("turn the row into a container whose open button is named after the note", () => {
        const row = navigatorRow();
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        row.classList.add("is-pending");
        const open = document.createElement("button");
        row.prepend(open);

        asContainer(row, open, [ ":scope > .mobile-navigator-title-group", ":scope > .tf-slot" ]);

        expect(row.hasAttribute("role")).toBe(false);
        expect(row.hasAttribute("tabindex")).toBe(false);
        const title = row.querySelector(".mobile-navigator-title-group");
        expect(title?.getAttribute("aria-hidden")).toBe("true");
        expect(open.getAttribute("aria-labelledby")).toBe(title?.id);
        expect(open.disabled).toBe(true);
    });
});
