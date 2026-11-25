/**
 * Shared puppeteer set-up for `tf-touch-audit.mjs` and `tf-phone-check.mjs`: launches Chrome for
 * Testing with touch emulation, opens the dev host (`tf-dev-host.mjs`) and returns the frame of the
 * embedded notebook, plus touch helpers over CDP `Input.dispatchTouchEvent`.
 *
 * puppeteer-core comes from the Taskforce checkout (`TF_PUPPETEER_FROM`, default
 * `~/Apps/Taskforce-wt-notes/apps/worker/package.json`); Chrome from `PUPPETEER_EXECUTABLE_PATH`.
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const from = process.env.TF_PUPPETEER_FROM ?? path.join(os.homedir(), "Apps/Taskforce-wt-notes/apps/worker/package.json");
export const puppeteer = createRequire(from)("puppeteer-core");

export const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH
    ?? path.join(os.homedir(), ".agent-browser/browsers/chrome-148.0.7778.167/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

export const HOST = process.env.TF_DEV_HOST ?? "http://127.0.0.1:9783";
export const FRAME_ORIGIN = process.env.TF_DEV_FRAME ?? "http://127.0.0.1:9782";

export const VIEWPORTS = {
    phone: { width: 402, height: 874, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    tablet: { width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
};

export const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
export const TABLET_UA = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
    return puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: [ "--enable-unsafe-swiftshader", "--no-first-run", "--touch-events=enabled" ]
    });
}

/**
 * Opens the dev host as `as` in `layout` (phone | tablet) in a fresh browser context and waits for
 * the bridge handshake. Returns `{ context, page, frame, cdp, touch }`.
 */
export async function openNotebook(browser, { as = "alice", layout = "phone", mode = "light", next = "/", query = "" } = {}) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setUserAgent(layout === "tablet" ? TABLET_UA : PHONE_UA);
    await page.setViewport(VIEWPORTS[layout]);
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
    page.on("pageerror", (e) => console.error(`  [page error] ${String(e?.message ?? e).slice(0, 200)}`));
    await page.goto(`${HOST}/?as=${as}&layout=${layout}&mode=${mode}&chrome=0&next=${encodeURIComponent(next)}${query}`, { waitUntil: "load" });
    await waitForFrame(page);
    await waitFor(() => page.evaluate(() => window.__tfLog?.some((e) => e.method === "ready") && window.__tfHost?.connected), 30_000);
    // The frame navigates more than once on the way in (enter, then the app); a handle taken
    // early can be the document that is about to be replaced. Look the frame up again on every
    // try and keep the one that holds the running app.
    const frame = await waitFor(async () => {
        const f = page.frames().find((x) => x.url().startsWith(FRAME_ORIGIN) && !x.url().includes("/__tf/enter"));
        if (!f) return null;
        const up = await f.evaluate(() => !!document.querySelector("#root-widget") && document.documentElement.classList.contains("tf-embedded"));
        return up ? f : null;
    }, 45_000, 150);
    if (!frame) throw new Error("the notebook app did not come up in the frame");
    await sleep(1200);
    return { context, page, frame, cdp, touch: touchHelpers(page, cdp, frame) };
}

export async function waitForFrame(page) {
    for (let i = 0; i < 200; i++) {
        const frame = page.frames().find((f) => f.url().startsWith(FRAME_ORIGIN) && !f.url().includes("/__tf/enter"));
        if (frame) {
            try {
                await frame.waitForSelector("body", { timeout: 1000 });
                return frame;
            } catch {
                // Still navigating.
            }
        }
        await sleep(100);
    }
    throw new Error("notebook frame did not load");
}

export async function waitFor(fn, timeout = 10_000, interval = 100) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try {
            last = await fn();
            if (last) {
                return last;
            }
        } catch {
            // Retry until the timeout.
        }
        await sleep(interval);
    }
    return last;
}

/** Offset of the frame's viewport inside the page, for turning frame coordinates into page ones. */
export async function frameOffset(page) {
    return page.evaluate(() => {
        const r = document.getElementById("frame").getBoundingClientRect();
        return { x: r.left, y: r.top };
    });
}

