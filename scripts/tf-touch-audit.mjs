#!/usr/bin/env node
/**
 * Touch target audit of the embedded notebook against `tf-dev-host.mjs`, on a phone (402 x 874)
 * and a tablet (1024 x 768) with touch emulation. Walks a fixed route through the demo notes and
 * the "Touch fixtures" subtree, and reports per step:
 *
 * - every visible interactive element whose hit area is under 44 x 44 CSS px. The hit area is
 *   measured with `elementFromPoint` on a 2 px grid around the element, so padding and positioned
 *   pseudo-elements count, and parts covered by other elements do not;
 * - every pair of targets whose hit areas overlap (a tap there is ambiguous);
 * - every control that only becomes visible through a `:hover` rule (`opacity`, `visibility` or
 *   `display`), and is hidden right now.
 *
 *   node scripts/tf-touch-audit.mjs [--layout phone|tablet|both] [--json out.json] [--shots dir] [--quiet]
 *
 * Inline links inside running text are left out (WCAG 2.5.8 exempts them), and so are elements
 * inside Excalidraw's and the mind map's own canvases, which draw their controls themselves.
 * Targets cut by the screen's edge or scrolled under the floating formatting toolbar are measured
 * by their own size. To-do checkboxes in an editable text note count with the 14 px that
 * `setupTodoCheckboxTaps()` (`widgets/type_widgets/text/utils.ts`) adds around them.
 * Exit code 0 when no step has a finding, 1 otherwise.
 */
import fs from "node:fs";

import { ensureFixtures, findNotes, gotoNote, launch, openNotebook, sleep } from "./tf-touch-lib.mjs";

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
};
const LAYOUTS = arg("layout", "both") === "both" ? [ "phone", "tablet" ] : [ arg("layout") ];
const JSON_OUT = arg("json", null);
const QUIET = process.argv.includes("--quiet");
const SHOTS = arg("shots", null);
/** `--font <family>`: the same route in another typeface. Phones and Linux have wider system fonts than macOS. */
const FONT = arg("font", null);
/** `--css <file>`: an extra stylesheet in the frame, to try a fix before a build. */
const EXTRA_CSS = arg("css", null);

/** Elements left out of the audit, with the reason in `tf-touch-audit.mjs`'s header. */
const EXCLUDE = [
    ".excalidraw canvas", ".map-container canvas", ".mind-map canvas",
    ".ck-content p a", ".ck-content li a", ".ck-content td a", ".note-detail-readonly-text p a"
];

const browser = await launch();
const report = {};
let total = 0;

try {
    for (const layout of LAYOUTS) {
        const session = await openNotebook(browser, { as: "alice", layout });
        const { frame, page } = session;
        if (FONT) {
            await frame.evaluate((family) => {
                for (const name of [ "--main-font-family", "--detail-font-family", "--tree-font-family" ]) {
                    document.documentElement.style.setProperty(name, family);
                    document.body.style.setProperty(name, family);
                }
            }, FONT);
        }
        if (EXTRA_CSS) {
            await frame.addStyleTag({ content: fs.readFileSync(EXTRA_CSS, "utf-8") });
        }
        const ids = await ensureFixtures(frame);
        const demo = Object.fromEntries((await findNotes(frame, "note.type = canvas or note.type = mindMap or #viewType=calendar"))
            .map((n) => [ n.type === "book" ? "calendar" : n.type, n.noteId ]));
        const steps = buildRoute(layout, ids, demo);
        report[layout] = [];
        for (const step of steps) {
            try {
                await step.run(session);
                await sleep(step.settle ?? 700);
                const findings = await frame.evaluate(auditInPage, { exclude: EXCLUDE });
                if (SHOTS) {
                    await page.screenshot({ path: `${SHOTS}/audit-${layout}-${step.name.replace(/[^a-z]+/gi, "-")}.png` });
                }
                report[layout].push({ step: step.name, ...findings });
                total += findings.small.length + findings.overlaps.length + findings.hoverOnly.length;
                printStep(layout, step.name, findings);
            } catch (e) {
                report[layout].push({ step: step.name, error: String(e?.message ?? e) });
                console.log(`[${layout}] ${step.name}: ERROR ${String(e?.message ?? e).slice(0, 200)}`);
            } finally {
                await step.after?.(session).catch(() => {});
            }
        }
        await page.evaluate(() => window.__tfHost.setKeyboard(0));
        await session.context.close();
    }
} finally {
    await browser.close();
}

