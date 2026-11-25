/**
 * What a touch gesture holds only while it runs, so a plain scroll never waits for a listener:
 * every `touchstart` listener of the touch layer is passive, and `touchmove`, `touchend` and
 * `touchcancel` are attached once a press starts (passive, to watch for the finger moving off) and
 * made blocking only once the gesture owns the finger (a row lifted, a toolbar picker shown).
 *
 * A listener added during a touch does not reach every browser in time: WebKit decides at
 * `touchstart` whether the sequence's moves can be cancelled. So a gesture that owns the finger
 * also locks its scroller (`lockScroll()`, `overflow: hidden`), and the click a finger lifted
 * after a gesture would still produce is swallowed (`swallowNextClick()`).
 */

/** How a gesture listens in each of its phases. */
export type ListenMode = "none" | "watch" | "block";

export type TouchPhase = "idle" | "pressed" | "owned";

/** The listening a phase needs: nothing while idle, passive while pressed, blocking once owned. */
export function listenModeFor(phase: TouchPhase): ListenMode {
    return phase === "idle" ? "none" : phase === "pressed" ? "watch" : "block";
}

/** Options for a listener in `mode`; only `block` can cancel the browser's scrolling. */
export function listenerOptions(mode: Exclude<ListenMode, "none">): AddEventListenerOptions {
    return { capture: true, passive: mode === "watch" };
}

export interface TouchHandlers {
    move?: (e: TouchEvent) => void;
    end?: (e: TouchEvent) => void;
    cancel?: (e: TouchEvent) => void;
}

/**
 * The `touchmove`, `touchend` and `touchcancel` listeners of one gesture, on `window` in the
 * capture phase, so they run before any listener on `document`.
 */
export class GestureListeners {
    private mode: ListenMode = "none";
    private readonly bound: [ string, EventListener ][];

    constructor(handlers: TouchHandlers) {
        this.bound = [];
        if (handlers.move) this.bound.push([ "touchmove", handlers.move as EventListener ]);
        if (handlers.end) this.bound.push([ "touchend", handlers.end as EventListener ]);
        if (handlers.cancel) this.bound.push([ "touchcancel", handlers.cancel as EventListener ]);
    }

    get current() {
        return this.mode;
    }

    set(mode: ListenMode) {
        if (mode === this.mode) {
            return;
        }
        this.detach();
        this.mode = mode;
        if (mode === "none") {
            return;
        }
        const options = listenerOptions(mode);
        for (const [ type, listener ] of this.bound) {
            window.addEventListener(type, listener, options);
        }
    }

    private detach() {
        if (this.mode === "none") {
            return;
        }
        for (const [ type, listener ] of this.bound) {
            window.removeEventListener(type, listener, { capture: true });
        }
        this.mode = "none";
    }
}

const LOCKED = "tf-gesture-lock";

/** Stops `scroller` from scrolling under the finger; programmatic scrolling still works. */
export function lockScroll(scroller: HTMLElement | null) {
    if (!scroller || scroller === document.scrollingElement || scroller === document.documentElement) {
        return () => {};
    }
    scroller.classList.add(LOCKED);
    return () => scroller.classList.remove(LOCKED);
}

/** Cancels a `touchmove` when the browser still lets it, without the console warning it gives otherwise. */
export function preventIfCancelable(e: Event) {
    if (e.cancelable) {
        e.preventDefault();
    }
}

const SWALLOW_MS = 700;
let disarm: (() => void) | null = null;

/** What a double tap still makes after its `touchend`: the mouse events a tap is mirrored as. */
const DOUBLE_TAP_EVENTS = [ "mousedown", "mouseup", "click", "dblclick" ];

/**
 * Drops the browser's next `click` within {@link SWALLOW_MS}: the one a finger lifted after a lift
 * or a pick still produces where it first touched. With `doubleClick` it drops every mouse event a
 * double tap is mirrored as until the timer ends (a passive `touchend` cannot cancel them, and a
 * `mousedown` would stop the image viewer's zoom). Events dispatched by code pass. A new touch
 * disarms it.
 */
export function swallowNextClick({ doubleClick = false } = {}) {
    disarm?.();
    const types = doubleClick ? DOUBLE_TAP_EVENTS : [ "click" ];
    const onEvent = (e: Event) => {
        if (!e.isTrusted) {
            return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!doubleClick) {
            stop();
        }
    };
    const timer = window.setTimeout(() => stop(), SWALLOW_MS);
    const stop = () => {
        window.clearTimeout(timer);
        for (const type of types) {
            window.removeEventListener(type, onEvent, true);
        }
        window.removeEventListener("touchstart", stop, true);
        if (disarm === stop) {
            disarm = null;
        }
    };
    for (const type of types) {
        window.addEventListener(type, onEvent, true);
    }
    window.addEventListener("touchstart", stop, { capture: true, passive: true });
    disarm = stop;
}
