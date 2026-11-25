#!/usr/bin/env node
/**
 * Touch checks of the embedded notebook against `tf-dev-host.mjs` (puppeteer, CDP touch events).
 * One line per check; exit code 1 when any check fails.
 *
 *   node scripts/tf-dev-host.mjs &          # engine + gateway stand-in + host page
 *   node scripts/tf-phone-check.mjs [--skip-audit] [--shots <dir>] [--mode light|dark] [--only <groups>]
 *
 * Groups (`--only a,b`): bridge, embed, press, navigator, text, scale, keyboard, gestures, tablet,
 * audit.
 * Phone 402 x 874 and tablet 1024 x 768, both with touch. The checks use the "Touch fixtures"
 * subtree (`ensureFixtures()` creates it) and put the "Reorder" folder back in order first.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { centerOf, childTitles, ensureFixtures, findNotes, gotoNote, launch, openNotebook, resetReorder, sleep, waitFor } from "./tf-touch-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKIP_AUDIT = process.argv.includes("--skip-audit");
const shotsAt = process.argv.indexOf("--shots");
const SHOTS = shotsAt === -1 ? null : process.argv[shotsAt + 1];
const MODE = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "light";
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const results = [];
function check(name, ok, detail = "") {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ""}`);
}
const want = (group) => !ONLY || ONLY.includes(group);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}-${MODE}.png` });

const browser = await launch();
try {
    let phone = await openNotebook(browser, { as: "alice", layout: "phone", mode: MODE });
    const ids = await ensureFixtures(phone.frame);
    const demo = Object.fromEntries((await findNotes(phone.frame, "note.type = mindMap")).map((n) => [ n.type, n.noteId ]));

    if (want("bridge")) {
        await bridgeChecks(phone);
    }
    if (want("embed")) {
        phone = await embedChecks(phone, ids);
    }
    if (want("press")) {
        await pressChecks(phone, ids);
    }
    if (want("navigator")) {
        phone = await navigatorChecks(phone, ids);
    }
    if (want("text")) {
        await textChecks(phone, ids);
    }
    if (want("scale")) {
        phone = await scaleChecks(phone, ids, demo);
    }
    if (want("keyboard")) {
        await keyboardChecks(phone, ids);
    }
    if (want("gestures")) {
        await gestureChecks(phone, ids);
    }
    await phone.context.close();

    if (want("tablet")) {
        await tabletChecks(ids);
    }
    if (want("audit") && !SKIP_AUDIT) {
        auditCheck();
    }
} catch (e) {
    check("run finished without an exception", false, e?.stack ?? e);
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

async function hostLog(page) {
    return page.evaluate(() => window.__tfLog.map((e) => ({ dir: e.dir, method: e.method, params: e.params })));
}

async function bridgeChecks({ page, frame, touch }) {
    const log = await hostLog(page);
    const ready = log.find((e) => e.method === "ready");
    check("handshake: ready, init answered", !!ready && log.some((e) => e.dir === "frame→host" && e.method === null),
        ready ? JSON.stringify(ready.params) : "no ready");
    check("capability tf-touch-1 announced", ready?.params?.capabilities?.includes("tf-touch-1"), ready?.params?.capabilities);

    const button = await centerOf(frame, "[data-tf-taskforce]");
    const phoneLabel = await frame.evaluate(() => document.querySelector("[data-tf-taskforce]")?.getAttribute("aria-label"));
    check("Taskforce button in the phone launch bar, 44 px, named Taskforce", button && button.w >= 44 && button.h >= 44 && phoneLabel === "Taskforce", `${JSON.stringify(button)} ${phoneLabel}`);
    if (button) {
        await touch.tap(button.x, button.y);
        await sleep(300);
    }
    check("Taskforce button sends switcher.open", (await hostLog(page)).some((e) => e.method === "switcher.open"));

    await page.evaluate(() => window.__tfHost.setMode("dark"));
    const dark = await waitFor(() => frame.evaluate(() => document.body.getAttribute("data-theme-id") === "next-dark"), 8000);
    await sleep(300);
    const look = await frame.evaluate(async () => {
        await document.fonts.ready;
        const css = getComputedStyle(document.documentElement);
        const chrome = getComputedStyle(document.querySelector("#launcher-pane") ?? document.body).fontFamily;
        const content = document.querySelector(".ck-content");
        return {
            accent: css.getPropertyValue("--tf-accent").trim(),
            onAccent: css.getPropertyValue("--tf-on-accent").trim(),
            indicator: css.getPropertyValue("--navigator-active-indicator-color").trim(),
            chrome,
            content: content ? getComputedStyle(content).fontFamily : null,
            loaded: document.fonts.check("16px \"Source Sans 3\"") && [ ...document.fonts ].some((f) => f.family.includes("Source Sans 3") && f.status === "loaded")
        };
    });
    check("theme follows the host (dark): hsl accent, readable text on it, Source Sans 3 loaded for the chrome, Inter for content",
        dark && look.accent === "hsl(205 100% 72%)" && look.onAccent === "#000000" && /Source Sans 3/.test(look.chrome) && look.loaded
            && (look.content === null || /Inter/.test(look.content)), JSON.stringify(look));
    await page.evaluate((m) => window.__tfHost.setMode(m), MODE);
    await waitFor((() => frame.evaluate((m) => document.body.getAttribute("data-theme-id") === `next-${m}`, MODE)), 8000);
}

/** History, scripts off, restored tabs and the Taskforce button in the desktop layout. */
async function embedChecks(session, ids) {
    const { frame, page } = session;
    const errors = await frame.evaluate(() => [ ...document.querySelectorAll(".toast") ].map((t) => t.textContent.trim()).filter((t) => /error|widgets/i.test(t)));
    check("no error toasts on load with scripts off (no script/widgets 404)", errors.length === 0, errors.join(" | "));
    const lists = await frame.evaluate(async () => {
        const get = async (u) => { const r = await fetch(u, { credentials: "same-origin" }); return `${r.status} ${await r.text()}`; };
        return [ await get("api/script/widgets"), await get("api/script/startup") ];
    });
    check("script/widgets and script/startup answer empty lists while scripts are off", lists.every((l) => l === "200 []"), lists.join(" ; "));

    const hostLength = await page.evaluate(() => history.length);
    for (const id of [ ids.alpha, ids.playground, ids.long ]) {
        await gotoNote(frame, id);
        await sleep(400);
    }
    const after = await page.evaluate(() => history.length);
    check("note navigation in the frame adds no host history entries", after === hostLength, `${hostLength} -> ${after}`);
    const title = () => frame.evaluate(() => window.glob.appContext.tabManager.getActiveContext()?.note?.title);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("backInNoteHistory"));
    await sleep(700);
    const back = await title();
    await frame.evaluate(() => window.glob.appContext.triggerCommand("forwardInNoteHistory"));
    await sleep(700);
    const forward = await title();
    check("Trilium's own back and forward still step through notes", back === "Playground" && forward === "Long text", `${back} / ${forward}`);

    await frame.evaluate((id) => window.glob.appContext.tabManager.openContextWithNote(id, { activate: false }), ids.alpha);
    await sleep(1500);
    const before = await frame.evaluate(() => window.glob.appContext.tabManager.getMainNoteContexts().map((c) => c.note?.title).join(","));
    await frame.evaluate(() => location.reload());
    await sleep(500);
    session = await openFrameAfterReload(session);
    const restored = await waitFor(() => session.frame.evaluate(() => {
        const titles = window.glob.appContext.tabManager.getMainNoteContexts().map((c) => c.note?.title);
        return titles.length > 1 && titles.every(Boolean) ? titles.join(",") : null;
    }), 10_000);
    check("open tabs restore after a reload with scripts off", restored === before, `${before} -> ${restored}`);
    await session.frame.evaluate(() => {
        const tm = window.glob.appContext.tabManager;
        for (const c of tm.getMainNoteContexts().slice(1)) {
            void tm.removeNoteContext(c.ntxId);
        }
    });
    await sleep(500);
    return session;
}