const summary = Object.fromEntries(Object.entries(report).map(([ layout, steps ]) => [ layout, {
    small: steps.reduce((n, s) => n + (s.small?.length ?? 0), 0),
    overlaps: steps.reduce((n, s) => n + (s.overlaps?.length ?? 0), 0),
    hoverOnly: steps.reduce((n, s) => n + (s.hoverOnly?.length ?? 0), 0),
    errors: steps.filter((s) => s.error).length
} ]));
console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, report }, null, 2));
}
process.exit(total === 0 && Object.values(summary).every((s) => s.errors === 0) ? 0 : 1);

function printStep(layout, name, findings) {
    console.log(`[${layout}] ${name}: ${findings.checked} targets, ${findings.small.length} under 44 px, ${findings.overlaps.length} overlaps, ${findings.hoverOnly.length} hover-only`);
    if (QUIET) {
        return;
    }
    for (const s of findings.small) {
        console.log(`    small   ${s.w}x${s.h}  ${s.label}`);
    }
    for (const o of findings.overlaps) {
        console.log(`    overlap ${o.a}  <>  ${o.b}`);
    }
    for (const h of findings.hoverOnly) {
        console.log(`    hover   ${h.label}  (${h.rule})`);
    }
}

function buildRoute(layout, ids, demo) {
    const phone = layout === "phone";
    const screen = (name) => async ({ frame }) => frame.evaluate((s) => window.glob.appContext.triggerCommand("setActiveScreen", { screen: s }), name);
    const open = (noteId, then) => async (session) => {
        await gotoNote(session.frame, noteId);
        if (phone) {
            await screen("detail")(session);
        }
        await then?.(session);
    };
    const tapFirst = async (session, selectors) => {
        for (const selector of selectors) {
            const box = await session.frame.evaluate((sel) => {
                const el = [ ...document.querySelectorAll(sel) ].find((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
                if (!el) {
                    return null;
                }
                const r = el.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }, selector);
            if (box) {
                await session.touch.tap(box.x, box.y);
                return true;
            }
        }
        throw new Error(`nothing to tap: ${selectors.join(", ")}`);
    };
    const closeOverlays = async ({ frame }) => frame.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        for (const modal of document.querySelectorAll(".modal.show .btn-close, .modal.show .modal-header button")) {
            modal.click();
        }
    });

    return [
        {
            name: "navigator",
            run: async (session) => {
                await gotoNote(session.frame, ids.alpha);
                if (phone) {
                    await screen("tree")(session);
                }
            }
        },
        {
            name: "text note, keyboard up",
            run: open(ids.playground, async (session) => {
                await session.frame.evaluate(() => {
                    const ed = document.querySelector(".note-detail-editable-text-editor");
                    ed?.focus();
                });
                await session.page.evaluate(() => window.__tfHost.setKeyboard(320, "shrink"));
            }),
            after: async ({ page }) => page.evaluate(() => window.__tfHost.setKeyboard(0))
        },
        {
            name: "table in a text note",
            run: open(ids.playground, async ({ frame }) => {
                await frame.evaluate(() => {
                    document.activeElement?.blur?.();
                    document.querySelector(".ck-content figure.table")?.scrollIntoView({ block: "center" });
                });
            })
        },
        {
            name: "note menu",
            run: open(ids.playground, async (session) => tapFirst(session, [ ".mobile-detail-menu button", ".note-actions .dropdown-toggle", "button.bx-dots-horizontal-rounded" ])),
            after: closeOverlays
        },
        {
            name: "note panel sheet",
            run: open(ids.playground, async (session) => tapFirst(session, [ ".mobile-note-panel-button button", ".bx-dock-bottom" ])),
            after: closeOverlays,
            settle: 1000
        },
        { name: "board collection", run: open(ids.board), settle: 1200 },
        ...(demo.calendar ? [ { name: "calendar", run: open(demo.calendar), settle: 1200 } ] : []),
        ...(demo.canvas ? [ { name: "canvas note", run: open(demo.canvas), settle: 2500 } ] : []),
        ...(demo.mindMap ? [ { name: "mind map", run: open(demo.mindMap), settle: 2000 } ] : []),
        { name: "relation map", run: open(ids.relationMap), settle: 1500 },
        {
            name: "tab switcher",
            run: async (session) => {
                if (phone) {
                    await screen("detail")(session);
                }
                await tapFirst(session, [ ".mobile-tab-switcher", "#launcher-pane .bx-rectangle" ]);
            },
            after: closeOverlays,
            settle: 1000
        },
        {
            name: "options",
            run: async ({ frame }) => {
                await frame.evaluate(() => window.glob.appContext.triggerCommand("showOptions", { section: "_optionsAppearance" }));
            },
            settle: 1500
        }
    ];
}