function touchHelpers(page, cdp, frame) {
    const toPage = async (points) => {
        const off = await frameOffset(page);
        return points.map((p, i) => ({ x: p.x + off.x, y: p.y + off.y, id: p.id ?? i, radiusX: 4, radiusY: 4, force: 1 }));
    };
    const dispatch = async (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : await toPage(points) });

    return {
        dispatch,
        async tap(x, y) {
            await dispatch("touchStart", [ { x, y } ]);
            await sleep(40);
            await dispatch("touchEnd", []);
        },
        /** A long press through Chrome's gesture recognizer, which selects a word and fires `contextmenu`. */
        async longPress(x, y, ms = 900) {
            const [ p ] = await toPage([ { x, y } ]);
            await cdp.send("Input.synthesizeTapGesture", { x: p.x, y: p.y, duration: ms, tapCount: 1, gestureSourceType: "touch" });
        },
        async press(x, y, ms) {
            await dispatch("touchStart", [ { x, y } ]);
            await sleep(ms);
            await dispatch("touchEnd", []);
        },
        /** Press at `from`, hold `holdMs`, move to each point in `path` (`{x, y, wait}`), release. */
        async drag(from, path, { holdMs = 0, steps = 8, release = true } = {}) {
            await dispatch("touchStart", [ from ]);
            if (holdMs) {
                await sleep(holdMs);
            }
            let last = from;
            for (const point of path) {
                for (let i = 1; i <= steps; i++) {
                    const p = { x: last.x + (point.x - last.x) * i / steps, y: last.y + (point.y - last.y) * i / steps };
                    await dispatch("touchMove", [ p ]);
                    await sleep(16);
                }
                last = point;
                if (point.wait) {
                    await sleep(point.wait);
                    await dispatch("touchMove", [ point ]);
                }
            }
            if (release) {
                await dispatch("touchEnd", []);
            }
        },
        /** Two fingers from `distance0` apart to `distance1` apart around `center`. */
        async pinch(center, distance0, distance1, { steps = 12, angle = 0 } = {}) {
            const at = (d) => {
                const dx = Math.cos(angle) * d / 2;
                const dy = Math.sin(angle) * d / 2;
                return [ { x: center.x - dx, y: center.y - dy, id: 0 }, { x: center.x + dx, y: center.y + dy, id: 1 } ];
            };
            await dispatch("touchStart", at(distance0));
            for (let i = 1; i <= steps; i++) {
                await dispatch("touchMove", at(distance0 + (distance1 - distance0) * i / steps));
                await sleep(16);
            }
            await dispatch("touchEnd", []);
        },
        /** Two fingers held `distance` apart moving together by `dx`, `dy`. */
        async twoFingerPan(center, distance, dx, dy, { steps = 12 } = {}) {
            const at = (cx, cy) => [ { x: cx - distance / 2, y: cy, id: 0 }, { x: cx + distance / 2, y: cy, id: 1 } ];
            await dispatch("touchStart", at(center.x, center.y));
            for (let i = 1; i <= steps; i++) {
                await dispatch("touchMove", at(center.x + dx * i / steps, center.y + dy * i / steps));
                await sleep(16);
            }
            await dispatch("touchEnd", []);
        },
        frame
    };
}

/** Notes matching a Trilium search (`note.type = text`), as `{ noteId, title, type, parents }`. */
export async function findNotes(frame, searchString) {
    return frame.evaluate(async (q) => {
        const res = await fetch(`api/search?searchString=${encodeURIComponent(q)}`, { headers: window.glob.getHeaders?.() ?? {} });
        const ids = await res.json();
        const notes = await window.glob.froca.getNotes(ids.slice(0, 200), true);
        return notes.map((n) => ({ noteId: n.noteId, title: n.title, type: n.type, parents: n.getParentNoteIds() }));
    }, searchString);
}

/**
 * Creates the "Touch fixtures" subtree once (idempotent by title) and returns the ids by name:
 * `reorder` (Alpha, Bravo, Charlie, Delta folder > Echo), `playground` (wide table with a to-do
 * list in a cell, a to-do list, an image, an included note), `long` (80 paragraphs), `board`
 * (`#viewType=board`), `relationMap`, `code`.
 */
