/**
 * End-to-end run of Taskforce Notes against a stock (non-embedded) engine behind the gateway stub:
 *
 *   1. a throwaway "stock Trilium" database is made by a stock server with the demo notes;
 *   2. the engine (a stock server, empty notebook) and the gateway stub start;
 *   3. the built app (`TF_DESKTOP=1 pnpm --filter desktop build`) opens on the connect screen,
 *      takes a connect link that allows replacing, brings the stock notes along (in parts), redeems
 *      the code, syncs the notebook down and opens the notes;
 *   4. a note written on the desktop reaches the engine;
 *   5. the device is revoked: sync stops and the notice shows;
 *   6. "Disconnect this Mac" in Settings, and the next start opens on the connect screen.
 *
 * Every screen on the way is photographed in the light and the dark macOS appearance (the app's
 * `nativeTheme.themeSource` is switched, Playwright's colour-scheme emulation is off), as the page
 * and, where macOS allows it, as the real window with `screencapture -l`. Each photo also gets a
 * contrast reading of its text, icons and progress bars against their real backdrop.
 *
 * Usage: node apps/desktop/e2e-tf/run.mjs <work dir> <engine port> <stock port> <gateway port> <app port>
 * Screenshots and `report.json` land in `<work dir>/out`. Test-only; touches nothing outside the
 * work dir.
 */
import Database from "better-sqlite3";
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { _electron as electron } from "@playwright/test";
import { fileURLToPath } from "url";

