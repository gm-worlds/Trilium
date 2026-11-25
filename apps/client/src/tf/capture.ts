/**
 * Keeps two kinds of input inside Taskforce rather than the frame: links to Taskforce itself, and
 * the shortcuts the host owns (`init.shortcuts`).
 */

export interface TfShortcut {
    key: string;
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
}

/** Sends clicks on links into Taskforce (`open`) instead of navigating the frame. */
export function installLinkCapture(parentOrigins: string[], open: (href: string) => void, target: Window = window) {
    const handler = (event: MouseEvent) => {
        if (event.defaultPrevented || (event.type === "click" && event.button !== 0)) {
            return;
        }
        const anchor = (event.target as Element | null)?.closest?.("a[href]");
        const rawHref = anchor?.getAttribute("href");
        if (!rawHref) {
            return;
        }

        let href: string;
        try {
            href = new URL(rawHref, target.location.href).href;
        } catch {
            return;
        }
        if (!parentOrigins.some((origin) => href === origin || href.startsWith(`${origin}/`))) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        open(href);
    };
    target.addEventListener("click", handler, true);
    target.addEventListener("auxclick", handler, true);
    return () => {
        target.removeEventListener("click", handler, true);
        target.removeEventListener("auxclick", handler, true);
    };
}

/** Forwards the host's shortcuts (`init.shortcuts`) instead of letting the notebook handle them. */
export function installShortcutCapture(
    getShortcuts: () => TfShortcut[],
    forward: (shortcut: Required<TfShortcut>) => void,
    target: Window = window
) {
    const handler = (event: KeyboardEvent) => {
        const match = getShortcuts().find((shortcut) => matchesShortcut(event, shortcut));
        if (!match) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        forward({ key: match.key, meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey });
    };
    target.addEventListener("keydown", handler, true);
    return () => target.removeEventListener("keydown", handler, true);
}

export function matchesShortcut(event: KeyboardEvent, shortcut: TfShortcut) {
    return typeof shortcut?.key === "string"
        && event.key.toLowerCase() === shortcut.key.toLowerCase()
        && event.metaKey === !!shortcut.meta
        && event.ctrlKey === !!shortcut.ctrl
        && event.shiftKey === !!shortcut.shift
        && event.altKey === !!shortcut.alt;
}
