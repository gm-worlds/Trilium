/**
 * Live Taskforce chips: drawing one from the last known answer of `POST links/resolve`, resolving
 * every chip of a note in one call, applying `chip.updated`, and the chip's press and menu.
 */
import type { TfChipActions, TfChipData } from "@triliumnext/ckeditor5";

import contextMenu, { type MenuItem } from "../../menus/context_menu.js";
import { copyTextWithToast } from "../../services/clipboard_ext.js";
import { t } from "../../services/i18n.js";
import { getTfBridge, tfHaptic } from "../bridge.js";
import { getTfBootstrap } from "../state.js";
import { resolveLinks, type TfChipResult, type TfTaskChip } from "./api.js";
import { chipOpenTarget, chipPlaceholder } from "./editor_logic.js";
import { notesOriginConfig, parseTaskforceLink, toHostPath } from "./links.js";
import { getChipResult, setChipResult } from "./store.js";

const KIND_ICONS: Record<string, string> = {
    task: "bx bx-task",
    project: "bx bx-folder",
    document: "bx bx-file",
    note: "bx bx-note"
};
const LONG_PRESS_MS = 500;
const RESOLVE_BATCH = 100;

interface DrawnChip {
    data: TfChipData;
    actions: TfChipActions;
}

const drawn = new Map<HTMLElement, DrawnChip>();

/** `TfWorkHost.renderChip`: draws a chip and remembers it for live updates. */
export function renderChip(dom: HTMLElement, data: TfChipData, actions: TfChipActions) {
    drawn.set(dom, { data, actions });
    drawChip(dom, data);
    if (!dom.dataset.tfChipWired) {
        dom.dataset.tfChipWired = "1";
        wireChip(dom);
    }
}

/** The title a chip shows and saves: the latest answer's, else what the note stored. */
export function chipTitle(data: TfChipData): string {
    const result = getChipResult(data.href);
    return result?.ok ? result.title : data.storedTitle;
}

/** Draws every chip again whose href or id `match` accepts, from the store. */
export function redrawChips(match: (data: TfChipData) => boolean) {
    for (const [ dom, chip ] of drawn) {
        if (!dom.isConnected) {
            drawn.delete(dom);
            continue;
        }
        if (match(chip.data)) {
            drawChip(dom, chip.data);
        }
    }
}

/** Asks Taskforce about `hrefs` (deduplicated, in batches of 100) and redraws their chips. */
export async function resolveChips(hrefs: string[]) {
    const unique = [ ...new Set(hrefs.filter(Boolean)) ];
    for (let start = 0; start < unique.length; start += RESOLVE_BATCH) {
        const batch = unique.slice(start, start + RESOLVE_BATCH);
        const results = await resolveLinks(batch);
        for (const [ index, href ] of batch.entries()) {
            const result = results[index];
            if (result) {
                setChipResult(href, result);
            }
        }
        const set = new Set(batch);
        redrawChips((data) => set.has(data.href));
    }
}

/** `chip.updated`: the task changed in Taskforce (or went: `chip: null`). */
export function applyChipUpdate(taskId: string, chip: TfTaskChip | null) {
    const hrefs = new Set<string>();
    for (const { data } of drawn.values()) {
        if (data.kind === "task" && data.id === taskId) {
            hrefs.add(data.href);
        }
    }
    for (const href of hrefs) {
        setChipResult(href, chip ?? { ok: false, reason: "not_found" });
    }
    redrawChips((data) => data.kind === "task" && data.id === taskId);
}

/** Remembers a task chip the frame just made, under the href stored in the note. */
export function rememberChip(href: string, result: TfChipResult) {
    setChipResult(href, result);
    redrawChips((data) => data.href === href);
}

/**
 * Sends `open` to the host with the chip's Taskforce path: the one Taskforce answered for it, else
 * its link's, once that is a Taskforce link of the chip's own kind and id. Anything else opens nothing.
 */
export function openChip(data: TfChipData) {
    const result = getChipResult(data.href);
    const appOrigins = getTfBootstrap()?.parentOrigins ?? [];
    const href = chipOpenTarget(
        data,
        result?.ok ? result : null,
        (link) => parseTaskforceLink(link, { appOrigins, ...notesOriginConfig(location) }),
        (link) => toHostPath(link, appOrigins)
    );
    if (href) {
        getTfBridge()?.notify("open", { href });
    }
}

export function showChipMenu(data: TfChipData, actions: TfChipActions, position: { x: number; y: number }) {
    const items: MenuItem<string>[] = [
        { title: t("tf.work.chip_open"), uiIcon: "bx bx-link-external", handler: () => openChip(data) },
        { title: t("tf.work.chip_copy"), uiIcon: "bx bx-copy", handler: () => copyTextWithToast(data.href) }
    ];
    if (actions.isEditable) {
        items.push({ kind: "separator" }, { title: t("tf.work.chip_plain"), uiIcon: "bx bx-unlink", handler: () => actions.turnIntoLink() });
    }
    void contextMenu.show({ x: position.x, y: position.y, items, selectMenuItemHandler: () => {}, forcePositionOnMobile: true });
}