import { sha256, startGatewayStub } from "./gateway_stub.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const [ workArg, enginePort, stockPort, gatewayPort, appPort ] = process.argv.slice(2);
if (!workArg || !appPort) {
    console.error("usage: run.mjs <work dir> <engine port> <stock port> <gateway port> <app port>");
    process.exit(64);
}
const work = path.resolve(workArg);
const out = path.join(work, "out");
for (const dir of [ "engine", "stock", "tf-data", "out" ]) {
    fs.rmSync(path.join(work, dir), { recursive: true, force: true });
    fs.mkdirSync(path.join(work, dir), { recursive: true });
}
const report = { steps: [] };
const step = (name, data = {}) => {
    report.steps.push({ name, at: new Date().toISOString(), ...data });
    console.log(`[e2e] ${name}`, Object.keys(data).length ? JSON.stringify(data) : "");
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- stock servers -----------------------------------------------------------------------------

function startServer(dataDir, port, name) {
    const child = spawn(process.execPath, [ "--import", "tsx", "./src/main.ts" ], {
        cwd: path.join(repo, "apps/server"),
        env: {
            PATH: process.env.PATH, HOME: process.env.HOME,
            NODE_ENV: "development", TRILIUM_ENV: "dev", TRILIUM_RESOURCE_DIR: "src",
            TRILIUM_DATA_DIR: dataDir, TRILIUM_PORT: String(port)
        },
        stdio: [ "ignore", "pipe", "pipe" ]
    });
    const logFile = fs.createWriteStream(path.join(out, `${name}.log`), { flags: "a" });
    child.stdout.pipe(logFile);
    child.stderr.pipe(logFile);
    return child;
}

async function waitFor(fn, timeoutMs, label) {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (e) {
            last = e;
        }
        await sleep(500);
    }
    throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

const status = (port) => fetch(`http://127.0.0.1:${port}/api/setup/status`).then((r) => r.json());

async function newDocument(port, withDemo) {
    await waitFor(() => status(port), 120_000, `server on ${port}`);
    const response = await fetch(`http://127.0.0.1:${port}/api/setup/new-document${withDemo ? "" : "?skipDemoDb"}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    if (!response.ok) throw new Error(`new-document on ${port}: ${response.status} ${await response.text()}`);
    await waitFor(async () => (await status(port)).isInitialized, 120_000, `initialized on ${port}`);
}

function stop(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000);
    });
}

const APPEARANCES = [ "light", "dark" ];
report.screens = [];
let windowCaptureWorks = true;

/**
 * Photographs `page` in both appearances, with the contrast reading of each. `scope` limits the
 * reading to the parts of a notes window this app adds (Settings > Sync, the notice). `mustShow`
 * is text that has to be on screen in both photos, for states that pass on their own.
 */
async function shoot(page, name, scope, mustShow) {
    for (const look of APPEARANCES) {
        await app.evaluate(({ ipcMain, nativeTheme }, source) => {
            // Stands in for the macOS appearance: the page asks for "system" after every theme
            // change, which here means the appearance under test.
            const state = globalThis;
            state.tfTestAppearance = source;
            if (!state.tfTestAppearanceHooked) {
                state.tfTestAppearanceHooked = true;
                ipcMain.removeAllListeners("set-native-theme-source");
                ipcMain.on("set-native-theme-source", (_event, requested) => {
                    nativeTheme.themeSource = requested === "system" ? state.tfTestAppearance : requested;
                });
            }
            nativeTheme.themeSource = source;
        }, look);
        await page.waitForFunction((dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark, look === "dark", { timeout: 5000 });
        await page.waitForFunction((dark) => document.body.classList.contains(dark ? "dark-theme" : "light-theme"), look === "dark", { timeout: 5000 }).catch(() => {});
        await sleep(500);
        const file = path.join(out, `${name}-${look}.png`);
        if (mustShow) await page.getByText(mustShow).first().waitFor({ timeout: 2000 });
        await page.screenshot({ path: file });
        const windowFile = await captureWindow(page, path.join(out, `${name}-${look}-window.png`));
        if (mustShow) await page.getByText(mustShow).first().waitFor({ timeout: 1000 });
        const contrast = await page.evaluate(measureContrast, scope ?? null);
        report.screens.push({ name, look, file, windowFile, contrast });
        const failing = contrast.failures.length ? ` FAIL ${JSON.stringify(contrast.failures.slice(0, 5))}` : "";
        console.log(`[e2e] screen ${name} (${look}): text ${contrast.minText}, icons ${contrast.minIcon}, bars ${contrast.minBar}${failing}`);
    }
}

/** The real window, vibrancy and all, when this process may record the screen. */
async function captureWindow(page, file) {
    if (!windowCaptureWorks) return null;
    try {
        const handle = await app.browserWindow(page);
        const sourceId = await handle.evaluate((win) => win.getMediaSourceId());
        const id = /^window:(\d+):/.exec(sourceId)?.[1];
        if (!id) throw new Error(`no window id in ${sourceId}`);
        execFileSync("screencapture", [ "-x", "-o", `-l${id}`, file ], { stdio: "pipe" });
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error("empty capture");
        return file;
    } catch (e) {
        windowCaptureWorks = false;
        report.windowCapture = `not available: ${e instanceof Error ? e.message : String(e)}`;
        return null;
    }
}

/**
 * Runs in the page: the WCAG contrast of every visible text run (4.5:1), icon (3:1) and progress
 * bar fill (3:1) against the colour behind it, found by compositing the backgrounds of its
 * ancestors over the page's own. Disabled controls are exempt, as WCAG allows.
 */
function measureContrast(scope) {
    const parse = (value) => {
        let m = /^rgba?\(([^)]+)\)$/.exec(value);
        if (m) {
            const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
            return [ p[0], p[1], p[2], p.length > 3 ? p[3] : 1 ];
        }
        m = /^color\(srgb ([^)]+)\)$/.exec(value);
        if (m) {
            const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
            return [ p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1 ];
        }
        return null;
    };
    const over = (top, bottom) => {
        const a = top[3];
        return [ 0, 1, 2 ].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
    };
    const lum = (c) => {
        const [ r, g, b ] = c.slice(0, 3).map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
        const [ hi, lo ] = [ lum(a), lum(b) ].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };
    // Under the window material the page is transparent; the theme's main surface stands in for it.
    const pageBg = parse(getComputedStyle(document.documentElement).backgroundColor) ?? [ 0, 0, 0, 0 ];
    const probe = document.createElement("div");
    probe.style.color = "var(--main-background-color)";
    document.body.appendChild(probe);
    const surface = parse(getComputedStyle(probe).color) ?? [ 255, 255, 255, 1 ];
    probe.remove();
    const rootBg = pageBg[3] < 1 ? over(pageBg, surface[3] < 1 ? over(surface, [ 255, 255, 255, 1 ]) : surface) : pageBg;
    const backdrop = (el) => {
        const chain = [];
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) chain.push(node);
        let bg = rootBg;
        for (const node of chain.reverse()) {
            const c = parse(getComputedStyle(node).backgroundColor);
            if (c && c[3] > 0) bg = over(c, bg);
        }
        return bg;
    };
    const opacity = (el) => {
        let o = 1;
        for (let node = el; node; node = node.parentElement) o *= Number(getComputedStyle(node).opacity);
        return o;
    };
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && opacity(el) > 0.05;
    };
    const exempt = (el) => !!el.closest(".disabled, [disabled], [aria-disabled='true'], .sync-illustration-arrows");
    const results = { text: [], icon: [], bar: [] };
    const measure = (kind, el, color, bg) => {
        const fg = parse(color);
        if (!fg) return;
        const o = opacity(el);
        const c = over([ fg[0], fg[1], fg[2], fg[3] * o ], bg);
        const label = (el.textContent ?? "").trim().slice(0, 40) || el.className.toString().slice(0, 40);
        results[kind].push({ label, ratio: Math.round(ratio(c, bg) * 100) / 100 });
    };
    const elements = scope
        ? [ ...document.querySelectorAll(scope) ].flatMap((root) => [ root, ...root.querySelectorAll("*") ])
        : [ ...document.querySelectorAll("body *") ];
    for (const el of elements) {
        if (!visible(el) || exempt(el)) continue;
        if (el.matches(".tn-icon, .bx, [class^='bx-'], [class*=' bx-']")) {
            measure("icon", el, getComputedStyle(el).color, backdrop(el));
            continue;
        }
        if (el.matches(".admonition") && getComputedStyle(el, "::before").content !== "none" && getComputedStyle(el, "::before").content !== '""') {
            measure("icon", el, getComputedStyle(el, "::before").color, backdrop(el));
        }
        if (el.matches(".tn-progress-bar")) {
            measure("bar", el, getComputedStyle(el, "::after").backgroundColor, backdrop(el.parentElement ?? el));
            continue;
        }
        const ownText = [ ...el.childNodes ].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        const isInput = el.matches("input, textarea") && (el.value || el.placeholder);
        if (ownText || isInput) {
            measure("text", el, getComputedStyle(el).color, backdrop(el));
        }
    }
    const min = (list) => list.length ? Math.min(...list.map((r) => r.ratio)) : null;
    const failures = [
        ...results.text.filter((r) => r.ratio < 4.5).map((r) => ({ kind: "text", ...r })),
        ...results.icon.filter((r) => r.ratio < 3).map((r) => ({ kind: "icon", ...r })),
        ...results.bar.filter((r) => r.ratio < 3).map((r) => ({ kind: "bar", ...r }))
    ];
    return { minText: min(results.text), minIcon: min(results.icon), minBar: min(results.bar), counts: { text: results.text.length, icon: results.icon.length, bar: results.bar.length }, failures };
}

const children = [];
let app;
try {
    // 1. The throwaway stock Trilium database.
    const stockDir = path.join(work, "stock");
    const stock = startServer(stockDir, stockPort, "stock");
    await newDocument(stockPort, true);
    await sleep(2000);
    await stop(stock);
    const stockFiles = () => Object.fromEntries(fs.readdirSync(stockDir).filter((f) => f.startsWith("document.db")).map((f) => [ f, sha256(path.join(stockDir, f)) ]));
    const stockBefore = stockFiles();
    const stockDb = new Database(path.join(stockDir, "document.db"), { readonly: true });
    const stockNotes = stockDb.prepare("SELECT COUNT(*) AS n FROM notes WHERE isDeleted = 0").get().n;
    stockDb.close();
    // The read above may have created side files; the hashes below are taken after it.
    const stockSnapshot = stockFiles();
    step("stock Trilium database made", { notes: stockNotes, files: Object.keys(stockBefore) });

    // 2. The engine and the gateway stub.
    const engineDir = path.join(work, "engine");
    const engineDb = path.join(engineDir, "document.db");
    let engine = startServer(engineDir, enginePort, "engine");
    children.push(() => engine);
    await newDocument(enginePort, false);
    const engineUrl = `http://127.0.0.1:${enginePort}`;
    const gateway = await startGatewayStub({
        port: Number(gatewayPort),
        engine: {
            url: engineUrl,
            dbPath: engineDb,
            async replaceDb(file) {
                await stop(engine);
                for (const suffix of [ "", "-wal", "-shm" ]) fs.rmSync(engineDb + suffix, { force: true });
                fs.renameSync(file, engineDb);
                engine = startServer(engineDir, enginePort, "engine");
                await waitFor(async () => (await status(enginePort)).isInitialized, 120_000, "engine after replace");
            }
        }
    });
    const stub = (route, body) => fetch(`${gateway.origin}/__stub/${route}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
    const { link } = await stub("pair", { replace: true });
    const { link: plainLink } = await stub("pair", { replace: false });
    step("engine and gateway stub up", { engine: engineUrl, gateway: gateway.origin });

    // 3. The app: connect screen, bring the stock notes, first sync.
    const tfData = path.join(work, "tf-data");
    const env = { ...process.env, TF_NOTES_DATA_DIR: tfData, TF_NOTES_PORT: String(appPort), TF_TEST_STOCK_TRILIUM_DIR: stockDir, ELECTRON_IS_DEV: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.TRILIUM_DATA_DIR;
    const launch = () => electron.launch({ args: [ path.join(repo, "apps/desktop/dist/main.mjs") ], env, timeout: 120_000, colorScheme: null });
    app = await launch();
    const connect = await app.firstWindow();
    await connect.getByText("Connect Taskforce Notes").waitFor({ timeout: 60_000 });
    const input = connect.locator("input").first();
    const continueButton = connect.getByRole("button", { name: "Continue" });
    const back = () => connect.locator(".back-button").click();
    await shoot(connect, "01-paste-link");
    step("connect screen shown");

    await input.fill("not a connect link");
    await continueButton.click();
    await connect.getByText("This is not a Taskforce Notes link").waitFor({ timeout: 10_000 });
    await shoot(connect, "02-bad-link");

    await stub("config", { updateDelayMs: 20_000 });
    await input.fill(plainLink);
    await continueButton.click();
    await connect.getByRole("status").getByText("Checking the link…").waitFor({ timeout: 5000 });
    await shoot(connect, "03-checking", undefined, "Checking the link…");
    await stub("config", { updateDelayMs: 0 });
    await connect.getByText("Ready to connect").waitFor({ timeout: 30_000 });
    await shoot(connect, "04-ready-to-connect");
    await back();

    await stub("config", { syncVersionOffset: 1 });
    await continueButton.click();
    await connect.getByText("This notebook needs another version of the app").waitFor({ timeout: 30_000 });
    await shoot(connect, "05-update-needed");
    await stub("config", { syncVersionOffset: 0 });
    await back();
    step("link, checking, ready and update-needed screens shown");

    await app.evaluate(() => { process.env.TF_TEST_STOCK_TRILIUM_RUNNING = "1"; });
    await input.fill(link);
    await continueButton.click();
    await connect.getByText("Bring along your Trilium notes").waitFor({ timeout: 30_000 });
    await connect.getByText("The Trilium app is open").waitFor({ timeout: 10_000 });
    await shoot(connect, "06-bring-quit-trilium");
    await app.evaluate(() => { process.env.TF_TEST_STOCK_TRILIUM_RUNNING = "0"; });
    await connect.getByRole("button", { name: "Check again" }).click();
    await connect.getByText("The Trilium app is open").waitFor({ state: "detached", timeout: 10_000 });
    await shoot(connect, "07-bring-along");
    step("replace offered, after quitting Trilium");

    await stub("config", { replaceDelayMs: 20_000, syncDelayMs: 4000 });
    const mainWindowPromise = app.waitForEvent("window", { timeout: 300_000 });
    await connect.getByText("Bring along the notes from the Trilium app on this Mac").click();
    await connect.getByText("The notebook is importing the notes").waitFor({ timeout: 60_000 });
    await shoot(connect, "08-bring-progress", undefined, "The notebook is importing the notes");
    await connect.getByText("Downloading the notes").waitFor({ timeout: 120_000 });
    await connect.locator(".tf-first-sync .sync-progress").first().waitFor({ timeout: 60_000 });
    await shoot(connect, "09-first-sync", undefined, "Downloading the notes");
    await stub("config", { failSync: true });
    await connect.getByText("The first sync stopped").waitFor({ timeout: 120_000 });
    await shoot(connect, "10-sync-failed", undefined, "The first sync stopped");
    await stub("config", { failSync: false, replaceDelayMs: 0 });
    await connect.getByRole("button", { name: "Retry" }).click();
    await connect.locator(".tf-first-sync .sync-progress span").filter({ hasText: /^[1-9]\d*%$/ }).first().waitFor({ timeout: 120_000 });
    await shoot(connect, "11-first-sync-progress");
    await stub("config", { syncDelayMs: 0 });
    step("bring progress, first sync, sync failed and Retry screens shown");
    const main = await mainWindowPromise;
    await main.waitForLoadState("domcontentloaded");
    await main.locator(".fancytree-title", { hasText: "Trilium Demo" }).first().waitFor({ timeout: 120_000 });
    await shoot(main, "12-notes-after-first-sync", "#toast-container .toast");
    step("first sync done, the stock notes are in the app");

    const info = await main.evaluate(() => window.electronApi.tfDesktop.getInfo());
    step("connection", { connected: info.connected, notebook: info.notebookName, person: info.userName, server: info.serverOrigin });

    // 4. A note written on the desktop reaches the engine.
    const title = `Written on the desktop ${Date.now()}`;
    const created = await main.evaluate(async (noteTitle) => {
        const response = await fetch("api/notes/root/children?target=into", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: noteTitle, type: "text", content: "<p>From Taskforce Notes</p>" })
        });
        return { status: response.status, body: await response.json() };
    }, title);
    if (created.status !== 200) throw new Error(`creating the note failed: ${JSON.stringify(created)}`);
    const noteId = created.body.note.noteId;
    await main.evaluate(() => fetch("api/sync/now", { method: "POST" }));
    const onEngine = await waitFor(() => {
        const db = new Database(engineDb, { readonly: true });
        try {
            return db.prepare("SELECT title FROM notes WHERE noteId = ? AND isDeleted = 0").get(noteId);
        } finally {
            db.close();
        }
    }, 120_000, "the note on the engine");
    step("desktop edit is on the engine", { noteId, title: onEngine.title });

    // Settings → Sync while connected.
    await main.evaluate(() => { location.hash = "#root/_hidden/_options/_optionsSync"; });
    await main.getByText("Disconnect this Mac").first().waitFor({ timeout: 30_000 });
    await shoot(main, "13-settings-connected", ".note-detail-content-widget-content.options");
    step("settings page shows the connection");

    // 5. Revoke: the next sync stops and the notice shows.
    await stub("revoke", {});
    await main.evaluate(() => fetch("api/sync/now", { method: "POST" }));
    await main.getByText("This Mac was disconnected from Taskforce").first().waitFor({ timeout: 90_000 });
    await shoot(main, "14-revoked-notice", "#toast-container .toast");
    const afterRevoke = await main.evaluate(() => window.electronApi.tfDesktop.getInfo());
    const proxiedBefore = gateway.log.filter((e) => e.status === "proxied" || typeof e.status === "number").length;
    await main.evaluate(() => fetch("api/sync/now", { method: "POST" }));
    await sleep(3000);
    const requestsAfterStop = gateway.log.length - proxiedBefore;
    step("revoked notice shown, sync stopped", { stop: afterRevoke.stop, requestsAfterStop });

    // 6. Disconnect this Mac, then the next start opens on the connect screen.
    await main.getByRole("button", { name: "Disconnect this Mac" }).click();
    await main.locator(".modal.show button.btn-primary, .modal.show button:has-text('OK'), .modal.show button:has-text('Yes')").first().click();
    await waitFor(async () => !(await main.evaluate(() => window.electronApi.tfDesktop.getInfo())).connected, 15_000, "disconnect");
    await shoot(main, "15-settings-disconnected", ".note-detail-content-widget-content.options");
    step("disconnected");
    await app.close();
    app = await launch();
    const again = await app.firstWindow();
    await again.getByText("This Mac is disconnected").waitFor({ timeout: 60_000 });
    await shoot(again, "16-connect-after-disconnect");
    step("next start opens on the connect screen, notes kept");
    await app.close();
    app = null;

    // What the gateway saw, and what the stock folder looks like now.
    const syncRequests = gateway.log.filter((e) => !e.path.startsWith("/__tf/"));
    const tfDb = new Database(path.join(tfData, "document.db"), { readonly: true });
    const tfOptions = tfDb.prepare("SELECT name, isSynced, length(value) AS length FROM options WHERE name LIKE 'tf%' ORDER BY name").all();
    const tfNotes = tfDb.prepare("SELECT COUNT(*) AS n FROM notes WHERE isDeleted = 0").get().n;
    tfDb.close();
    const engineCheck = new Database(engineDb, { readonly: true });
    const leakedOptions = engineCheck.prepare("SELECT name FROM options WHERE name LIKE 'tf%'").all();
    engineCheck.close();
    Object.assign(report, {
        gatewayLog: gateway.log,
        checks: {
            everySyncRequestHadDeviceKey: syncRequests.every((e) => !!e.device),
            noOriginHeader: gateway.log.every((e) => !e.origin),
            noSetupRoutes: !gateway.log.some((e) => e.path.startsWith("/api/setup")),
            replaceParts: gateway.log.filter((e) => e.path.startsWith("/__tf/desktop/replace")).map((e) => ({ path: e.path, bytes: e.bytes, status: e.status })),
            revokedAnswers: gateway.log.filter((e) => e.status === 401).length,
            stockFolderUnchanged: JSON.stringify(stockFiles()) === JSON.stringify(stockSnapshot),
            tfOptions,
            tfOptionsOnEngine: leakedOptions,
            tfNotes,
            stockNotes,
            screensWithContrastFailures: report.screens.filter((s) => s.contrast.failures.length).map((s) => `${s.name}-${s.look}`)
        }
    });
    step("checks", report.checks);
    await gateway.close();
} catch (e) {
    report.error = e instanceof Error ? e.stack : String(e);
    console.error(e);
    process.exitCode = 1;
    try {
        for (const win of app?.windows() ?? []) {
            await win.screenshot({ path: path.join(out, `failure-${Date.now()}.png`) });
        }
    } catch {
        // Screenshots of a failure are best effort.
    }
} finally {
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    if (app) await app.close().catch(() => {});
    for (const get of children) await stop(get());
    process.exit(process.exitCode ?? 0);
}