export async function ensureFixtures(frame) {
    return frame.evaluate(async () => {
        const headers = { ...(await window.glob.getHeaders()), "content-type": "application/json" };
        const froca = window.glob.froca;
        const call = async (method, url, body) => {
            const res = await fetch(`api/${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
            const text = await res.text();
            if (!res.ok) {
                throw new Error(`${method} ${url}: ${res.status} ${text}`);
            }
            return text ? JSON.parse(text) : null;
        };
        const childByTitle = async (parentId, title) => {
            const parent = await froca.getNote(parentId, true);
            for (const child of await parent.getChildNotes()) {
                if (child.title === title) {
                    return child.noteId;
                }
            }
            return null;
        };
        const ensure = async (parentId, title, extra = {}, labels = {}) => {
            const existing = await childByTitle(parentId, title);
            if (existing) {
                return existing;
            }
            const { note } = await call("POST", `notes/${parentId}/children?target=into`, { title, type: "text", content: "", ...extra });
            for (const [ name, value ] of Object.entries(labels)) {
                await call("PUT", `notes/${note.noteId}/set-attribute`, { type: "label", name, value });
            }
            await froca.reloadNotes([ parentId, note.noteId ]);
            return note.noteId;
        };

        const ids = {};
        ids.root = await ensure("root", "Touch fixtures", { content: "<p>Notes the touch checks use.</p>" });
        ids.reorder = await ensure(ids.root, "Reorder", { content: "<p>Drag the notes below.</p>" });
        for (const title of [ "Alpha", "Bravo", "Charlie" ]) {
            ids[title.toLowerCase()] = await ensure(ids.reorder, title, { content: `<p>${title} note.</p>` });
        }
        ids.delta = await ensure(ids.reorder, "Delta folder", { content: "<p>A folder.</p>" });
        ids.echo = await ensure(ids.delta, "Echo", { content: "<p>Inside the folder.</p>" });

        const imageNote = (await (await fetch(`api/search?searchString=${encodeURIComponent("note.type = image")}`, { headers })).json())[0];
        const image = imageNote ? await froca.getNote(imageNote) : null;
        const cells = (row) => Array.from({ length: 8 }, (_, i) => `<td>${row === 0 && i === 2
            ? "<ul class=\"todo-list\"><li><label class=\"todo-list__label\"><input type=\"checkbox\" disabled=\"disabled\"><span class=\"todo-list__label__description\">Cell task</span></label></li></ul>"
            : `Row ${row + 1} column ${i + 1} with some words`}</td>`).join("");
        const playground = [
            "<h2>Playground</h2>",
            "<p>The first paragraph has several plain words to select with a long press.</p>",
            "<p>The second paragraph is here to be moved with the block handle.</p>",
            "<p>The third paragraph closes the opening group.</p>",
            "<ul class=\"todo-list\"><li><label class=\"todo-list__label\"><input type=\"checkbox\" disabled=\"disabled\"><span class=\"todo-list__label__description\">Top-level task</span></label></li></ul>",
            `<figure class="table"><table><thead><tr>${Array.from({ length: 8 }, (_, i) => `<th>Heading ${i + 1}</th>`).join("")}</tr></thead><tbody><tr>${cells(0)}</tr><tr>${cells(1)}</tr></tbody></table></figure>`,
            image ? `<figure class="image"><img src="api/images/${image.noteId}/${encodeURIComponent(image.title)}"></figure>` : "",
            `<section class="include-note" data-note-id="${ids.alpha}" data-box-size="medium">&nbsp;</section>`,
            "<p>The last paragraph.</p>"
        ].join("");
        ids.playground = await ensure(ids.root, "Playground", { content: playground });
        ids.tasks = await ensure(ids.root, "Tasks", {
            content: "<ul class=\"todo-list\"><li><label class=\"todo-list__label\"><input type=\"checkbox\" disabled=\"disabled\"><span class=\"todo-list__label__description\">Included task</span></label></li></ul>"
        });
        ids.includes = await ensure(ids.root, "Includes", {
            content: `<p>The note below is included.</p><section class="include-note" data-note-id="${ids.tasks}" data-box-size="medium">&nbsp;</section><p>After the include.</p>`
        });
        ids.long = await ensure(ids.root, "Long text", {
            content: Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i + 1} of a long note, written to fill the screen several times over.</p>`).join("")
        });
        ids.board = await ensure(ids.root, "Board", { type: "book", content: "" }, { viewType: "board" });
        if (!(await childByTitle(ids.board, "Card one"))) {
            await ensure(ids.board, "Card one", {}, { status: "To Do" });
            await ensure(ids.board, "Card two", {}, { status: "Doing" });
        }
        ids.relationMap = await ensure(ids.root, "Relation map", {
            type: "relationMap",
            content: JSON.stringify({ notes: [ { noteId: ids.alpha, x: 80, y: 80 }, { noteId: ids.bravo, x: 260, y: 220 } ], transform: { x: 0, y: 0, scale: 1 } })
        });
        ids.code = await ensure(ids.root, "Sample code", { type: "code", mime: "application/javascript;env=frontend", content: Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join("\n") });
        return ids;
    });
}