/** Pressed look on touch down and the slide-to-pick preview on the formatting toolbar. */
async function pressChecks(session, ids) {
    const { frame, page, touch } = session;
    const launcher = await centerOf(frame, "#launcher-pane .launcher-button");
    await touch.dispatch("touchStart", [ launcher ]);
    await sleep(20);
    const down = await frame.evaluate(() => !!document.querySelector("#launcher-pane .launcher-button.tf-pressed"));
    await touch.dispatch("touchCancel", []);
    await sleep(50);
    const up = await frame.evaluate(() => !document.querySelector(".tf-pressed"));
    check("pressed look appears on touch down and leaves after", down && up, `${down} / ${up}`);

    await gotoNote(frame, ids.playground);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(900);
    await frame.evaluate(() => document.querySelector(".note-detail-editable-text .ck-editor__editable").ckeditorInstance.editing.view.focus());
    await page.evaluate(() => window.__tfHost.setKeyboard(320, "shrink"));
    await sleep(1000);
    await frame.evaluate(() => {
        window.__tfClicks = [];
        document.addEventListener("click", (e) => {
            const b = e.target.closest?.(".ck-button");
            if (b) {
                window.__tfClicks.push(b.getAttribute("data-cke-tooltip-text") ?? b.textContent.trim());
            }
        }, true);
    });
    const button = (label) => frame.evaluate((l) => {
        const b = [ ...document.querySelectorAll(".classic-toolbar-island .ck-button") ].find((x) => (x.getAttribute("data-cke-tooltip-text") ?? "").startsWith(l));
        const r = b?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top } : null;
    }, label);
    const clicks = () => frame.evaluate(() => window.__tfClicks.splice(0));
    const label = () => frame.evaluate(() => {
        const l = document.querySelector(".tf-press-label");
        return l ? { text: l.textContent, bottom: l.getBoundingClientRect().bottom } : null;
    });
    const hapticCount = async () => (await hostLog(page)).filter((e) => e.method === "haptic").length;

    // Type and undo once, so both Undo and Redo are enabled; the note's text is put back at the end.
    await frame.evaluate(() => {
        const editor = document.querySelector(".note-detail-editable-text .ck-editor__editable").ckeditorInstance;
        window.__tfSavedData = editor.getData();
        editor.model.change((w) => w.insertText("x", editor.model.document.selection.getFirstPosition()));
        editor.model.change((w) => w.insertText("y", editor.model.document.selection.getFirstPosition()));
        editor.execute("undo");
    });
    await sleep(200);
    const undo = await button("Undo");
    const redo = await button("Redo");
    await touch.dispatch("touchStart", [ undo ]);
    await sleep(250);
    const shown = await label();
    await shot(page, "press-preview-phone");
    const haptics0 = await hapticCount();
    await slide(touch, undo, redo);
    const moved = await label();
    const haptics1 = await hapticCount();
    await touch.dispatch("touchEnd", []);
    await sleep(300);
    const picked = await clicks();
    check("a resting press shows the button's name above the finger", shown?.text === "Undo" && shown.bottom <= undo.top, JSON.stringify(shown));
    check("sliding to the neighbour moves the name and ticks a light haptic", moved?.text === "Redo" && haptics1 > haptics0, `${JSON.stringify(moved)} haptics ${haptics0}->${haptics1}`);
    check("lifting activates the neighbour, not the first button", picked.length === 1 && picked[0].startsWith("Redo"), JSON.stringify(picked));

    await touch.dispatch("touchStart", [ undo ]);
    await sleep(250);
    await slide(touch, undo, { x: undo.x, y: undo.y - 140 });
    const gone = await label();
    await touch.dispatch("touchEnd", []);
    await sleep(300);
    const none = await clicks();
    check("sliding up and away from the row cancels", !gone && none.length === 0, `${JSON.stringify(gone)} ${JSON.stringify(none)}`);

    const scroller = () => frame.evaluate(() => document.querySelector(".classic-toolbar-widget")?.scrollLeft ?? -1);
    const left0 = await scroller();
    const start = await button("Insert");
    await touch.drag(start, [ { x: start.x - 160, y: start.y } ], { steps: 6 });
    await sleep(600);
    const left1 = await scroller();
    const swipeClicks = await clicks();
    check("a quick horizontal swipe still scrolls the toolbar", left1 > left0 + 40 && swipeClicks.length === 0, `${left0} -> ${left1} ${JSON.stringify(swipeClicks)}`);
    await frame.evaluate(() => {
        const w = document.querySelector(".classic-toolbar-widget");
        if (w) {
            w.scrollLeft = 0;
        }
    });
    await frame.evaluate(() => {
        const editor = document.querySelector(".note-detail-editable-text .ck-editor__editable").ckeditorInstance;
        editor.setData(window.__tfSavedData);
    });
    await sleep(1500);
    await page.evaluate(() => window.__tfHost.setKeyboard(0));
    await sleep(400);
}

