/**
 * The controls of the phone navigator's rows, mounted by `// tf:` hooks in `MobileNoteNavigator`.
 *
 * Upstream's row and current-note tile are `div role="button"` with buttons inside, which assistive
 * technology cannot reach. Inside Taskforce the row becomes a plain container (`asContainer()`),
 * and its controls are siblings, in this focus order: an open button over the title area, named
 * after the note, then add (tile only) and More, each naming the note too. The open button ends
 * {@link OPEN_GAP_PX} before the first of those (`placeOpenButton()`), so no two hit areas overlap;
 * the chevron and the counts are decoration. The open button's click bubbles to the row's own
 * `onClick`, so opening and drilling in stay upstream's.
 *
 * Each row also carries the ids `navigator_drag.ts` reads to move it. Renders nothing outside
 * Taskforce.
 */
import "./navigator_row_tools.css";

import { useLayoutEffect, useRef } from "preact/hooks";

import { t } from "../../services/i18n.js";
import ActionButton from "../../widgets/react/ActionButton.js";
import { useTfBootstrap } from "../components.js";
import { openRowMenu } from "./navigator_drag.js";

const ROW = ".mobile-navigator-row";
const TILE = ".mobile-navigator-current-tile";
/** Parts of a row that only show what a tap on the row does; `navigator_row_tools.css` lets taps through. */
const DECORATION = ":scope > :is(.mobile-navigator-row-chevron, .mobile-navigator-row-count, .mobile-navigator-row-hidden-badge)";
/** The tile's "Open" label on a phone, which only shows what a tap on the tile does. */
const TILE_DECORATION = ".mobile-navigator-current-open";
/** Room between the open button's hit area and the next control's, as between other touch targets. */
export const OPEN_GAP_PX = 8;

export function TfNavigatorRowTools({ noteId, parentNoteId, notePath, title }: {
    noteId: string;
    parentNoteId: string | undefined;
    notePath: string;
    title?: string;
}) {
    const bootstrap = useTfBootstrap();
    const openRef = useRef<HTMLButtonElement>(null);
    const name = title || t("tf.untitled");

    useLayoutEffect(() => {
        const open = openRef.current;
        const row = open?.closest<HTMLElement>(ROW);
        if (!open || !row) {
            return;
        }
        asContainer(row, open, [ ":scope > .mobile-navigator-title-group", ":scope > .tf-slot" ]);
        for (const decoration of row.querySelectorAll(DECORATION)) {
            decoration.setAttribute("aria-hidden", "true");
        }
        return placeOpenButton(open, () => row.querySelector(":scope > .tf-row-tools .tf-row-more"));
    });

    if (!bootstrap || !parentNoteId) {
        return null;
    }

    return (
        <>
            <button ref={openRef} type="button" className="tf-row-open" />
            <span className="tf-row-tools" data-note-id={noteId} data-parent-note-id={parentNoteId} data-note-path={notePath}>
                <ActionButton
                    className="tf-row-more"
                    icon="bx bx-dots-horizontal-rounded"
                    text={t("tf.row_more", { title: name })}
                    noTooltipOnTouch
                    onClick={(e) => {
                        e.stopPropagation();
                        const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(ROW);
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        if (row) {
                            openRowMenu(row, { x: rect.left + rect.width / 2, y: rect.bottom });
                        }
                    }}
                />
            </span>
        </>
    );
}

/**
 * The open button of the navigator's current-note tile, placed right after its title, so the tile's
 * add and More buttons follow it; both get names that include the note's title.
 */
export function TfNavigatorTileTools({ title }: { title?: string }) {
    const bootstrap = useTfBootstrap();
    const openRef = useRef<HTMLButtonElement>(null);
    const name = title || t("tf.untitled");

    useLayoutEffect(() => {
        const open = openRef.current;
        const tile = open?.closest<HTMLElement>(TILE);
        if (!open || !tile) {
            return;
        }
        asContainer(tile, open, [ ".mobile-navigator-current-header > .mobile-navigator-title-group" ]);
        const [ add, more ] = tile.querySelectorAll<HTMLElement>(".mobile-navigator-current-header > .mobile-navigator-current-action");
        add?.setAttribute("aria-label", t("tf.add_note_in", { title: name }));
        more?.setAttribute("aria-label", t("tf.row_more", { title: name }));
        tile.querySelector(TILE_DECORATION)?.setAttribute("aria-hidden", "true");
        return placeOpenButton(open, () => open.parentElement?.querySelector(":scope > .mobile-navigator-current-action") ?? null);
    });

    return bootstrap ? <button ref={openRef} type="button" className="tf-row-open" /> : null;
}

const placements = new Map<Element, () => void>();
let resizes: ResizeObserver | null = null;

/**
 * Ends `open` (absolutely placed in its offset parent) {@link OPEN_GAP_PX} before the control
 * `next()` finds, again whenever the parent changes size (a row shown after being hidden measures
 * 0 at first). Returns the cleanup.
 */
function placeOpenButton(open: HTMLElement, next: () => Element | null) {
    const parent = open.parentElement;
    if (!parent) {
        return undefined;
    }
    const place = () => {
        const control = next();
        const box = parent.getBoundingClientRect();
        const edge = control?.getBoundingClientRect();
        if (!edge?.width || !box.width) {
            return;
        }
        const rtl = getComputedStyle(parent).direction === "rtl";
        open.style.insetInlineEnd = `${Math.max(0, Math.round(openEnd(box, edge, rtl)))}px`;
    };
    place();
    placements.set(parent, place);
    resizes ??= typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            for (const entry of entries) placements.get(entry.target)?.();
        })
        : null;
    resizes?.observe(parent);
    return () => {
        resizes?.unobserve(parent);
        placements.delete(parent);
    };
}

/** How far from its parent's end edge the open button stops: {@link OPEN_GAP_PX} before `next`. */
export function openEnd(parent: { left: number; right: number }, next: { left: number; right: number }, rtl: boolean) {
    return (rtl ? next.right - parent.left : parent.right - next.left) + OPEN_GAP_PX;
}

let nextId = 0;

/**
 * Turns `container`, an upstream `role="button"`, into a plain element and names `open` after the
 * parts `labelParts` select (the title, the team marks). Those parts are hidden from assistive
 * technology, which reads them through the button instead. Runs after every render, since a
 * re-render of upstream's element keeps these attributes only while its own props stay the same.
 */
export function asContainer(container: HTMLElement, open: HTMLElement, labelParts: string[]) {
    container.removeAttribute("role");
    container.removeAttribute("tabindex");
    const ids: string[] = [];
    for (const selector of labelParts) {
        const part = container.querySelector<HTMLElement>(selector);
        if (!part) {
            continue;
        }
        part.id ||= `tf-row-part-${++nextId}`;
        part.setAttribute("aria-hidden", "true");
        ids.push(part.id);
    }
    open.setAttribute("aria-labelledby", ids.join(" "));
    open.toggleAttribute("disabled", container.classList.contains("is-pending"));
}