/** Runs inside the frame. Returns `{ checked, small, overlaps, hoverOnly }`. */
function auditInPage({ exclude }) {
    const MIN = 44;
    const INTERACTIVE = [
        "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "label[for]",
        "[role=button]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=tab]",
        "[role=checkbox]", "[role=switch]", "[role=option]", "[role=link]", "[role=slider]",
        "[tabindex]:not([tabindex='-1'])", "[onclick]", ".fancytree-expander", ".fancytree-title",
        ".dropdown-item", ".tn-tool-button", ".ck-button", ".icon-action"
    ].join(",");

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const describe = (el) => {
        const id = el.id ? `#${el.id}` : "";
        const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
        const text = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
        const parent = el.parentElement;
        const where = parent ? ` in ${parent.tagName.toLowerCase()}${typeof parent.className === "string" && parent.className.trim() ? `.${parent.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}` : "";
        return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}${where}`;
    };
    const isExcluded = (el) => exclude.some((sel) => el.matches(sel) || el.closest(sel.split(" ")[0]) && el.matches(sel));
    const shown = (el) => {
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05 || style.pointerEvents === "none") {
            return false;
        }
        for (let p = el.parentElement; p; p = p.parentElement) {
            if (Number(getComputedStyle(p).opacity) < 0.05) {
                return false;
            }
        }
        return true;
    };
    const ownsPoint = (el, x, y) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
    };

    const candidates = new Set([ ...document.querySelectorAll(INTERACTIVE) ]);
    for (const el of document.querySelectorAll("body *")) {
        if (getComputedStyle(el).cursor === "pointer" && !el.parentElement?.closest(INTERACTIVE)) {
            candidates.add(el);
        }
    }

    const targets = [];
    for (const el of candidates) {
        if (isExcluded(el) || el.closest("[inert]") || el.closest("[aria-hidden=true]")) {
            continue;
        }
        if (el.closest(".ck-content") && el.matches("a[href]") && !el.closest(".ck-widget")) {
            continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw || !shown(el)) {
            continue;
        }
        // Interactive descendants of an interactive element are audited on their own.
        const parentTarget = el.parentElement?.closest(INTERACTIVE);
        if (parentTarget && candidates.has(parentTarget) && !el.matches("a[href], button, input, select, textarea, [role=button], [role=checkbox]")) {
            continue;
        }
        const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), vw - 1);
        const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), vh - 1);
        let reachable = ownsPoint(el, cx, cy);
        if (!reachable) {
            for (const [ fx, fy ] of [ [ 0.25, 0.5 ], [ 0.75, 0.5 ], [ 0.5, 0.25 ], [ 0.5, 0.75 ] ]) {
                if (ownsPoint(el, rect.left + rect.width * fx, rect.top + rect.height * fy)) {
                    reachable = true;
                    break;
                }
            }
        }
        if (!reachable) {
            continue;
        }

        let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        if (rect.width < MIN || rect.height < MIN) {
            const pad = 24;
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let x = Math.max(0, rect.left - pad); x <= Math.min(vw - 1, rect.right + pad); x += 2) {
                for (let y = Math.max(0, rect.top - pad); y <= Math.min(vh - 1, rect.bottom + pad); y += 2) {
                    if (ownsPoint(el, x, y)) {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    }
                }
            }
            if (minX !== Infinity) {
                box = { left: minX, top: minY, right: maxX + 2, bottom: maxY + 2 };
            }
        }
        // `setupTodoCheckboxTaps()` in an editable text note takes taps within 14 px of a to-do checkbox.
        // Only points where the list itself is on top count; a toolbar over it takes its own taps.
        const list = el.closest(".note-detail-editable-text") ? el.closest(".todo-list") : null;
        if (list && el.matches("input[type=checkbox]")) {
            const pad = 14;
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let x = Math.max(0, rect.left - pad); x <= Math.min(vw - 1, rect.right + pad); x += 2) {
                for (let y = Math.max(0, rect.top - pad); y <= Math.min(vh - 1, rect.bottom + pad); y += 2) {
                    if (document.elementFromPoint(x, y)?.closest(".todo-list") === list) {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    }
                }
            }
            if (minX !== Infinity) {
                box = { left: minX, top: minY, right: maxX + 2, bottom: maxY + 2 };
            }
        }
        targets.push({ el, box, w: Math.round(box.right - box.left), h: Math.round(box.bottom - box.top) });
    }

    // Content scrolled under the floating formatting toolbar is cut there as at the screen's edge.
    const overlays = [ ...document.querySelectorAll(".classic-toolbar-island") ]
        .map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height);
    const small = [];
    for (const t of targets) {
        // An element cut by the edge of the screen (a scrolled list) is measured by its own size.
        const underOverlay = overlays.some((o) => !t.el.closest(".classic-toolbar-island")
            && t.box.bottom >= o.top - 1 && t.box.top < o.bottom && t.box.right > o.left && t.box.left < o.right);
        const clipped = t.box.left <= 0 || t.box.top <= 0 || t.box.right >= vw - 1 || t.box.bottom >= vh - 1 || underOverlay;
        const r = t.el.getBoundingClientRect();
        const pad = t.el.matches(".todo-list input[type=checkbox]") && t.el.closest(".note-detail-editable-text") ? 28 : 0;
        const w = clipped ? Math.max(t.w, Math.round(r.width) + pad) : t.w;
        const h = clipped ? Math.max(t.h, Math.round(r.height) + pad) : t.h;
        if (w < MIN - 0.5 || h < MIN - 0.5) {
            small.push({ label: describe(t.el), w, h });
        }
    }

    const isControlSized = (t) => t.w <= 240 && t.h <= 96;
    const overlaps = [];
    for (let i = 0; i < targets.length; i++) {
        for (let j = i + 1; j < targets.length; j++) {
            const a = targets[i];
            const b = targets[j];
            // Containers (an editor, a card) hold other targets by design; only controls are compared.
            if (a.el.contains(b.el) || b.el.contains(a.el) || !isControlSized(a) || !isControlSized(b)) {
                continue;
            }
            const ix = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
            const iy = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
            if (ix > 2 && iy > 2) {
                overlaps.push({ a: describe(a.el), b: describe(b.el) });
            }
        }
    }

    const hoverOnly = [];
    const seen = new Set();
    const visit = (rules, parentSelector) => {
        for (const rule of rules) {
            if (rule instanceof CSSMediaRule) {
                if (matchMedia(rule.media.mediaText).matches) {
                    visit(rule.cssRules, parentSelector);
                }
                continue;
            }
            if (rule instanceof CSSSupportsRule || rule instanceof CSSLayerBlockRule) {
                visit(rule.cssRules, parentSelector);
                continue;
            }
            if (!(rule instanceof CSSStyleRule)) {
                continue;
            }
            let selector = rule.selectorText;
            if (parentSelector) {
                selector = selector.includes("&") ? selector.replaceAll("&", `:is(${parentSelector})`) : `:is(${parentSelector}) ${selector}`;
            }
            if (rule.cssRules?.length) {
                visit(rule.cssRules, selector);
            }
            if (!selector.includes(":hover")) {
                continue;
            }
            const style = rule.style;
            const reveals = (style.opacity && Number(style.opacity) > 0.3)
                || style.visibility === "visible"
                || (style.display && style.display !== "none");
            if (!reveals) {
                continue;
            }
            for (const part of selector.split(/,(?![^(]*\))/)) {
                if (!part.includes(":hover")) {
                    continue;
                }
                // Only a hover that reveals something else counts (`.row:hover .action`), not the
                // hover look of the hovered element itself.
                if (!/:hover\)*\s*[ >+~]\s*[^\s,]/.test(part)) {
                    continue;
                }
                const plain = part.replace(/:hover/g, "").trim();
                let matches = [];
                try {
                    matches = [ ...document.querySelectorAll(plain) ];
                } catch {
                    continue;
                }
                for (const el of matches) {
                    if (seen.has(el)) {
                        continue;
                    }
                    const r = el.getBoundingClientRect();
                    const style = getComputedStyle(el);
                    const hidden = style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.1;
                    const parent = el.parentElement;
                    if (!hidden || !parent || !parent.getClientRects().length) {
                        continue;
                    }
                    const pr = parent.getBoundingClientRect();
                    if (pr.bottom <= 0 || pr.top >= vh || pr.width < 1 || !shown(parent)) {
                        continue;
                    }
                    const interactive = el.matches(INTERACTIVE) || el.querySelector(INTERACTIVE) || style.cursor === "pointer";
                    if (!interactive) {
                        continue;
                    }
                    seen.add(el);
                    hoverOnly.push({ label: describe(el), rule: part.trim().slice(0, 120), w: Math.round(r.width) });
                }
            }
        }
    };
    for (const sheet of document.styleSheets) {
        try {
            visit(sheet.cssRules, "");
        } catch {
            // A cross-origin sheet cannot be read.
        }
    }

    return { checked: targets.length, small, overlaps, hoverOnly };
}