/** Two quick taps, the second starting about 120 ms after the first. */
async function doubleTap(touch, at) {
    await touch.dispatch("touchStart", [ at ]);
    await sleep(30);
    await touch.dispatch("touchEnd", []);
    await sleep(60);
    await touch.dispatch("touchStart", [ at ]);
    await sleep(30);
    await touch.dispatch("touchEnd", []);
}

/** Moves a finger that is already down from `from` to `to`. */
async function slide(touch, from, to, steps = 6) {
    for (let i = 1; i <= steps; i++) {
        await touch.dispatch("touchMove", [ { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps } ]);
        await sleep(16);
    }
    await sleep(60);
}

async function rowCenter(frame, title) {
    return frame.evaluate((t) => {
        const row = [ ...document.querySelectorAll(".mobile-navigator-list > .mobile-navigator-row") ]
            .find((r) => r.querySelector(".mobile-navigator-row-title")?.textContent?.trim() === t);
        if (!row) {
            return null;
        }
        const rect = row.getBoundingClientRect();
        return { x: rect.left + rect.width * 0.4, y: rect.top + rect.height / 2, top: rect.top, bottom: rect.bottom, h: rect.height };
    }, title);
}

async function showReorderInNavigator(session, ids) {
    await gotoNote(session.frame, ids.alpha);
    await session.frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "tree" }));
    await waitFor(() => rowCenter(session.frame, "Charlie"), 8000);
    await sleep(500);
}

