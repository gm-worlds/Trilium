/**
 * Note navigation inside the frame without browser history entries. A frame's `pushState()` adds
 * to the history of the whole tab, so the host page's Back button would step through notes before
 * it left the notebook. While embedded, `history.pushState()` becomes a `replaceState()` plus an
 * entry in a list of the frame's own, and `history.back()`, `forward()` and `go()` move through that
 * list and fire `hashchange`, which `app_context.ts` turns into the note switch it always did.
 * Trilium's back and forward buttons and their history menus (`HistoryNavigation.tsx`) read the
 * same list through {@link getTfHistoryEntries}.
 *
 * Installed by `maybeStartTf()` as soon as the page runs in a frame, so the first navigations are
 * kept too, and removed again when the engine turns out not to be embedded.
 */

interface Original {
    pushState: History["pushState"];
    replaceState: History["replaceState"];
    back: History["back"];
    forward: History["forward"];
    go: History["go"];
}

let original: Original | null = null;
let entries: string[] = [];
let index = 0;

export function installTfHistory(target: Window = window) {
    if (original) {
        return;
    }
    const history = target.history;
    original = {
        pushState: history.pushState,
        replaceState: history.replaceState,
        back: history.back,
        forward: history.forward,
        go: history.go
    };
    const replace = original.replaceState.bind(history);
    const absolute = (url: string | URL | null | undefined) => new URL(String(url ?? target.location.href), target.location.href).href;
    entries = [ target.location.href ];
    index = 0;

    history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
        entries.splice(index + 1);
        entries.push(absolute(url));
        index = entries.length - 1;
        replace(data, unused, url);
    };
    history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
        if (url !== undefined && url !== null) {
            entries[index] = absolute(url);
        }
        replace(data, unused, url);
    };
    history.go = (delta = 0) => goTo(target, replace, index + delta);
    history.back = () => goTo(target, replace, index - 1);
    history.forward = () => goTo(target, replace, index + 1);
}

/** Restores the browser's own history methods. */
export function uninstallTfHistory(target: Window = window) {
    if (!original) {
        return;
    }
    Object.assign(target.history, original);
    original = null;
    entries = [];
    index = 0;
}

function goTo(target: Window, replace: History["replaceState"], next: number) {
    if (next < 0 || next >= entries.length || next === index) {
        return;
    }
    const oldURL = target.location.href;
    index = next;
    replace(null, "", entries[index]);
    target.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: entries[index] }));
}

/**
 * The entries Trilium's back (`back`) or forward button leads to, nearest first, or `null` when the
 * frame's own list is not in use.
 */
export function getTfHistoryEntries(direction: "back" | "forward"): { url: string; go: () => void }[] | null {
    if (!original) {
        return null;
    }
    const list = entries.map((url, i) => ({ url, go: () => window.history.go(i - index) }));
    return direction === "back" ? list.slice(0, index).reverse() : list.slice(index + 1);
}

/** The frame's own list, for tests. */
export function getTfHistoryState() {
    return { entries: [ ...entries ], index };
}