/** Puts the "Reorder" fixture back to Alpha, Bravo, Charlie, Delta folder (> Echo). */
export async function resetReorder(frame, ids) {
    await frame.evaluate(async (ids) => {
        const headers = { ...(await window.glob.getHeaders()), "content-type": "application/json" };
        const froca = window.glob.froca;
        const call = async (method, url, body) => {
            const res = await fetch(`api/${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
            return res.ok ? res.json().catch(() => null) : null;
        };
        await froca.reloadNotes([ ids.reorder, ids.delta, ids.alpha, ids.bravo, ids.charlie, ids.echo ]);
        const reorder = await froca.getNote(ids.reorder);
        const reorderBranchId = reorder.getParentBranchIds()[0];
        for (const key of [ "alpha", "bravo", "charlie", "delta" ]) {
            const note = await froca.getNote(ids[key]);
            const parentId = note.getParentNoteIds()[0];
            if (parentId !== ids.reorder) {
                await call("PUT", `branches/move-to/${reorderBranchId}`, { branchIds: [ note.getParentBranchIds()[0] ] });
            }
        }
        const echo = await froca.getNote(ids.echo);
        if (echo.getParentNoteIds()[0] !== ids.delta) {
            const delta = await froca.getNote(ids.delta);
            await call("PUT", `branches/move-to/${delta.getParentBranchIds()[0]}`, { branchIds: [ echo.getParentBranchIds()[0] ] });
        }
        await froca.reloadNotes([ ids.reorder, ids.delta ]);
        const order = [ "alpha", "bravo", "charlie", "delta" ];
        for (let i = 1; i < order.length; i++) {
            const prev = (await froca.getNote(ids.reorder)).childToBranch[ids[order[i - 1]]];
            const cur = (await froca.getNote(ids.reorder)).childToBranch[ids[order[i]]];
            await call("PUT", `branches/${cur}/move-after/${prev}`);
            await froca.reloadNotes([ ids.reorder ]);
        }
    }, ids);
    await sleep(600);
}

/** Titles of the children of `parentId`, in tree order, read from the server. */
export async function childTitles(frame, parentId) {
    return frame.evaluate(async (id) => {
        await window.glob.froca.reloadNotes([ id ]);
        const note = await window.glob.froca.getNote(id);
        return (await note.getChildNotes()).map((n) => n.title);
    }, parentId);
}

/** Opens a note in the active tab and waits for its detail to render. */
export async function gotoNote(frame, noteId) {
    await frame.evaluate(async (id) => {
        const ctx = window.glob.appContext.tabManager.getActiveContext();
        await ctx.setNote(id);
    }, noteId);
    await sleep(900);
}

/** Centre of the first element matching `selector` in the frame, or `null`. */
export async function centerOf(frame, selector) {
    return frame.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) {
            return null;
        }
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }, selector);
}