function drawChip(dom: HTMLElement, data: TfChipData) {
    const result = getChipResult(data.href);
    const container = dom.closest<HTMLElement>(".tf-chip");
    if (!container) {
        // The editing view draws the body before it is placed in its `.tf-chip` container.
        queueMicrotask(() => {
            if (dom.closest(".tf-chip")) {
                drawChip(dom, data);
            }
        });
    }
    const root = container ?? document.createElement("span");
    for (const state of [ "loading", "ok", "no-access", "removed", "done" ]) {
        root.classList.remove(`tf-chip--${state}`);
    }

    const parts: Node[] = [];
    const icon = (className: string) => {
        const span = document.createElement("span");
        span.className = `tf-chip__icon ${className}`;
        span.setAttribute("aria-hidden", "true");
        return span;
    };
    const text = (className: string, value: string) => {
        const span = document.createElement("span");
        span.className = className;
        span.textContent = value;
        return span;
    };
    const kindLabel = data.kind in KIND_ICONS ? t(`tf.work.chip_${data.kind}`) : t("tf.work.chip_link");
    const kindIcon = KIND_ICONS[data.kind] ?? "bx bx-link";

    if (!result) {
        root.classList.add("tf-chip--loading");
        parts.push(icon(kindIcon), text("tf-chip__title", data.storedTitle || t("tf.work.chip_loading")));
        const placeholder = data.storedTitle || chipPlaceholder(data.href);
        root.setAttribute("aria-label", placeholder ? `${kindLabel}: ${placeholder}` : kindLabel);
    } else if (!result.ok) {
        const noAccess = result.reason === "no_access";
        root.classList.add(noAccess ? "tf-chip--no-access" : "tf-chip--removed");
        const label = noAccess ? t("tf.work.chip_no_access") : t("tf.work.chip_removed");
        parts.push(icon(noAccess ? "bx bx-lock-alt" : "bx bx-unlink"), text("tf-chip__title", label));
        root.setAttribute("aria-label", `${kindLabel}: ${label}`);
    } else {
        root.classList.add("tf-chip--ok");
        parts.push(icon(kindIcon), text("tf-chip__title", result.title));
        let label = `${kindLabel}: ${result.title}`;
        if (result.kind === "task") {
            if (result.done) {
                root.classList.add("tf-chip--done");
            }
            const status = document.createElement("span");
            status.className = "tf-chip__status";
            const dot = document.createElement("span");
            dot.className = "tf-chip__dot";
            dot.style.setProperty("--tf-chip-status", result.statusColor || "currentColor");
            status.append(dot, text("tf-chip__status-label", result.statusLabel));
            parts.push(status);
            label += `, ${result.statusLabel}`;
            if (result.assignee) {
                const initials = text("tf-chip__initials", initialsOf(result.assignee.name));
                initials.title = t("tf.work.chip_assignee", { name: result.assignee.name });
                parts.push(initials);
                label += `, ${t("tf.work.chip_assignee", { name: result.assignee.name })}`;
            }
        }
        root.setAttribute("aria-label", label);
    }
    root.setAttribute("role", "link");
    root.title = root.getAttribute("aria-label") ?? "";
    dom.replaceChildren(...parts);
}

function wireChip(dom: HTMLElement) {
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let pressStart: { x: number; y: number } | null = null;
    let suppressClick = false;

    const chipOf = () => drawn.get(dom);
    const cancelPress = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
        pressStart = null;
    };

    dom.addEventListener("click", (event) => {
        const chip = chipOf();
        if (!chip || event.button !== 0) {
            return;
        }
        event.preventDefault();
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        openChip(chip.data);
    });
    dom.addEventListener("contextmenu", (event) => {
        const chip = chipOf();
        if (!chip) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        showChipMenu(chip.data, chip.actions, { x: event.pageX, y: event.pageY });
    });
    dom.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch") {
            return;
        }
        pressStart = { x: event.clientX, y: event.clientY };
        pressTimer = setTimeout(() => {
            const chip = chipOf();
            pressTimer = null;
            if (!chip || !pressStart) {
                return;
            }
            suppressClick = true;
            tfHaptic("medium");
            const rect = dom.getBoundingClientRect();
            showChipMenu(chip.data, chip.actions, { x: rect.left + window.scrollX, y: rect.bottom + window.scrollY });
        }, LONG_PRESS_MS);
    });
    dom.addEventListener("pointermove", (event) => {
        if (pressStart && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 8) {
            cancelPress();
        }
    });
    dom.addEventListener("pointerup", cancelPress);
    dom.addEventListener("pointercancel", cancelPress);
}

export function initialsOf(name: string) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? [ words[0], words[words.length - 1] ] : words;
    return letters.map((word) => Array.from(word)[0]?.toUpperCase() ?? "").join("").slice(0, 2);
}