async function navigatorChecks(session, ids) {
    const { frame, touch, page } = session;
    await resetReorder(frame, ids);
    await showReorderInNavigator(session, ids);

    const alpha = await rowCenter(frame, "Alpha");
    const charlie = await rowCenter(frame, "Charlie");
    if (!alpha || !charlie) {
        check("navigator shows the Reorder rows", false);
        return session;
    }
    await touch.drag(alpha, [ { x: alpha.x, y: charlie.bottom - 4, wait: 150 } ], { holdMs: 420, release: false });
    const midDrag = await frame.evaluate(() => ({
        ghost: !!document.querySelector(".tf-drag-ghost"),
        line: !!document.querySelector(".tf-insertion-line.is-shown")
    }));
    await shot(page, "navigator-mid-drag-phone");
    await touch.dispatch("touchEnd", []);
    await sleep(1500);
    check("long-press drag shows the lifted row and the insertion line", midDrag.ghost && midDrag.line, JSON.stringify(midDrag));
    const order = await childTitles(frame, ids.reorder);
    check("long-press drag reorders notes in the phone navigator", order.join(",") === "Bravo,Charlie,Alpha,Delta folder", order.join(","));
    const toast = await frame.evaluate(() => [ ...document.querySelectorAll(".toast") ].some((t) => /Undo/.test(t.textContent ?? "")));
    check("an Undo toast follows the move", toast);

    await page.reload({ waitUntil: "load" });
    const reloaded = await openFrameAfterReload(session);
    const after = await childTitles(reloaded.frame, ids.reorder);
    check("the new order persists after a reload", after.join(",") === "Bravo,Charlie,Alpha,Delta folder", after.join(","));
    session = reloaded;

    await showReorderInNavigator(session, ids);
    const bravo = await rowCenter(session.frame, "Bravo");
    const delta = await rowCenter(session.frame, "Delta folder");
    await session.touch.drag(bravo, [ { x: delta.x, y: delta.top + delta.h / 2, wait: 700 } ], { holdMs: 420, release: false });
    const inside = await session.frame.evaluate(() => !!document.querySelector(".mobile-navigator-row.tf-drop-inside"));
    await shot(session.page, "navigator-drop-inside-phone");
    await session.touch.dispatch("touchEnd", []);
    await sleep(1500);
    const deltaChildren = await childTitles(session.frame, ids.delta);
    check("holding over a folder highlights it and the drop moves the note inside",
        inside && deltaChildren.includes("Bravo"), `${inside} / ${deltaChildren.join(",")}`);

    const undo = await session.frame.evaluate(() => {
        const button = [ ...document.querySelectorAll(".toast button") ].find((b) => /Undo/.test(b.textContent ?? ""));
        if (!button) {
            return null;
        }
        const r = button.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (undo) {
        await session.touch.tap(undo.x, undo.y);
        await sleep(2000);
    }
    const restored = await childTitles(session.frame, ids.reorder);
    check("Undo puts the note back where it was", !!undo && restored.join(",") === "Bravo,Charlie,Alpha,Delta folder", restored.join(","));

    const charlie2 = await rowCenter(session.frame, "Charlie");
    await session.touch.press(charlie2.x, charlie2.y, 500);
    await sleep(600);
    const menu = await session.frame.evaluate(() => document.body.classList.contains("context-menu-shown"));
    const order2 = await childTitles(session.frame, ids.reorder);
    check("a hold released without moving opens the note menu and moves nothing", menu && order2.join(",") === restored.join(","), `${menu}`);
    await session.frame.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await sleep(300);

    const more = await session.frame.evaluate(() => {
        const button = document.querySelector(".mobile-navigator-row .tf-row-more");
        const r = button?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null;
    });
    check("each row has a visible 44 px More button", more && more.w >= 44 && more.h >= 44, JSON.stringify(more));

    const dragBack = await rowCenter(session.frame, "Charlie");
    await session.touch.drag(dragBack, [ { x: dragBack.x, y: dragBack.y + 60 }, { x: dragBack.x, y: dragBack.y + 2, wait: 100 } ], { holdMs: 420 });
    await sleep(800);
    const order3 = await childTitles(session.frame, ids.reorder);
    check("dragging back to the origin moves nothing", order3.join(",") === order2.join(","), order3.join(","));
    return session;
}

async function openFrameAfterReload(session) {
    const { waitForFrame } = await import("./tf-touch-lib.mjs");
    const frame = await waitForFrame(session.page);
    await waitFor(() => session.page.evaluate(() => window.__tfHost?.connected), 30_000);
    await frame.waitForSelector("#root-widget", { timeout: 30_000 });
    await sleep(1500);
    const cdpTouch = session.touch;
    cdpTouch.frame = frame;
    return { ...session, frame, touch: cdpTouch };
}

async function paragraphBox(frame, text) {
    return frame.evaluate((t) => {
        const p = [ ...document.querySelectorAll(".note-detail-editable-text .ck-content p") ].find((el) => el.textContent.includes(t));
        if (!p) {
            return null;
        }
        const r = p.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }, text);
}

async function textChecks(session, ids) {
    const { frame, touch, page } = session;
    await gotoNote(frame, ids.playground);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(800);

    const first = await paragraphBox(frame, "several plain words");
    const wordAt = await frame.evaluate((box) => {
        const p = [ ...document.querySelectorAll(".note-detail-editable-text .ck-content p") ].find((el) => el.textContent.includes("several plain words"));
        const node = p.firstChild;
        const range = document.createRange();
        const index = node.textContent.indexOf("plain");
        range.setStart(node, index + 1);
        range.setEnd(node, index + 2);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, first);
    await touch.longPress(wordAt.x, wordAt.y, 900);
    await sleep(500);
    const selection = await frame.evaluate(() => ({
        text: document.getSelection()?.toString() ?? "",
        menu: document.body.classList.contains("context-menu-shown")
    }));
    check("a long press in a paragraph selects a word and opens no Trilium menu", selection.text.trim().length > 0 && !selection.menu, JSON.stringify(selection));

    const second = await paragraphBox(frame, "second paragraph");
    await touch.tap(second.left + 40, second.top + 8);
    await sleep(500);
    const handle = await waitFor(() => frame.evaluate(() => {
        const h = document.querySelector(".tf-block-handle.is-shown");
        const r = h?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null;
    }), 3000);
    check("tapping into a block shows a 44 px block handle", handle && handle.w >= 44 && handle.h >= 44, JSON.stringify(handle));
    if (handle) {
        const third = await paragraphBox(frame, "third paragraph");
        await touch.drag(handle, [ { x: handle.x, y: third.bottom - 2, wait: 100 } ], { release: false });
        await shot(page, "block-handle-mid-drag-phone");
        await touch.dispatch("touchEnd", []);
        await sleep(600);
    }
    const order = await frame.evaluate(() => [ ...document.querySelectorAll(".note-detail-editable-text .ck-content > p") ].map((p) => p.textContent.slice(4, 10)));
    check("dragging the block handle moves the paragraph below the next one", order.slice(0, 3).join(",") === "first ,third ,second", order.join(","));
    await frame.evaluate(() => {
        const editor = document.querySelector(".note-detail-editable-text .ck-editor__editable").ckeditorInstance;
        editor.execute("undo");
    });
    await sleep(1500);

    await frame.evaluate(() => {
        document.activeElement?.blur?.();
        document.querySelector(".ck-content figure.table")?.scrollIntoView({ block: "center" });
    });
    await sleep(500);
    const box = await frame.evaluate(() => {
        const input = document.querySelector(".ck-content figure.table .todo-list input[type=checkbox]");
        const r = input?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: input.checked } : null;
    });
    if (box) {
        await touch.tap(box.x + 12, box.y + 10);
        await sleep(600);
    }
    const toggled = await frame.evaluate(() => ({
        checked: document.querySelector(".ck-content figure.table .todo-list input[type=checkbox]")?.checked,
        focused: !!document.activeElement?.closest?.(".ck-editor__editable")
    }));
    check("a to-do checkbox in a table cell toggles from 12 px away without focusing the editor",
        box && toggled.checked !== box.checked && !toggled.focused, JSON.stringify({ before: box?.checked, ...toggled }));
    if (box && toggled.checked !== box.checked) {
        await touch.tap(box.x, box.y);
        await sleep(400);
    }

    await gotoNote(frame, ids.includes);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(1500);
    const included = () => frame.evaluate(() => {
        const input = document.querySelector(".include-note .todo-list input[type=checkbox]");
        const r = input?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: input.checked } : null;
    });
    const inc0 = await included();
    if (inc0) {
        await touch.tap(inc0.x + 10, inc0.y + 8);
    }
    const inc1 = await waitFor(async () => {
        const now = await included();
        return now && now.checked !== inc0?.checked ? now : null;
    }, 5000);
    const incFocused = await frame.evaluate(() => !!document.activeElement?.closest?.(".ck-editor__editable"));
    check("a to-do in an included note ticks from a tap beside it, in that note, without the keyboard",
        !!inc0 && !!inc1 && !incFocused, JSON.stringify({ before: inc0?.checked, after: inc1?.checked, focused: incFocused }));
    if (inc1) {
        await touch.tap(inc1.x, inc1.y);
        await waitFor(async () => (await included())?.checked === inc0.checked, 5000);
    }
    await gotoNote(frame, ids.playground);
    await sleep(1000);

    const tableScroll = () => frame.evaluate(() => {
        const fig = document.querySelector(".ck-content figure.table");
        const r = fig?.getBoundingClientRect();
        return r ? { left: fig.scrollLeft, x: r.left + r.width * 0.75, y: r.top + 20, wide: fig.scrollWidth > fig.clientWidth } : null;
    });
    const t0 = await tableScroll();
    if (t0) {
        await touch.drag(t0, [ { x: t0.x - 220, y: t0.y } ], { steps: 8 });
        await sleep(600);
    }
    const t1 = await tableScroll();
    check("a wide table scrolls sideways under a finger", t0?.wide && t1.left > t0.left + 60, `${t0?.left} -> ${t1?.left}`);
    await frame.evaluate(() => {
        const fig = document.querySelector(".ck-content figure.table");
        if (fig) {
            fig.scrollLeft = 0;
        }
        document.activeElement?.blur?.();
        document.querySelector(".ck-content img")?.scrollIntoView({ block: "center" });
    });
    await sleep(500);

    const image = await centerOf(frame, ".ck-content img");
    const lightbox = () => frame.evaluate(() => !!document.querySelector(".lightbox-dialog.show .image-viewer-root"));
    const closeLightbox = async () => {
        await frame.evaluate(() => document.querySelector(".lightbox-dialog.show .btn-close")?.click());
        await waitFor(async () => !(await frame.evaluate(() => !!document.querySelector(".lightbox-dialog.show"))), 3000);
        await sleep(400);
    };
    if (image) {
        await doubleTap(touch, image);
    }
    const opened = await waitFor(lightbox, 4000);
    await sleep(800);
    const viewerScale = () => frame.evaluate(() => document.querySelector(".lightbox-dialog.show .image-viewer-content")?.style.transform ?? "");
    const z0 = await viewerScale();
    const viewer = await centerOf(frame, ".lightbox-dialog.show .image-viewer-root");
    if (viewer) {
        await doubleTap(touch, viewer);
        await sleep(1200);
    }
    const z1 = await viewerScale();
    await shot(page, "image-viewer-phone");
    check("double tap on an image in a text note opens the image viewer", !!opened);
    const zoomed = Number(/scale\(([\d.]+)\)/.exec(z1)?.[1] ?? 1) / Number(/scale\(([\d.]+)\)/.exec(z0)?.[1] ?? 1);
    check("double tap in the image viewer zooms in (2x or more)", !!opened && zoomed >= 2, `${z0} -> ${z1}`);
    if (opened) {
        await closeLightbox();
    }
    if (image) {
        await touch.pinch(image, 40, 120);
    }
    const pinched = await waitFor(lightbox, 4000);
    check("a pinch on an image in a text note opens the image viewer, not the text size", !!pinched
        && (await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--tf-text-scale").trim())) === "1");
    if (pinched) {
        await closeLightbox();
    }
}

async function textScale(frame) {
    return frame.evaluate(() => ({
        scale: getComputedStyle(document.documentElement).getPropertyValue("--tf-text-scale").trim(),
        font: parseFloat(getComputedStyle(document.querySelector(".note-detail-editable-text .ck-content") ?? document.body).fontSize),
        heading: parseFloat(getComputedStyle(document.querySelector(".note-detail-editable-text .ck-content h2") ?? document.body).fontSize),
        chrome: parseFloat(getComputedStyle(document.querySelector("#launcher-pane") ?? document.body).fontSize)
    }));
}

async function scaleChecks(session, ids, demo) {
    const { frame, touch } = session;
    await gotoNote(frame, ids.playground);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(600);
    // Both fingers on running text: the image further down has a pinch of its own.
    await frame.evaluate(() => [ ...document.querySelectorAll(".note-detail-editable-text .ck-content p") ]
        .find((p) => p.textContent.includes("second paragraph"))?.scrollIntoView({ block: "center" }));
    await sleep(400);
    const before = await textScale(frame);
    await touch.pinch({ x: 200, y: 450 }, 120, 200);
    await sleep(900);
    const after = await textScale(frame);
    check("pinch on a text note grows the reading size, headings too, not the chrome",
        Number(after.scale) > 1.3 && after.font > before.font * 1.3 && after.heading > before.heading * 1.3 && after.chrome === before.chrome,
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    await touch.pinch({ x: 200, y: 450 }, 200, 120 * Number(after.scale) / Number(after.scale) * 1.0);
    await sleep(900);
    const snapped = await textScale(frame);
    check("pinching back lands on 100 %", Number(snapped.scale) === 1, snapped.scale);
    const hapticSnap = (await session.page.evaluate(() => window.__tfLog.filter((e) => e.method === "haptic").map((e) => e.params.kind))).includes("light");
    check("haptic messages are sent (lift, snap)", hapticSnap);

    await touch.pinch({ x: 200, y: 450 }, 100, 140);
    await sleep(1200);
    const saved = await textScale(frame);

    const again = await openNotebook(session.page.browserContext().browser(), { as: "alice", layout: "phone", mode: MODE });
    await gotoNote(again.frame, ids.playground);
    await again.frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(800);
    const reloaded = await textScale(again.frame);
    const bob = await openNotebook(session.page.browserContext().browser(), { as: "bob", layout: "phone", mode: MODE });
    const bobScale = await bob.frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--tf-text-scale").trim());
    check("the reading size persists for that person and not for another", reloaded.scale === saved.scale && saved.scale !== "1" && bobScale === "1",
        `alice ${saved.scale} -> ${reloaded.scale}, bob ${bobScale}`);
    await bob.context.close();

    const menu = await centerOf(again.frame, ".note-actions .dropdown-toggle, .note-actions button");
    if (menu) {
        await again.touch.tap(menu.x, menu.y);
        await sleep(900);
    }
    const row = await again.frame.evaluate(() => {
        const r = document.querySelector(".tf-text-size-row");
        return r ? r.textContent : null;
    });
    if (row) {
        const reset = await centerOf(again.frame, ".tf-text-size-row .bx-reset");
        await again.touch.tap(reset.x, reset.y);
        await sleep(400);
    }
    await shot(again.page, "text-size-row-phone");
    const afterReset = await textScale(again.frame);
    check("the note menu has a Text size row whose reset goes back to 100 %", !!row && afterReset.scale === "1", `${row} / ${afterReset.scale}`);
    await again.frame.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await again.context.close();

    if (demo.mindMap) {
        await gotoNote(frame, demo.mindMap);
        await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
        await sleep(2000);
        const read = () => frame.evaluate(() => document.querySelector(".map-canvas")?.style.transform ?? "");
        const z0 = await read();
        const c = await centerOf(frame, ".map-container");
        await touch.pinch({ x: c.x, y: c.y }, 100, 200);
        await sleep(500);
        const z1 = await read();
        const scaleOf = (transform) => Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? "1");
        check("pinch on a mind map changes its zoom", scaleOf(z1) > scaleOf(z0) * 1.3, `${z0} -> ${z1}`);
        await touch.twoFingerPan({ x: c.x, y: c.y }, 120, 60, 40);
        await sleep(500);
        const z2 = await read();
        const translateOf = (transform) => /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(transform)?.slice(1).map(Number) ?? [ 0, 0 ];
        const [ x1, y1 ] = translateOf(z1);
        const [ x2, y2 ] = translateOf(z2);
        check("two-finger drag on a mind map pans it", x2 - x1 > 20 && y2 - y1 > 12 && scaleOf(z2) === scaleOf(z1), `${z1} -> ${z2}`);
    }

    await gotoNote(frame, ids.relationMap);
    await sleep(1500);
    const rmRead = () => frame.evaluate(() => document.querySelector(".relation-map-content")?.style.transform ?? "");
    const r0 = await rmRead();
    const rc = await centerOf(frame, ".relation-map-viewport");
    if (rc) {
        await touch.pinch({ x: rc.x, y: rc.y }, 100, 180);
        await sleep(500);
    }
    const r1 = await rmRead();
    check("pinch on a relation map changes its zoom", rc && r1 !== r0, `${r0} -> ${r1}`);
    return session;
}

async function keyboardChecks(session, ids) {
    const { frame, page, touch } = session;
    await gotoNote(frame, ids.long);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(900);
    const last = await paragraphBox(frame, "Paragraph 80");
    await frame.evaluate(() => document.querySelector(".ck-content p:last-child")?.scrollIntoView({ block: "end" }));
    await sleep(300);
    const box = await paragraphBox(frame, "Paragraph 80");
    await touch.tap(box.right - 30, box.bottom - 8);
    await sleep(500);
    await frame.evaluate(() => {
        const editor = document.querySelector(".note-detail-editable-text .ck-editor__editable").ckeditorInstance;
        editor.model.change((w) => w.setSelection(w.createPositionAt(editor.model.document.getRoot(), "end")));
        editor.editing.view.focus();
    });
    for (const how of [ "shrink", "overlay" ]) {
        await page.evaluate((h) => window.__tfHost.setKeyboard(320, h), how);
        await sleep(1200);
        const state = await frame.evaluate((h) => {
            const sel = document.getSelection();
            const rects = sel?.rangeCount ? sel.getRangeAt(0).getClientRects() : [];
            const rect = rects.length ? rects[rects.length - 1] : sel?.focusNode?.parentElement?.getBoundingClientRect();
            const toolbar = document.querySelector(".classic-toolbar-island")?.getBoundingClientRect();
            const limit = h === "overlay" ? window.innerHeight - 320 : window.innerHeight;
            const toolbarTop = toolbar && toolbar.height ? toolbar.top : limit;
            return { caretBottom: rect?.bottom ?? -1, caretTop: rect?.top ?? -1, toolbarTop, toolbarBottom: toolbar?.bottom ?? null, limit, h: window.innerHeight };
        }, how);
        await shot(page, `keyboard-${how}-phone`);
        check(`caret stays visible above the toolbar with the keyboard (${how})`,
            state.caretBottom > 0 && state.caretBottom <= Math.min(state.toolbarTop, state.limit) && state.caretTop >= 0, JSON.stringify(state));
        check(`formatting toolbar sits right above the keyboard (${how})`,
            state.toolbarBottom !== null && Math.abs(state.toolbarBottom - state.limit) <= 24, JSON.stringify(state));
        await page.evaluate(() => window.__tfHost.setKeyboard(0));
        await sleep(600);
    }

    const sizes = await frame.evaluate(() => [ ...document.querySelectorAll("input:not([type=checkbox], [type=radio], [type=hidden]), textarea") ]
        .filter((i) => i.getClientRects().length).map((i) => parseFloat(getComputedStyle(i).fontSize)));
    check("text fields are at least 16 px (no iOS zoom on focus)", sizes.length > 0 && sizes.every((s) => s >= 16), sizes.join(","));
    void last;
}

/** The tree's edge swipe, the launch bar's tab swipe, overscroll and a rotation. */
async function gestureChecks(session, ids) {
    const { frame, page, touch } = session;
    const screen = () => frame.evaluate(() => window.glob.appContext.components.find((c) => "activeScreen" in c)?.activeScreen);
    await gotoNote(frame, ids.playground);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(900);
    const before = await screen();
    await touch.drag({ x: 4, y: 400 }, [ { x: 320, y: 405 } ], { steps: 10 });
    await sleep(900);
    const after = await screen();
    check("a swipe from the left edge brings the tree back", before === "detail" && after === "tree", `${before} -> ${after}`);

    await gotoNote(frame, ids.playground);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await frame.evaluate((id) => window.glob.appContext.tabManager.openContextWithNote(id, { activate: false }), ids.alpha);
    await sleep(1200);
    const active = () => frame.evaluate(() => window.glob.appContext.tabManager.getActiveContext()?.note?.title);
    const t0 = await active();
    const bar = await frame.evaluate(() => {
        const r = document.querySelector("#launcher-pane")?.getBoundingClientRect();
        return r ? { x: r.left + r.width * 0.75, y: r.top + r.height / 2, swipe: document.querySelector("#launcher-pane").classList.contains("tab-swipe") } : null;
    });
    await touch.drag(bar, [ { x: bar.x - 220, y: bar.y } ], { steps: 8 });
    await sleep(1500);
    const t1 = await active();
    check("a quick swipe along the launch bar switches tabs (press preview stays out of it)", bar.swipe && t0 !== t1, `${JSON.stringify(bar)} ${t0} -> ${t1}`);
    await frame.evaluate(() => {
        const tm = window.glob.appContext.tabManager;
        for (const c of tm.getMainNoteContexts().slice(1)) {
            void tm.removeNoteContext(c.ntxId);
        }
    });
    await sleep(600);

    const overscroll = await frame.evaluate(() => ({
        html: getComputedStyle(document.documentElement).overscrollBehaviorY,
        body: getComputedStyle(document.body).overscrollBehaviorY,
        scroller: getComputedStyle(document.querySelector(".scrolling-container") ?? document.body).overscrollBehaviorY
    }));
    check("the frame never rubber-bands the host, scrollers contain their overscroll",
        overscroll.html === "none" && overscroll.body === "none" && overscroll.scroller === "contain", JSON.stringify(overscroll));

    await gotoNote(frame, ids.long);
    await frame.evaluate(() => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(900);
    await frame.evaluate(() => [ ...document.querySelectorAll(".ck-content p") ].find((p) => /^Paragraph 40\b/.test(p.textContent.trim()))?.scrollIntoView({ block: "start" }));
    await sleep(500);
    const topParagraph = () => frame.evaluate(() => {
        const mark = [ ...document.querySelectorAll(".ck-content p") ].find((p) => /^Paragraph 40\b/.test(p.textContent.trim()));
        const sc = mark?.closest(".scrolling-container");
        if (!sc) {
            return null;
        }
        const top = sc.getBoundingClientRect().top;
        return /^Paragraph \d+/.exec([ ...sc.querySelectorAll(".ck-content p") ].find((p) => p.getBoundingClientRect().bottom > top + 4)?.textContent.trim() ?? "")?.[0] ?? null;
    });
    const r0 = await topParagraph();
    const viewport = page.viewport();
    await page.setViewport({ ...viewport, width: viewport.height, height: viewport.width });
    await sleep(1200);
    const r1 = await topParagraph();
    await page.setViewport(viewport);
    await sleep(1200);
    const r2 = await topParagraph();
    check("rotating keeps the same paragraph at the top", !!r0 && r0 !== "Paragraph 1" && r1 === r0 && r2 === r0, `${r0} / ${r1} / ${r2}`);
}

async function tabletChecks(ids) {
    const tablet = await openNotebook(browser, { as: "alice", layout: "tablet", mode: MODE });
    await resetReorder(tablet.frame, ids);
    await gotoNote(tablet.frame, ids.alpha);
    await waitFor(() => rowCenter(tablet.frame, "Charlie"), 8000);
    await sleep(500);
    const alpha = await rowCenter(tablet.frame, "Alpha");
    const charlie = await rowCenter(tablet.frame, "Charlie");
    await tablet.touch.drag(alpha, [ { x: alpha.x, y: charlie.bottom - 4, wait: 150 } ], { holdMs: 420, release: false });
    await shot(tablet.page, "navigator-mid-drag-tablet");
    await tablet.touch.dispatch("touchEnd", []);
    await sleep(1500);
    const order = await childTitles(tablet.frame, ids.reorder);
    check("tablet (1024 x 768, mobile layout): navigator drag moves a note", order.join(",") === "Bravo,Charlie,Alpha,Delta folder", order.join(","));

    await gotoNote(tablet.frame, ids.playground);
    await sleep(1200);
    // A drop and a paste from another app: what Split View on an iPad or a drag on Android hands over.
    const editorText = () => tablet.frame.evaluate(() => document.querySelector(".note-detail-editable-text .ck-content")?.textContent ?? "");
    const target = await tablet.frame.evaluate(() => {
        const p = [ ...document.querySelectorAll(".note-detail-editable-text .ck-content p") ].find((el) => el.textContent.includes("third paragraph"));
        const r = p?.getBoundingClientRect();
        return r ? { x: r.right - 4, y: r.top + r.height / 2 } : null;
    });
    const offset = await tablet.page.evaluate(() => {
        const r = document.getElementById("frame").getBoundingClientRect();
        return { x: r.left, y: r.top };
    });
    const data = { items: [ { mimeType: "text/plain", data: "Dropped from another app" } ], dragOperationsMask: 1 };
    for (const type of [ "dragEnter", "dragOver", "drop" ]) {
        await tablet.cdp.send("Input.dispatchDragEvent", { type, x: target.x + offset.x, y: target.y + offset.y, data });
        await sleep(120);
    }
    await sleep(600);
    const dropped = (await editorText()).includes("Dropped from another app");
    await tablet.frame.evaluate(() => {
        const editable = document.querySelector(".note-detail-editable-text .ck-editor__editable");
        editable.ckeditorInstance.editing.view.focus();
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "Pasted from another app");
        editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    });
    await sleep(600);
    const pasted = (await editorText()).includes("Pasted from another app");
    check("tablet: text dropped or pasted from another app lands in the note", dropped && pasted, `drop ${dropped}, paste ${pasted}`);
    await tablet.frame.evaluate(() => {
        const editor = document.querySelector(".note-detail-editable-text .ck-editor__editable").ckeditorInstance;
        editor.setData(editor.getData().replaceAll("Dropped from another app", "").replaceAll("Pasted from another app", ""));
    });
    await sleep(1500);
    await tablet.frame.evaluate(() => document.querySelector(".note-detail-editable-text .ck-editor__editable")?.ckeditorInstance?.editing.view.focus());
    await tablet.page.evaluate(() => window.__tfHost.setKeyboard(300, "overlay"));
    await sleep(1200);
    const tabletToolbar = await tablet.frame.evaluate(() => document.querySelector(".classic-toolbar-island")?.getBoundingClientRect().bottom ?? null);
    await shot(tablet.page, "keyboard-overlay-tablet");
    check("tablet: formatting toolbar sits right above a covering keyboard", tabletToolbar !== null && Math.abs(tabletToolbar - (768 - 300)) <= 24, String(tabletToolbar));
    await tablet.page.evaluate(() => window.__tfHost.setKeyboard(0));
    await sleep(500);
    await tablet.frame.evaluate(() => document.activeElement?.blur?.());
    const tabletMenu = await centerOf(tablet.frame, ".note-actions .dropdown-toggle, .note-actions button");
    if (tabletMenu) {
        await tablet.touch.tap(tabletMenu.x, tabletMenu.y);
        await sleep(900);
    }
    const tabletRow = await tablet.frame.evaluate(() => document.querySelector(".tf-text-size-row")?.textContent ?? null);
    await shot(tablet.page, "text-size-row-tablet");
    check("tablet: the note menu has the Text size row", !!tabletRow, String(tabletRow));
    await tablet.context.close();

    const desk = await openNotebook(browser, { as: "alice", layout: "tablet", mode: MODE, query: "" , next: "/" });
    await desk.page.evaluate(() => {
        const params = new URLSearchParams(location.search);
        params.set("layout", "desktop");
        location.search = params.toString();
    });
    await sleep(500);
    const deskSession = await openFrameAfterReload(desk);
    const deskButton = await waitFor(() => deskSession.frame.evaluate(() => {
        const b = document.querySelector("[data-tf-taskforce]");
        const r = b?.getBoundingClientRect();
        return r && r.width ? { label: b.getAttribute("aria-label") ?? b.getAttribute("title"), w: Math.round(r.width), desktop: !!document.querySelector(".fancytree-container") } : null;
    }), 8000);
    check("Taskforce button renders in the desktop layout with data-tf-taskforce and the name Taskforce", deskButton?.desktop && deskButton.label === "Taskforce", JSON.stringify(deskButton));
    await resetReorder(deskSession.frame, ids);
    await gotoNote(deskSession.frame, ids.alpha);
    await sleep(1500);
    const node = (title) => deskSession.frame.evaluate((t) => {
        const span = [ ...document.querySelectorAll(".fancytree-node") ].find((s) => s.querySelector(".fancytree-title")?.textContent?.trim() === t);
        const r = span?.getBoundingClientRect();
        return r ? { x: r.left + 60, y: r.top + r.height / 2, bottom: r.bottom, h: r.height } : null;
    }, title);
    const a = await node("Alpha");
    const c = await node("Charlie");
    if (!a || !c) {
        check("tablet (desktop layout): tree shows the Reorder notes", false);
    } else {
        await deskSession.touch.drag(a, [ { x: a.x, y: c.bottom - 3, wait: 150 } ], { holdMs: 420, release: false });
        const mid = await deskSession.frame.evaluate(() => !!document.querySelector(".tf-insertion-line.is-shown"));
        await shot(deskSession.page, "tree-mid-drag-tablet");
        await deskSession.touch.dispatch("touchEnd", []);
        await sleep(2500);
        const treeOrder = await childTitles(deskSession.frame, ids.reorder);
        check("tablet (1024 x 768, touch, desktop layout): tree drag moves a note", mid && treeOrder.join(",") === "Bravo,Charlie,Alpha,Delta folder", `${mid} / ${treeOrder.join(",")}`);
    }
    await deskSession.context.close();
}

function auditCheck() {
    const run = spawnSync(process.execPath, [ path.join(here, "tf-touch-audit.mjs"), "--quiet" ], { encoding: "utf-8", timeout: 600_000 });
    const summary = /SUMMARY (.*)/.exec(run.stdout ?? "")?.[1] ?? "no summary";
    check("no interactive element under 44 px on the audited route (tf-touch-audit.mjs)", run.status === 0, summary);
}
