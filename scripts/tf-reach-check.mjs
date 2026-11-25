#!/usr/bin/env node
/**
 * End-to-end checks of the reach features (voice notes, share links that end, search in other
 * notebooks) through the RUNNING Taskforce stack: web (9777), API (9778), notes gateway
 * (9779 public, 9780 internal) and the engine build the manifest names as `current`.
 *
 *   node scripts/tf-reach-check.mjs [--shots <dir>] [--only voice,transcript,share,view,search,phone,denied,dark] [--keep]
 *
 * Makes throw-away people (Ada edits, Bea is a team member without access to Ada's private
 * project), a team project and a private project with a notes tab each, and removes them at the
 * end. Chrome runs with a fake microphone that plays a spoken WAV (`say`), so a real
 * MediaRecorder records real speech. Ada drives the real Taskforce page; Bea's view-role frame is
 * hosted by a stand-in page on the web origin (the API never mints a view role yet). One line per
 * check; exit code 1 when any check fails.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/** Enter tokens are signed with a key derived from the gateway secret, not with the secret itself. */
const enterTokenKey = (secret) => createHmac("sha256", secret).update("tf-notes-enter-token-v1").digest("hex");

const TF = process.env.TF_TASKFORCE ?? path.join(os.homedir(), "Apps/Taskforce-wt-notes");
const puppeteer = createRequire(path.join(TF, "apps/worker/package.json"))("puppeteer-core");
const postgres = createRequire(path.join(TF, "packages/db/package.json"))("postgres");
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH
    ?? path.join(os.homedir(), ".agent-browser/browsers/chrome-148.0.7778.167/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
};
const SHOTS = arg("shots");
const ONLY = arg("only")?.split(",") ?? null;
const KEEP = process.argv.includes("--keep");
const want = (group) => !ONLY || ONLY.includes(group);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

function loadEnv(file) {
    const out = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
}
const env = { ...loadEnv(path.join(TF, ".env")), ...process.env };
const WEB = "http://localhost:9777";
const API_PORT = Number(env.API_PORT ?? 9778);
const PUB = Number(env.NOTES_PUBLIC_PORT ?? 9779);
const INTERNAL = "http://127.0.0.1:9780";
const BASE = env.NOTES_BASE_DOMAIN ?? `localhost:${PUB}`;
const SECRET = env.NOTES_GATEWAY_SECRET;

// ── results ─────────────────────────────────────────────────────────────────
const results = [];
const t0 = Date.now();
function check(name, ok, detail = "") {
    results.push({ name, ok: !!ok });
    const time = `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
    console.log(`${time} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).replace(/\s+/g, " ").slice(0, 260)})` : ""}`);
    return !!ok;
}
const trace = (m) => process.env.TF_TRACE && console.error(`  [trace ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 250) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        try {
            last = await fn();
        } catch {
            last = null;
        }
        if (last) return last;
        await sleep(every);
    }
    return last;
}

// ── HTTP to the API and the gateway ─────────────────────────────────────────
function http(port, method, p, { host, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port, method, path: p, headers: { ...(host ? { host } : {}), ...headers } }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                let json = null;
                try {
                    json = text ? JSON.parse(text) : null;
                } catch { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        r.on("error", reject);
        r.end(body);
    });
}
const cookiesOf = (headers) => (headers["set-cookie"] ?? []).map((c) => c.split(";")[0]);

const sql = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });
const tag = `noteforce-reach-${randomUUID().slice(0, 8)}`;
const ada = { id: randomUUID(), email: `${tag}-ada@taskforce.local`, name: "Ada Reach" };
const bea = { id: randomUUID(), email: `${tag}-bea@taskforce.local`, name: "Bea Reach" };
const orgId = `org_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const ws = randomUUID();
const personalWs = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
const tasksA = randomUUID();
const tasksB = randomUUID();
const WORD = `quokka${randomUUID().replace(/-/g, "").slice(0, 6)}`;
const nb = { a: null, b: null };

async function setup() {
    for (const u of [ ada, bea ]) await sql`INSERT INTO "user" (id, email, name, "emailVerified") VALUES (${u.id}, ${u.email}, ${u.name}, true)`;
    await sql`INSERT INTO organization (id, name, slug, "aiLicensed") VALUES (${orgId}, ${tag}, ${tag}, true)`;
    for (const [ u, role ] of [ [ ada, "owner" ], [ bea, "member" ] ]) await sql`INSERT INTO member (id, "organizationId", "userId", role) VALUES (${randomUUID()}, ${orgId}, ${u.id}, ${role})`;
    await sql`INSERT INTO workspace (id, slug, name, kind, "legacyOrganizationId") VALUES (${ws}, ${tag + "-ws"}, ${tag}, 'team', ${orgId})`;
    await sql`INSERT INTO workspace (id, slug, name, kind, "personalOwnerId") VALUES (${personalWs}, ${tag + "-personal"}, ${tag + " personal"}, 'personal', ${ada.id})`;
    for (const [ w, u, role ] of [ [ ws, ada, "owner" ], [ ws, bea, "member" ], [ personalWs, ada, "owner" ] ]) await sql`INSERT INTO workspace_member ("workspaceId", "userId", role) VALUES (${w}, ${u.id}, ${role})`;
    await sql`INSERT INTO project (id, "organizationId", "workspaceId", name, slug, "createdById") VALUES (${projectA}, ${orgId}, ${ws}, ${"Reach launch"}, ${tag}, ${ada.id})`;
    await sql`INSERT INTO project (id, "organizationId", "workspaceId", name, slug, "createdById") VALUES (${projectB}, ${orgId}, ${personalWs}, ${"Ada private plans"}, ${tag + "-p"}, ${ada.id})`;
    const statusSet = [ { id: "st_todo", name: "Todo", color: "#a1a1aa", order: 0, category: "open" }, { id: "st_done", name: "Done", color: "#10b981", order: 1, category: "done" } ];
    // The assistant on for the throw-away organisation and Ada's agreement, so a transcript is really made.
    await sql`INSERT INTO feature_flag ("workspaceId", key, value) VALUES (${orgId}, 'ai_features_enabled', ${sql.json(true)})`;
    await sql`UPDATE "user" SET "aiConsentAt" = now(), "aiConsentVersion" = '2026-09-25' WHERE id = ${ada.id}`;
    for (const [ ds, p ] of [ [ tasksA, projectA ], [ tasksB, projectB ] ]) await sql`INSERT INTO data_source (id, "projectId", name, kind, "createdById", "statusSet") VALUES (${ds}, ${p}, 'Tasks', 'tasks', ${ada.id}, ${sql.json(statusSet)})`;
}

async function teardown() {
    for (const id of [ nb.a?.notebookId, nb.b?.notebookId ].filter(Boolean)) await apiCall(ada, "DELETE", `/api/notebooks/${id}`).catch(() => {});
    const projects = [ projectA, projectB ];
    await sql`DELETE FROM notification WHERE "userId" IN (${ada.id}, ${bea.id})`.catch(() => {});
    for (const table of [ "note_share_link", "note_search_doc" ]) {
        await sql.unsafe(`DELETE FROM ${table} WHERE "notebookId" IN (SELECT id FROM notebook WHERE "projectId" IN ($1, $2))`, projects).catch(() => {});
    }
    await sql`DELETE FROM notebook WHERE "projectId" IN (${projectA}, ${projectB})`.catch(() => {});
    await sql`DELETE FROM activity_log WHERE "projectId" IN (${projectA}, ${projectB})`.catch(() => {});
    await sql`DELETE FROM task WHERE "projectId" IN (${projectA}, ${projectB})`.catch(() => {});
    await sql`DELETE FROM saved_view WHERE "projectId" IN (${projectA}, ${projectB})`.catch(() => {});
    await sql`DELETE FROM data_source WHERE "projectId" IN (${projectA}, ${projectB})`.catch(() => {});
    await sql`DELETE FROM project WHERE id IN (${projectA}, ${projectB})`.catch(() => {});
    await sql`DELETE FROM workspace_member WHERE "workspaceId" IN (${ws}, ${personalWs})`.catch(() => {});
    await sql`DELETE FROM workspace WHERE id IN (${ws}, ${personalWs})`.catch(() => {});
    for (const table of [ "ai_call", "ai_budget", "feature_flag" ]) {
        await sql.unsafe(`DELETE FROM ${table} WHERE "workspaceId" = $1`, [ orgId ]).catch(() => {});
    }
    await sql`DELETE FROM member WHERE "organizationId" = ${orgId}`.catch(() => {});
    await sql`DELETE FROM session WHERE "userId" IN (${ada.id}, ${bea.id})`.catch(() => {});
    await sql`DELETE FROM organization WHERE id = ${orgId}`.catch(() => {});
    await sql`DELETE FROM "user" WHERE id IN (${ada.id}, ${bea.id})`.catch(() => {});
}

async function devLogin(p) {
    const r = await http(API_PORT, "GET", `/api/dev/login?email=${encodeURIComponent(p.email)}&token=${encodeURIComponent(env.DEV_LOGIN_TOKEN ?? "")}`);
    if (r.status !== 200) throw new Error(`dev login ${r.status} ${r.text.slice(0, 200)}`);
    p.cookie = cookiesOf(r.headers).join("; ");
    await sql`UPDATE session SET "activeOrganizationId" = ${orgId} WHERE "userId" = ${p.id}`;
    // Past onboarding, terms agreed and a PIN set, so the page opens on the notes tab.
    await sql`UPDATE "user" SET "onboardingCompletedAt" = now() WHERE id = ${p.id}`;
    const terms = await apiCall(p, "GET", "/api/me/terms");
    if (terms.json?.currentVersion) await apiCall(p, "POST", "/api/me/terms", { version: terms.json.currentVersion });
    await apiCall(p, "POST", "/api/secrets/pin", { pin: "246813" });
}
const apiCall = (p, method, url, body) => http(API_PORT, method, url, {
    headers: { cookie: p.cookie, origin: WEB, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
});
const hostOf = (id) => `nb-${id}.${BASE}`;
const originOf = (id) => `http://${hostOf(id)}`;

async function enter(p, notebookId) {
    const s = await apiCall(p, "POST", `/api/notebooks/${notebookId}/session`, { layout: "desktop" });
    if (s.status !== 200) throw new Error(`session ${s.status} ${s.text.slice(0, 200)}`);
    const u = new URL(s.json.url);
    const r = await http(PUB, "GET", `${u.pathname}${u.search}`, { host: hostOf(notebookId) });
    if (r.status !== 303) throw new Error(`enter ${r.status}`);
    return cookiesOf(r.headers).join("; ");
}
const tfApi = (cookie, notebookId, method, rest, body) => http(PUB, method, `/__tf/api/${rest}`, {
    host: hostOf(notebookId),
    headers: { cookie, ...(method !== "GET" ? { origin: originOf(notebookId) } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
});
async function engineCall(notebookId, method, p, body, who = ada) {
    const res = await fetch(`${INTERNAL}/internal/notebooks/${notebookId}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ method, path: p, body, userId: who.id, userName: who.name, role: "edit" })
    });
    const text = await res.text();
    try {
        return { status: res.status, json: JSON.parse(text) };
    } catch {
        return { status: res.status, text };
    }
}
function mintEnterToken(claims) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b64({ alg: "HS256", typ: "JWT" });
    const body = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 60, jti: randomUUID() });
    const sig = createHmac("sha256", enterTokenKey(SECRET)).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
}

// ── the browser ─────────────────────────────────────────────────────────────
const WAV = path.join(os.tmpdir(), `tf-reach-speech-${process.pid}.wav`);
execFileSync("say", [ "-o", WAV, "--data-format=LEI16@48000", "This is a voice note for the launch plan. Please order the boxes on Monday." ]);
const WAV_B64 = readFileSync(WAV).toString("base64");

const MEDIA_FLAGS = [ "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required" ];
// The view-role host page is answered by request interception, has no address, and counts as a
// public page, which Chrome's Local Network Access check would stop from framing a localhost notebook.
// Chrome's sandboxed audio service cannot read the fake microphone's WAV file and records silence.
const BASE_FLAGS = [ "--enable-unsafe-swiftshader", "--no-first-run", "--disable-features=LocalNetworkAccessChecks,AudioServiceSandbox" ];

/** Records every message the frame sends the host (the host's MessageChannel), on the top page only. */
const HOST_TEE = () => {
    if (window.top !== window) return;
    window.__hostGot = [];
    const Original = window.MessageChannel;
    window.MessageChannel = function () {
        const channel = new Original();
        channel.port1.addEventListener("message", (e) => window.__hostGot.push(e.data));
        return channel;
    };
    window.MessageChannel.prototype = Original.prototype;
};
/** A visual viewport whose height a check sets, as the phone keyboard shrinks it (phone-notes.mjs). */
const FAKE_VIEWPORT = () => {
    if (window.top !== window) return;
    const real = window.visualViewport;
    if (!real) return;
    const bus = new EventTarget();
    window.__vv = { height: null, offsetTop: null, fire: () => bus.dispatchEvent(new Event("resize")) };
    const fake = new Proxy(real, {
        get(t, k) {
            if (k === "height") return window.__vv.height ?? t.height;
            if (k === "offsetTop") return window.__vv.offsetTop ?? t.offsetTop;
            if (k === "addEventListener") return (...a) => (bus.addEventListener(...a), t.addEventListener(...a));
            if (k === "removeEventListener") return (...a) => (bus.removeEventListener(...a), t.removeEventListener(...a));
            const v = Reflect.get(t, k);
            return typeof v === "function" ? v.bind(t) : v;
        }
    });
    Object.defineProperty(window, "visualViewport", { get: () => fake, configurable: true });
};

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function openTab(browser, who, notebook, { phone = false, mode = "light", grantMic = true } = {}) {
    const context = await browser.createBrowserContext();
    if (grantMic) await context.overridePermissions(originOf(notebook.notebookId), [ "microphone", "clipboard-read", "clipboard-write" ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error(`  [page error] ${String(e?.message ?? e).slice(0, 200)}`));
    if (phone) {
        await page.setUserAgent(PHONE_UA);
        await page.setViewport(PHONE);
        await page.evaluateOnNewDocument(FAKE_VIEWPORT);
    } else {
        await page.setViewport({ width: 1440, height: 900 });
    }
    await page.emulateMediaFeatures([ { name: "prefers-color-scheme", value: mode } ]);
    await page.evaluateOnNewDocument(HOST_TEE);
    for (const c of who.cookie.split("; ")) {
        const [ k, ...v ] = c.split("=");
        await page.setCookie({ name: k, value: v.join("="), url: WEB });
    }
    await page.goto(`${WEB}/p/${notebook.projectId}?tab=table&view=${notebook.viewId}&overview=${notebook.tasks}`, { waitUntil: "domcontentloaded" });
    const bridge = await until(() => page.evaluate(() => document.querySelector("[data-testid=\"notes-tab\"]")?.getAttribute("data-bridge") === "ready"), 90000, 300);
    trace(`bridge ${bridge}`);
    if (!bridge) {
        const state = await page.evaluate(() => ({ bridge: document.querySelector("[data-testid=\"notes-tab\"]")?.getAttribute("data-bridge"), url: location.href, body: document.body.innerText.slice(0, 200) })).catch((e) => String(e));
        throw new Error(`the notebook frame never said ready ${JSON.stringify(state)}`);
    }
    const frame = await frameOf(page, originOf(notebook.notebookId), 20000);
    trace(`frame ${frame ? frame.url() : "none"}`);
    await until(() => frame.evaluate(() => document.documentElement.classList.contains("tf-embedded") && !!window.glob?.appContext?.tabManager?.getActiveContext()), 30000);
    await dismissDialogs(page);
    await sleep(800);
    return { context, page, frame };
}

/** Bea's view-role frame: a stand-in host page on the web origin, so the engine accepts its bridge. */
async function openViewFrame(browser, who, notebook) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const token = mintEnterToken({ nb: notebook.notebookId, uid: who.id, name: who.name, role: "view", org: orgId });
    const enterUrl = `${originOf(notebook.notebookId)}/__tf/enter?t=${encodeURIComponent(token)}&layout=desktop&next=%2F`;
    const html = `<!doctype html><html><body style="margin:0"><iframe id="f" allow="clipboard-read; clipboard-write; fullscreen; microphone" style="border:0;width:100vw;height:100vh" src="${enterUrl}"></iframe>
<script>
window.__hostGot = [];
const frame = document.getElementById("f");
addEventListener("message", (e) => {
  if (e.data?.type !== "tf-notes:hello" || e.source !== frame.contentWindow || window.__port) return;
  const ch = new MessageChannel();
  window.__port = ch.port1;
  ch.port1.onmessage = (m) => window.__hostGot.push(m.data);
  frame.contentWindow.postMessage({ type: "tf-notes:port" }, e.origin, [ ch.port2 ]);
  ch.port1.postMessage({ id: "h1", method: "init", params: { user: {}, viewport: { width: innerWidth, height: innerHeight, keyboardInset: 0, safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0, coarse: false }, shortcuts: [], tabName: "Notes", projectName: "Reach launch", locale: "en", canCreateTasks: false } });
});
</script></body></html>`;
    await page.setRequestInterception(true);
    page.on("request", (req) => {
        if (req.url().startsWith(`${WEB}/__tf-reach-host`)) {
            void req.respond({ status: 200, contentType: "text/html", body: html });
        } else {
            void req.continue();
        }
    });
    await page.goto(`${WEB}/__tf-reach-host`, { waitUntil: "domcontentloaded" });
    const frame = await frameOf(page, originOf(notebook.notebookId), 30000);
    if (!frame) {
        const seen = await Promise.all(page.frames().map(async (f) => `${f.url().slice(0, 90)} => ${await f.evaluate(() => document.body?.innerText.slice(0, 160)).catch((e) => String(e).slice(0, 80))}`));
        throw new Error(`the view frame did not load: ${seen.join(" | ")}`);
    }
    await until(() => frame.evaluate(() => document.documentElement.classList.contains("tf-embedded") && !!window.glob?.appContext?.tabManager?.getActiveContext()), 40000);
    await sleep(800);
    return { context, page, frame };
}

async function frameOf(page, origin, ms = 60000) {
    return until(async () => {
        const f = page.frames().find((fr) => fr.url().startsWith(origin) && !fr.url().includes("/__tf/enter"));
        if (!f) return null;
        return (await f.evaluate(() => document.readyState !== "loading" && !!document.querySelector("#root-widget"))) ? f : null;
    }, ms, 300);
}

async function dismissDialogs(page) {
    for (let i = 0; i < 12; i++) {
        const clicked = await page.evaluate(() => {
            const candidates = [ ...document.querySelectorAll("[role=\"dialog\"], [role=\"alertdialog\"], [data-sonner-toast], [role=\"status\"]") ]
                .filter((el) => !el.closest("[data-notes-surface]") && el.getBoundingClientRect().width > 0);
            for (const dialog of candidates) {
                const buttons = [ ...dialog.querySelectorAll("button") ];
                const button = buttons.find((b) => /^(next|got it|done|close|finish|ok|begrepen|sluiten|volgende|klaar)$/i.test((b.textContent ?? "").trim()))
                    ?? buttons.find((b) => /close|dismiss|sluiten/i.test(b.getAttribute("aria-label") ?? ""));
                if (button) {
                    button.click();
                    return true;
                }
            }
            return false;
        }).catch(() => false);
        if (!clicked) return;
        await sleep(350);
    }
}

const shot = async (page, name) => {
    if (!SHOTS) return;
    await sleep(250);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

/** `api/<url>` of the engine from inside the frame, as the client calls it. */
const frameApi = (frame, method, url, body) => frame.evaluate(async (m, u, b) => {
    const headers = { ...(await window.glob.getHeaders()), "content-type": "application/json" };
    const res = await fetch(`api/${u}`, { method: m, headers, body: b ? JSON.stringify(b) : undefined });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch { /* not json */ }
    return { status: res.status, json, text: json ? null : text.slice(0, 300) };
}, method, url, body ?? null);

async function makeNote(frame, title, content) {
    const r = await frameApi(frame, "POST", "notes/root/children?target=into", { title, type: "text", content });
    if (r.status !== 200) throw new Error(`create note ${r.status} ${r.text}`);
    await frame.evaluate((id) => window.glob.froca.reloadNotes([ "root", id ]), r.json.note.noteId);
    return r.json.note.noteId;
}

async function gotoNote(frame, noteId) {
    await frame.evaluate(async (id) => {
        await window.glob.appContext.tabManager.getActiveContext().setNote(id);
    }, noteId);
    return until(() => frame.evaluate(async (id) => {
        const editor = await window.glob.appContext.tabManager.getActiveContext().getTextEditor();
        return !!editor && editor.config.get("getNoteId")?.() === id && !!editor.ui.view.editable.element?.isConnected;
    }, noteId), 15000);
}

/** Puts the caret at the end of the `index`th block of the active text editor and focuses it. */
const caretAtEndOf = (frame, index) => frame.evaluate(async (i) => {
    const editor = await window.glob.appContext.tabManager.getActiveContext().getTextEditor();
    editor.editing.view.focus();
    const block = () => editor.model.document.getRoot().getChild(i);
    for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 60));
        editor.model.change((w) => w.setSelection(w.createPositionAt(block(), "end")));
        await new Promise((r) => setTimeout(r, 60));
        const at = editor.model.document.selection.getFirstPosition();
        if (at?.parent === block() && at.isAtEnd) return true;
    }
    return false;
}, index);

const noteContent = async (frame, noteId) => (await frameApi(frame, "GET", `notes/${noteId}/blob`)).json?.content ?? "";
const hostGot = (page) => page.evaluate(() => window.__hostGot ?? []);

/** Clicks the menu row whose text starts with `label` (an app `Menu`, a context menu or a FormList dropdown). */
const clickMenuRow = (frame, label) => frame.evaluate((text) => {
    const rows = [ ...document.querySelectorAll("[role=menuitem], [role=menuitemcheckbox], .dropdown-item, .tn-menu-item, .ck-list__item .ck-button") ]
        .filter((el) => el.getBoundingClientRect().height > 0 && (el.textContent ?? "").trim().startsWith(text));
    rows.at(-1)?.click();
    return rows.length > 0;
}, label);

/** Hit areas under 44 x 44 among `selector` in the frame. */
const smallTargets = (frame, selector) => frame.evaluate((sel) => [ ...document.querySelectorAll(sel) ]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => ({ what: (el.getAttribute("aria-label") || el.textContent || el.className).toString().trim().slice(0, 30), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((b) => b.w < 44 || b.h < 44), selector);

// ── the walk ────────────────────────────────────────────────────────────────
let browser = null;
let exitCode = 0;
try {
    const health = await fetch(`${INTERNAL}/internal/health`, { headers: { authorization: `Bearer ${SECRET}` } }).then((r) => r.json());
    check("the notes gateway answers and names the engine build", !!health.engineVersion, health.engineVersion);
    await setup();
    await devLogin(ada);
    await devLogin(bea);
    for (const [ key, projectId, tasks, name ] of [ [ "a", projectA, tasksA, "Reach notes" ], [ "b", projectB, tasksB, "Private notes" ] ]) {
        const r = await apiCall(ada, "POST", `/api/projects/${projectId}/views/save-as-tab`, { name, parentDataSourceId: tasks, notes: true });
        if (r.status !== 201) throw new Error(`save-as-tab ${r.status} ${r.text.slice(0, 200)}`);
        nb[key] = { notebookId: r.json.notebookId, viewId: r.json.views?.[0]?.id, overview: r.json.overview?.id, projectId, tasks };
    }
    check("two notes tabs (team project, Ada's private project) made through the web API", !!nb.a.notebookId && !!nb.b.notebookId, `${nb.a.notebookId}, ${nb.b.notebookId}`);
    const adaA = await enter(ada, nb.a.notebookId);
    const whoami = await tfApi(adaA, nb.a.notebookId, "GET", "whoami");
    check("Ada enters notebook A through the gateway with the edit role", whoami.json?.role === "edit", whoami.json?.role);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [ ...BASE_FLAGS, ...MEDIA_FLAGS, "--use-fake-ui-for-media-stream" ] });
    const desk = await openTab(browser, ada, nb.a);
    const { page, frame } = desk;
    const caps = (await hostGot(page)).find((m) => m?.method === "ready")?.params?.capabilities ?? [];
    check("the engine announces tf-voice-1, tf-share-1 and tf-search-1 in ready", [ "tf-voice-1", "tf-share-1", "tf-search-1" ].every((c) => caps.includes(c)), caps.join(" "));

    let voiceNoteId = null;
    let voiceAttachmentId = null;
    if (want("voice") || want("transcript")) {
        voiceNoteId = await makeNote(frame, "Voice check", "<p>First paragraph.</p><p>Second paragraph.</p>");
        check("a text note opens in the editor", await gotoNote(frame, voiceNoteId), voiceNoteId);
        await caretAtEndOf(frame, 0);

        // The insert group of the toolbar, then its "Voice note" row; the slash command otherwise.
        let path = "toolbar insert menu";
        const clickToolbarButton = (label) => frame.evaluate((text) => {
            const button = [ ...document.querySelectorAll(".ck-toolbar button") ]
                .filter((b) => b.getBoundingClientRect().width > 0)
                .find((b) => (b.getAttribute("data-cke-tooltip-text") ?? b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "") === text);
            button?.click();
            return !!button;
        }, label);
        const selAt = () => frame.evaluate(async () => {
            const editor = await window.glob.appContext.tabManager.getActiveContext().getTextEditor();
            const sel = editor.model.document.selection.getFirstPosition();
            return `${JSON.stringify(sel?.path)} focused=${editor.editing.view.document.isFocused} markers=${[ ...editor.model.markers ].map((m) => `${m.name}@${JSON.stringify(m.getStart().path)}`).join(",")}`;
        });
        trace(`selection before menu ${await selAt()}`);
        let opened = await clickToolbarButton("Insert");
        if (!opened && await clickToolbarButton("Show more items")) {
            await sleep(400);
            opened = await clickToolbarButton("Insert");
        }
        await sleep(400);
        trace(`selection with menu open ${await selAt()}`);
        let clicked = opened && await clickMenuRow(frame, "Voice note");
        await sleep(300);
        trace(`selection after row ${await selAt()}`);
        if (!clicked) {
            console.log(`        toolbar buttons: ${JSON.stringify(await frame.evaluate(() => [ ...document.querySelectorAll(".ck-toolbar button") ].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getAttribute("data-cke-tooltip-text") ?? b.getAttribute("aria-label") ?? b.textContent?.trim())))}`);
            path = "slash command";
            await caretAtEndOf(frame, 0);
            await page.keyboard.type(" /voice");
            await sleep(600);
            await page.keyboard.press("Enter");
            clicked = true;
        }
        const barUp = await until(() => frame.evaluate(() => !!document.querySelector(".tf-voice-bar.state-recording")), 10000);
        check(`"Voice note" in the editor starts a recording (${path})`, barUp, barUp ? "" : await frame.evaluate(() => document.querySelector(".tf-voice-bar")?.textContent ?? "no bar"));
        const mime = await frame.evaluate(() => [ "audio/webm;codecs=opus", "audio/mp4" ].filter((t) => MediaRecorder.isTypeSupported(t)).join(", "));
        check("the browser's recorder types are feature-detected", mime.length > 0, mime);

        await sleep(1200);
        await caretAtEndOf(frame, 1);
        await page.keyboard.type(" Typed while recording.");
        await sleep(2200);
        const during = await frame.evaluate(() => ({
            state: document.querySelector(".tf-voice-bar")?.className,
            time: document.querySelector(".tf-voice-time")?.textContent,
            meter: !!document.querySelector(".tf-voice-level")
        }));
        check("recording goes on while the person types in the same note; time and level meter show", /state-recording/.test(during.state ?? "") && /^00:0[3-9]$/.test(during.time ?? "") && during.meter, JSON.stringify(during));
        await shot(page, "desktop-recorder-light");

        await frame.evaluate(() => document.querySelector(".tf-voice-stop")?.click());
        const saved = await until(() => frame.evaluate(() => !document.querySelector(".tf-voice-bar") ? "closed" : document.querySelector(".tf-voice-bar.phase-save_failed") ? "failed" : null), 30000);
        check("Stop saves the recording (the bar closes)", saved === "closed", saved);

        const attachments = await until(async () => {
            const r = await frameApi(frame, "GET", `notes/${voiceNoteId}/attachments`);
            const audio = (r.json ?? []).find((a) => a.mime?.startsWith("audio/"));
            return audio ?? null;
        }, 15000);
        voiceAttachmentId = attachments?.attachmentId ?? null;
        const bytes = voiceAttachmentId ? await frame.evaluate(async (id) => {
            const res = await fetch(`api/attachments/${id}/open`, { headers: await window.glob.getHeaders() });
            const blob = await res.blob();
            return { status: res.status, type: res.headers.get("content-type"), size: blob.size };
        }, voiceAttachmentId) : null;
        check("an audio attachment exists on the note, read back from the engine", !!bytes && bytes.status === 200 && bytes.size > 0 && /^audio\//.test(bytes.type ?? ""), JSON.stringify({ mime: attachments?.mime, ...bytes }));

        const html = await until(async () => {
            const content = await noteContent(frame, voiceNoteId);
            return content.includes(`data-attachment-id="${voiceAttachmentId}"`) ? content : null;
        }, 15000);
        const first = html?.indexOf("First paragraph") ?? -1;
        const embedAt = html?.indexOf(`data-attachment-id="${voiceAttachmentId}"`) ?? -1;
        const second = html?.indexOf("Second paragraph") ?? -1;
        check("the embed is saved where the caret was when recording started (after the first paragraph)", first >= 0 && embedAt > first && second > embedAt, html ? html.replace(/<[^>]+>/g, (t) => (t.startsWith("<figure") || t.startsWith("<section") ? "[EMBED]" : "")).slice(0, 160) : "no html");
        check("the text typed while recording is kept", html?.includes("Typed while recording."));
    }

    if (want("transcript") && voiceNoteId && voiceAttachmentId) {
        const outcome = await until(async () => {
            const content = await noteContent(frame, voiceNoteId);
            if (/<summary>Transcript<\/summary>/.test(content)) return { kind: "transcript", content };
            const status = await frame.evaluate(() => {
                const el = document.querySelector(".tf-voice-embed-status.state-error");
                return el ? el.textContent : null;
            });
            return status ? { kind: "message", status } : null;
        }, 90000, 1000);
        if (outcome?.kind === "transcript") {
            const text = outcome.content.replace(/.*<summary>Transcript<\/summary>/s, "").replace(/<\/details>.*/s, "").replace(/<[^>]+>/g, " ").trim();
            const afterEmbed = outcome.content.indexOf("<summary>Transcript") > outcome.content.indexOf(`data-attachment-id="${voiceAttachmentId}"`);
            check("TRANSCRIPT MADE: a collapsible \"Transcript\" block of plain editable text right under the embed", afterEmbed && text.length > 0, text.slice(0, 120));
        } else {
            check("NO TRANSCRIPT: the embed says honestly why (budget, not set up or failed)", outcome?.kind === "message" && /recording is saved/i.test(outcome.status), outcome?.status ?? "nothing within 90 s");
        }
        await frame.evaluate((id) => document.querySelector(`.include-note[data-attachment-id="${id}"]`)?.scrollIntoView({ block: "center" }), voiceAttachmentId);
        await shot(page, "desktop-embed-transcript-light");

        // "Make a transcript" on an audio file uploaded by hand through the paperclip's upload.
        const uploadNoteId = await makeNote(frame, "Uploaded audio", "<p>A meeting recording uploaded by hand.</p>");
        await gotoNote(frame, uploadNoteId);
        await caretAtEndOf(frame, 0);
        await frame.evaluate(async (b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const editor = await window.glob.appContext.tabManager.getActiveContext().getTextEditor();
            editor.execute("fileUpload", { file: [ new File([ bytes ], "meeting.wav", { type: "audio/wav" }) ], asEmbed: true });
        }, WAV_B64);
        const uploadedId = await until(async () => {
            const content = await noteContent(frame, uploadNoteId);
            return /data-attachment-id="([^"]+)"/.exec(content)?.[1] ?? null;
        }, 20000);
        check("an audio file uploaded by hand becomes an embedded attachment", !!uploadedId, uploadedId);
        // The organisation's budget answer, forced in the frame, to show the honest message and "Try again".
        await frame.evaluate(() => {
            const original = window.fetch;
            window.__transcribeCalls = 0;
            window.fetch = (url, init) => {
                if (String(url).includes("/__tf/api/voice/transcribe")) {
                    window.__transcribeCalls++;
                    if (window.__forceBudget) {
                        return Promise.resolve(new Response(JSON.stringify({ error: "ai_budget_used_up", message: "The organisation's AI budget for November is used up. Transcripts work again on 1 December" }), { status: 429, headers: { "content-type": "application/json" } }));
                    }
                }
                const answer = original(url, init);
                if (String(url).includes("/__tf/api/voice/transcribe")) {
                    void answer.then((r) => r.clone().text()).then((t) => (window.__transcribeAnswers ??= []).push(t.slice(0, 200))).catch(() => {});
                }
                return answer;
            };
            window.__forceBudget = true;
        });
        const openEmbedMenu = async (attachmentId) => {
            await frame.evaluate(async (id) => {
                const editor = await window.glob.appContext.tabManager.getActiveContext().getTextEditor();
                const root = editor.model.document.getRoot();
                for (const item of editor.model.createRangeIn(root).getItems()) {
                    if (item.is("element", "contentEmbed") && item.getAttribute("attachmentId") === id) {
                        editor.model.change((w) => w.setSelection(item, "on"));
                        editor.editing.view.focus();
                    }
                }
            }, attachmentId);
            await sleep(500);
            return frame.evaluate(() => {
                const more = [ ...document.querySelectorAll(".ck-balloon-panel_visible button, .ck-toolbar button") ].find((b) => b.getAttribute("data-cke-tooltip-text") === "More actions" && b.getBoundingClientRect().width > 0);
                more?.click();
                return !!more;
            });
        };
        const menuOpened = uploadedId && await openEmbedMenu(uploadedId);
        await sleep(500);
        const itemShown = menuOpened && await clickMenuRow(frame, "Make a transcript");
        check("the audio embed's menu offers \"Make a transcript\"", itemShown, menuOpened ? "" : "no More actions button");
        const budget = await until(() => frame.evaluate(() => document.querySelector(".tf-voice-embed-status.state-error")?.textContent ?? null), 20000);
        const calls = await frame.evaluate(() => window.__transcribeCalls);
        check("\"Make a transcript\" calls voice/transcribe with the file's bytes", calls >= 1, `${calls} call(s)`);
        check("on 429 the embed says the recording is saved, with the API's message, and offers Try again",
            /The recording is saved\. The transcript could not be made: The organisation's AI budget/.test(budget ?? "") && await frame.evaluate(() => !!document.querySelector(".tf-voice-embed-retry")), budget);
        await shot(page, "desktop-budget-message-light");
        await frame.evaluate(() => {
            window.__forceBudget = false;
            document.querySelector(".tf-voice-embed-retry")?.click();
        });
        const retried = await until(async () => {
            const content = await noteContent(frame, uploadNoteId);
            if (/<summary>Transcript<\/summary>/.test(content)) return "transcript";
            const status = await frame.evaluate(() => document.querySelector(".tf-voice-embed-status.state-error")?.textContent ?? null);
            return status && !/AI budget for November/.test(status) ? `message: ${status}` : null;
        }, 90000, 1000);
        check("Try again later re-reads the attachment from the engine and posts it again", (await frame.evaluate(() => window.__transcribeCalls)) >= 2 && !!retried, retried);
        console.log(`        the API answered: ${JSON.stringify(await frame.evaluate(() => window.__transcribeAnswers ?? []))}`);
    }

    if (want("denied")) {
        const denyBrowser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [ ...BASE_FLAGS, ...MEDIA_FLAGS, "--deny-permission-prompts" ] });
        try {
            const denied = await openTab(denyBrowser, ada, nb.a, { grantMic: false });
            const noteId = await makeNote(denied.frame, "Denied microphone", "<p>No microphone here.</p>");
            await gotoNote(denied.frame, noteId);
            await caretAtEndOf(denied.frame, 0);
            await denied.page.keyboard.type(" /voice");
            await sleep(600);
            await denied.page.keyboard.press("Enter");
            const message = await until(() => denied.frame.evaluate(() => document.querySelector(".tf-voice-bar.phase-mic_error .tf-voice-message")?.textContent ?? null), 15000);
            check("microphone denied: the bar says what to do in one sentence", message === "Allow the microphone for Taskforce in your browser's site settings, then try again.", message);
            const toast = (await hostGot(denied.page)).find((m) => m?.method === "toast");
            check("microphone denied: the host gets a toast", toast?.params?.kind === "error" && /Allow the microphone/.test(toast.params.message), JSON.stringify(toast?.params));
            await shot(denied.page, "desktop-mic-denied-light");
            await denied.context.close();
        } finally {
            await denyBrowser.close();
        }
    }

    let shareNoteId = null;
    let firstUrl = null;
    let secondUrl = null;
    if (want("share") || want("view")) {
        shareNoteId = await makeNote(frame, "Launch brief", "<p>Shared paragraph for the launch brief.</p>");
        await gotoNote(frame, shareNoteId);
        const openShareDialog = async (f) => {
            await f.evaluate(() => {
                const toggle = [ ...document.querySelectorAll(".note-actions button, .note-actions .dropdown-toggle") ].find((b) => b.getBoundingClientRect().width > 0);
                toggle?.click();
            });
            await sleep(500);
            const row = await clickMenuRow(f, "Share link…");
            return row && await until(() => f.evaluate(() => !!document.querySelector(".modal.tf-share-dialog.show")), 8000);
        };
        const upstreamSwitch = await frame.evaluate(() => {
            document.querySelector(".note-actions button")?.click();
            return new Promise((r) => setTimeout(() => {
                const rows = [ ...document.querySelectorAll("[role=menuitem], .dropdown-item") ].map((el) => el.textContent?.trim() ?? "");
                document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
                r(rows);
            }, 500));
        });
        check("the note menu has \"Share link…\" and no upstream \"Shared\" switch", upstreamSwitch.some((t) => t.startsWith("Share link…")) && !upstreamSwitch.some((t) => /^Shared$/.test(t)), upstreamSwitch.filter((t) => /shar/i.test(t)).join(" | "));
        await page.keyboard.press("Escape");
        await sleep(300);

        check("\"Share link…\" opens the dialog", await openShareDialog(frame));
        const createShown = await until(() => frame.evaluate(() => !!document.querySelector(".tf-share-create")), 5000);
        const defaultChoice = await frame.evaluate(() => document.querySelector(".tf-share-end-choice .active, .tf-share-end-choice [aria-pressed=true], .tf-share-end-choice .btn-primary")?.textContent?.trim() ?? "");
        check("a note without links opens on the form, ending in 7 days by default", createShown && /7 days/.test(defaultChoice), defaultChoice);
        await shot(page, "desktop-share-create-light");
        await frame.evaluate(() => document.querySelector(".tf-share-create-button")?.click());
        firstUrl = await until(() => frame.evaluate(() => document.querySelector(".tf-share-url")?.value || null), 10000);
        check("Make link shows the link once, in a read-only field with Copy", !!firstUrl && await frame.evaluate(() => document.querySelector(".tf-share-url")?.readOnly && !!document.querySelector(".tf-share-copy")), firstUrl);
        await frame.evaluate(() => {
            window.__copied = [];
            const write = navigator.clipboard.writeText.bind(navigator.clipboard);
            navigator.clipboard.writeText = (text) => write(text).then(() => window.__copied.push(`clipboard:${text}`), (e) => {
                window.__copied.push(`clipboard refused: ${e?.name}`);
                throw e;
            });
            const exec = document.execCommand.bind(document);
            document.execCommand = (command, ...rest) => {
                const selected = document.activeElement?.value?.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd);
                const ok = exec(command, ...rest);
                window.__copied.push(`selection:${ok}:${selected}`);
                return ok;
            };
            document.querySelector(".tf-share-copy")?.click();
        });
        const copied = await until(() => frame.evaluate(() => window.__copied.length ? window.__copied : null), 3000);
        const via = copied?.find((c) => c === `clipboard:${firstUrl}`) ? "the Clipboard API" : copied?.find((c) => c === `selection:true:${firstUrl}`) ? "the selection fallback" : null;
        check("Copy puts the link on the clipboard", !!via, via ?? JSON.stringify(copied));
        await shot(page, "desktop-share-created-light");

        const meta = (await tfApi(adaA, nb.a.notebookId, "GET", `share-links?noteId=${shareNoteId}`)).json?.links ?? [];
        const ends = meta[0]?.expiresAt ? new Date(meta[0].expiresAt) : null;
        const expected = new Date();
        expected.setDate(expected.getDate() + 7);
        check("the link ends in 7 days, at the end of that day in this time zone", !!ends && ends.toDateString() === expected.toDateString() && ends.getHours() === 23, meta[0]?.expiresAt);

        const visitor = await browser.createBrowserContext();
        const visit = await visitor.newPage();
        const visitAnswer = await visit.goto(firstUrl, { waitUntil: "domcontentloaded" });
        await sleep(800);
        const publicText = await visit.evaluate(() => document.body.innerText);
        const cookies = await visit.browserContext().cookies?.() ?? [];
        check("the returned URL opens the note in a browser without any Taskforce cookie", visitAnswer?.status() === 200 && /Shared paragraph for the launch brief/.test(publicText), `${visitAnswer?.status()} ${cookies.map((c) => c.name).join(",")}`);

        await frame.evaluate(() => [ ...document.querySelectorAll(".modal.tf-share-dialog button") ].find((b) => b.textContent?.trim() === "Done")?.click());
        await until(() => frame.evaluate(() => !document.querySelector(".modal.tf-share-dialog")), 5000);
        const marker = await until(() => frame.evaluate(() => document.querySelector(".tf-share-marker")?.textContent?.trim() || null), 15000);
        check("the title row shows \"Shared until <date>\"", /^Shared until /.test(marker ?? ""), marker);
        await shot(page, "desktop-shared-marker-light");

        await frame.evaluate(() => document.querySelector(".tf-share-marker")?.click());
        await until(() => frame.evaluate(() => !!document.querySelector(".modal.tf-share-dialog.show .tf-share-link")), 8000);
        const row = await frame.evaluate(() => document.querySelector(".tf-share-link")?.innerText ?? "");
        check("pressing the marker opens the dialog with the live link (made by, ends, password, views)", /Made by Ada Reach/.test(row) && /Ends /.test(row) && /No password/.test(row) && /Viewed once|Not viewed yet/.test(row), row);
        check("an existing link offers no Copy, says why, and offers \"Make a new link\"", await frame.evaluate(() => !document.querySelector(".tf-share-link .tf-share-copy") && /shown only once/.test(document.querySelector(".tf-share-list")?.textContent ?? "") && !!document.querySelector(".tf-share-make-new")));
        await shot(page, "desktop-share-list-light");

        await frame.evaluate(() => document.querySelector(".tf-share-make-new")?.click());
        await until(() => frame.evaluate(() => !!document.querySelector(".tf-share-password-input")), 5000);
        await frame.focus(".tf-share-password-input");
        await page.keyboard.type("pass1234");
        const shownPw = await frame.evaluate(() => {
            document.querySelector(".tf-share-password-toggle")?.click();
            return new Promise((r) => setTimeout(() => r(document.querySelector(".tf-share-password-input")?.type), 200));
        });
        check("the password field has a show/hide control", shownPw === "text", shownPw);
        await frame.evaluate(() => document.querySelector(".tf-share-create-button")?.click());
        secondUrl = await until(() => frame.evaluate(() => document.querySelector(".tf-share-url")?.value || null), 10000);
        const visit2 = await (await browser.createBrowserContext()).newPage();
        await visit2.goto(secondUrl, { waitUntil: "domcontentloaded" });
        await sleep(600);
        const asks = await visit2.evaluate(() => ({ pw: !!document.querySelector("input[type=password]"), text: document.body.innerText }));
        check("with a password the link asks first and shows nothing of the note", asks.pw && !/Shared paragraph/.test(asks.text), asks.text.slice(0, 80));
        await visit2.type("input[type=password]", "pass1234");
        await Promise.all([ visit2.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}), visit2.keyboard.press("Enter") ]);
        await sleep(800);
        check("the right password opens the note", /Shared paragraph for the launch brief/.test(await visit2.evaluate(() => document.body.innerText)));
        await frame.evaluate(() => [ ...document.querySelectorAll(".modal.tf-share-dialog button") ].find((b) => b.textContent?.trim() === "Done")?.click());
        await until(() => frame.evaluate(() => !document.querySelector(".modal.tf-share-dialog")), 5000);

        if (want("view")) {
            const view = await openViewFrame(browser, bea, nb.a);
            await gotoNote(view.frame, shareNoteId).catch(() => {});
            await view.frame.evaluate(async (id) => window.glob.appContext.tabManager.getActiveContext().setNote(id), shareNoteId);
            await sleep(1500);
            const viewMarker = await until(() => view.frame.evaluate(() => document.querySelector(".tf-share-marker")?.textContent?.trim() || null), 10000);
            check("VIEW ROLE: Bea (view) sees that the note is shared", /^Shared until /.test(viewMarker ?? ""), viewMarker);
            const viewDialog = await openShareDialog(view.frame);
            await until(() => view.frame.evaluate(() => document.querySelectorAll(".tf-share-link").length >= 2), 8000);
            const ro = await view.frame.evaluate(() => ({
                links: document.querySelectorAll(".tf-share-link").length,
                create: !!document.querySelector(".tf-share-make-new, .tf-share-create"),
                withdraw: !!document.querySelector(".tf-share-withdraw"),
                note: document.querySelector(".tf-share-list .tf-share-hint")?.textContent ?? ""
            }));
            check("VIEW ROLE: the links are listed read-only (no make, no withdraw)", viewDialog && ro.links === 2 && !ro.create && !ro.withdraw && /only editors can change them/.test(ro.note), JSON.stringify(ro));
            const refused = await tfApi(await enterView(bea), nb.a.notebookId, "POST", "share-links", { noteId: shareNoteId });
            check("VIEW ROLE: the API refuses a view person's new link (403 read_only)", refused.status === 403, `${refused.status} ${refused.text.slice(0, 60)}`);
            await shot(view.page, "desktop-share-view-role-light");
            await view.context.close();
        }

        // Withdraw both, from the dialog.
        await frame.evaluate(() => document.querySelector(".tf-share-marker")?.click());
        await until(() => frame.evaluate(() => document.querySelectorAll(".tf-share-link").length === 2), 8000);
        for (let i = 0; i < 2; i++) {
            await frame.evaluate(() => document.querySelector(".tf-share-link .tf-share-withdraw")?.click());
            await sleep(200);
            const ask = await frame.evaluate(() => document.querySelector(".tf-share-confirm")?.textContent ?? "");
            if (i === 0) check("Withdraw asks once: \"People with this link lose access at once.\"", /People with this link lose access at once\./.test(ask), ask);
            if (i === 0) await shot(page, "desktop-share-withdraw-light");
            await frame.evaluate(() => document.querySelector(".tf-share-withdraw-confirm")?.click());
            await until(() => frame.evaluate((left) => document.querySelectorAll(".tf-share-link").length === left, 1 - i), 8000);
        }
        check("withdrawing updates the list", await frame.evaluate(() => document.querySelectorAll(".tf-share-link").length === 0 && /no share links/.test(document.querySelector(".tf-share-list")?.textContent ?? "")));
        const ended = await (await (await browser.createBrowserContext()).newPage()).goto(firstUrl, { waitUntil: "domcontentloaded" }).then(async (r) => ({ status: r.status(), text: await r.text() }));
        check("after Withdraw the same URL answers 410 \"This link has ended.\"", ended.status === 410 && /This link has ended\./.test(ended.text), ended.status);
        await frame.evaluate(() => document.querySelector(".modal.tf-share-dialog .btn-close, .modal.tf-share-dialog [data-bs-dismiss=modal]")?.click());
        const cleared = await until(() => frame.evaluate(() => !document.querySelector(".tf-share-marker")), 20000);
        check("the \"Shared until\" marker clears once no live link is left", cleared);
    }

    if (want("search")) {
        const tabB = await enter(ada, nb.b.notebookId);
        const made = await engineCall(nb.b.notebookId, "POST", "/api/notes/root/children?target=into", { title: `${WORD} supplier plan`, type: "text", content: `<p>Order the ${WORD} boxes from the second supplier.</p>` });
        check("a note with a unique word is written into Ada's private notebook B", made.status === 200, `${WORD} ${made.status}`);
        const reindex = spawnSync(path.join(TF, "apps/api/node_modules/.bin/tsx"), [ `--env-file=${path.join(TF, ".env")}`, "src/scripts/notes-reindex.ts", nb.b.notebookId ], { cwd: path.join(TF, "apps/api"), encoding: "utf8", timeout: 120000 });
        check("notebook B is indexed (Taskforce's notes-reindex script; the worker is not running)", reindex.status === 0, (reindex.stdout || reindex.stderr).trim().split("\n").at(-1));
        const apiHits = (await tfApi(adaA, nb.a.notebookId, "GET", `search?q=${WORD}`)).json?.hits ?? [];
        const expected = apiHits.find((h) => h.notebookId === nb.b.notebookId);
        check("the search route finds it for Ada from notebook A (here: false)", !!expected && expected.here === false, expected?.href);

        await frame.evaluate(() => window.glob.appContext.triggerEvent("quickSearch", {}));
        await sleep(400);
        await page.keyboard.type(WORD);
        await page.keyboard.press("Enter");
        const quick = await until(() => frame.evaluate(() => {
            const hit = document.querySelector(".quick-search-menu .tf-other-notebooks .tf-other-hit");
            return hit ? { href: hit.getAttribute("data-href"), text: hit.innerText, mark: hit.querySelector("mark")?.textContent } : null;
        }), 10000);
        check("quick search shows the hit under \"In your other notebooks\" with project, path and marked excerpt", !!quick && quick.href === expected?.href && /Ada private plans/.test(quick.text) && quick.mark?.toLowerCase() === WORD, JSON.stringify(quick));
        await shot(page, "desktop-search-quick-light");

        await page.keyboard.press("Escape");
        await frame.evaluate(() => document.activeElement?.blur?.());
        await sleep(300);
        await frame.evaluate((w) => window.glob.appContext.triggerCommand("searchNotes", { searchString: w }), WORD);
        const full = await until(() => frame.evaluate(() => {
            const hit = [ ...document.querySelectorAll(".tf-other-notebooks.variant-list .tf-other-hit") ].find((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight;
            });
            return hit?.getAttribute("data-href") ?? null;
        }), 15000);
        check("the full search view shows the same section on screen, also with no results here", full === expected?.href, full);
        await shot(page, "desktop-search-full-light");

        const before = (await hostGot(page)).length;
        await frame.evaluate(() => [ ...document.querySelectorAll(".tf-other-notebooks.variant-list .tf-other-hit") ].find((el) => el.getBoundingClientRect().width > 0)?.click());
        await sleep(600);
        const open = (await hostGot(page)).slice(before).find((m) => m?.method === "open");
        check("pressing a hit sends open { href } to the host with the hit's href", !!expected?.href && open?.params?.href === expected.href, JSON.stringify(open?.params));
        const moved = await until(() => page.evaluate((p) => location.pathname.includes(p), nb.b.projectId), 15000);
        check("Taskforce switches to that notebook's project", moved, await page.evaluate(() => location.pathname + location.search));

        const beaA = await enter(bea, nb.a.notebookId);
        const beaHits = (await tfApi(beaA, nb.a.notebookId, "GET", `search?q=${WORD}`)).json?.hits ?? [];
        check("Bea, without access to Ada's private project, does not get the hit", !beaHits.some((h) => h.notebookId === nb.b.notebookId), `${beaHits.length} hit(s)`);
        void tabB;
    }

    if (want("phone")) {
        const phone = await openTab(browser, ada, nb.a, { phone: true });
        const noteId = await makeNote(phone.frame, "Phone voice", "<p>Typing on the phone.</p>");
        await gotoNote(phone.frame, noteId);
        await caretAtEndOf(phone.frame, 0);
        await sleep(800);
        const island = await until(() => phone.frame.evaluate(() => {
            const btn = document.querySelector(".classic-toolbar-outer-container.active .classic-toolbar-island .tf-voice-note-button");
            return btn && btn.getBoundingClientRect().width > 0 ? true : null;
        }), 8000);
        check("PHONE: the formatting toolbar island holds the voice note button, after the paperclip", !!island,
            await phone.frame.evaluate(() => [ ...document.querySelectorAll(".classic-toolbar-outer-container.active .classic-toolbar-island button") ].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getAttribute("data-cke-tooltip-text") ?? b.getAttribute("aria-label") ?? "").join(", ")));
        const insertTile = await phone.frame.evaluate(() => {
            const insert = [ ...document.querySelectorAll(".classic-toolbar-island button") ].find((b) => /^Insert$/i.test(b.getAttribute("data-cke-tooltip-text") ?? b.getAttribute("aria-label") ?? ""));
            insert?.click();
            return new Promise((r) => setTimeout(() => {
                const tile = [ ...document.querySelectorAll("[role=menuitem], .dropdown-item, button") ].find((el) => el.textContent?.trim() === "Voice note" && el.getBoundingClientRect().width > 0);
                r(!!tile);
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            }, 600));
        });
        check("PHONE: the insert sheet has a \"Voice note\" tile", insertTile);
        await phone.page.keyboard.press("Escape");
        await sleep(400);
        // A tap on the text brings the keyboard and the island back.
        const text = await (await phone.frame.$(".ck-editor__editable p"))?.boundingBox();
        if (text) await phone.page.touchscreen.tap(text.x + text.width - 4, text.y + text.height / 2);
        await caretAtEndOf(phone.frame, 0);
        await sleep(500);
        await tapVoiceButton(phone);
        const up = await until(() => phone.frame.evaluate(() => !!document.querySelector(".tf-voice-bar.state-recording")), 10000);
        check("PHONE: a tap starts recording", up);
        await phone.page.evaluate(() => {
            window.__vv.height = 500;
            window.__vv.offsetTop = 0;
            window.__vv.fire();
        });
        await sleep(900);
        await caretAtEndOf(phone.frame, 0);
        await sleep(600);
        const layout = await phone.frame.evaluate(() => {
            const bar = document.querySelector(".tf-voice-bar")?.getBoundingClientRect();
            const isl = document.querySelector(".classic-toolbar-outer-container.active .classic-toolbar-island")?.getBoundingClientRect();
            return { barBottom: bar && Math.round(bar.bottom), barTop: bar && Math.round(bar.top), islandTop: isl && Math.round(isl.top), height: innerHeight, width: bar && Math.round(bar.width) };
        });
        check("PHONE: with the keyboard open the bar sits right above the toolbar island, inside the visible frame", !!layout.barBottom && (!layout.islandTop || layout.barBottom <= layout.islandTop) && layout.barBottom <= layout.height && layout.barTop > 0, JSON.stringify(layout));
        const outside = await phone.frame.evaluate(() => {
            const bar = document.querySelector(".tf-voice-bar")?.getBoundingClientRect();
            if (!bar) return [ "no bar" ];
            return [ ...document.querySelectorAll(".tf-voice-bar button, .tf-voice-bar .tf-voice-time") ]
                .map((el) => ({ what: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20), r: el.getBoundingClientRect() }))
                .filter(({ r }) => r.left < bar.left - 0.5 || r.right > bar.right + 0.5)
                .map(({ what, r }) => `${what} ${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(bar.left)}-${Math.round(bar.right)}`);
        });
        trace(`bar rects ${await phone.frame.evaluate(() => [ ...document.querySelectorAll(".tf-voice-bar, .tf-voice-bar button, .tf-voice-level") ].map((el) => `${el.className.split(" ")[0]}:${Math.round(el.getBoundingClientRect().left)}-${Math.round(el.getBoundingClientRect().right)}`).join(" "))} vw=${await phone.frame.evaluate(() => innerWidth)}`);
        check("PHONE: every control of the bar fits inside it at 390 px", outside.length === 0, outside.join("; "));
        await shot(phone.page, "phone-recorder-light");
        const small = await smallTargets(phone.frame, ".tf-voice-bar button");
        const barButtons = await phone.frame.evaluate(() => document.querySelectorAll(".tf-voice-bar button").length);
        check("PHONE: touch audit, the recorder's controls are at least 44 x 44", barButtons > 0 && small.length === 0, `${barButtons} buttons ${JSON.stringify(small)}`);
        await phone.frame.evaluate(() => document.querySelector(".tf-voice-discard")?.click());
        const undo = await until(() => phone.frame.evaluate(() => !!document.querySelector(".tf-voice-undo")), 3000);
        check("PHONE: Discard offers Undo", undo);
        await shot(phone.page, "phone-discard-undo-light");
        await phone.frame.evaluate(() => document.querySelector(".tf-voice-undo")?.click());
        await sleep(300);
        check("PHONE: Undo brings the recording back, paused", await phone.frame.evaluate(() => !!document.querySelector(".tf-voice-bar.state-paused")));
        await phone.frame.evaluate(() => document.querySelector(".tf-voice-discard")?.click());
        await sleep(5600);
        check("PHONE: without Undo the recording is gone after 5 s", await phone.frame.evaluate(() => !document.querySelector(".tf-voice-bar")));
        await phone.page.evaluate(() => {
            window.__vv.height = null;
            window.__vv.offsetTop = null;
            window.__vv.fire();
        });
        await sleep(600);

        await phone.frame.evaluate(() => document.activeElement?.blur?.());
        const opened = await phone.frame.evaluate(() => {
            const toggle = [ ...document.querySelectorAll(".note-actions button") ].find((b) => b.getBoundingClientRect().width > 0);
            toggle?.click();
            return !!toggle;
        });
        await sleep(600);
        const row = opened && await clickMenuRow(phone.frame, "Share link…");
        const sheetBox = () => phone.frame.evaluate(() => {
            const dialog = document.querySelector(".modal.tf-share-dialog.show .modal-dialog");
            if (!dialog) return null;
            const r = dialog.getBoundingClientRect();
            return { bottom: Math.round(r.bottom), top: Math.round(r.top), height: innerHeight, width: Math.round(r.width), vw: innerWidth };
        });
        // Settled once two reads 300 ms apart agree (the sheet slides up).
        let sheet = null;
        if (row) {
            sheet = await until(async () => {
                const a = await sheetBox();
                await sleep(300);
                const b = await sheetBox();
                return a && b && a.top === b.top ? b : null;
            }, 8000);
        }
        check("PHONE: Share link opens as a bottom sheet", !!sheet && Math.abs(sheet.bottom - sheet.height) <= 2 && sheet.width === sheet.vw, JSON.stringify(sheet));
        await sleep(500);
        const closeGlyph = await phone.frame.evaluate(() => {
            const close = document.querySelector(".modal.tf-share-dialog.show .btn-close");
            return close ? getComputedStyle(close, "::after").content : null;
        });
        check("PHONE: the sheet's close button shows its X", !!closeGlyph && closeGlyph !== "none" && closeGlyph !== "\"\"", closeGlyph);
        await shot(phone.page, "phone-share-sheet-light");
        const smallShare = await smallTargets(phone.frame, ".modal.tf-share-dialog .btn, .modal.tf-share-dialog .icon-action, .modal.tf-share-dialog input");
        check("PHONE: touch audit, the share sheet's controls are at least 44 px", smallShare.length === 0, JSON.stringify(smallShare));
        await phone.context.close();
    }

    if (want("dark")) {
        const dark = await openTab(browser, ada, nb.a, { mode: "dark" });
        if (voiceNoteId) {
            await gotoNote(dark.frame, voiceNoteId);
            await dark.frame.evaluate((id) => document.querySelector(`.include-note[data-attachment-id="${id}"]`)?.scrollIntoView({ block: "center" }), voiceAttachmentId);
            await shot(dark.page, "desktop-embed-transcript-dark");
            await caretAtEndOf(dark.frame, 0);
            await dark.page.keyboard.type(" /voice");
            await sleep(600);
            await dark.page.keyboard.press("Enter");
            await until(() => dark.frame.evaluate(() => !!document.querySelector(".tf-voice-bar.state-recording")), 10000);
            await sleep(2500);
            await shot(dark.page, "desktop-recorder-dark");
            await dark.frame.evaluate(() => document.querySelector(".tf-voice-discard")?.click());
            await sleep(5600);
        }
        if (shareNoteId) {
            await gotoNote(dark.frame, shareNoteId);
            await dark.frame.evaluate(() => {
                document.querySelector(".note-actions button")?.click();
            });
            await sleep(500);
            await clickMenuRow(dark.frame, "Share link…");
            await until(() => dark.frame.evaluate(() => !!document.querySelector(".modal.tf-share-dialog.show")), 8000);
            await sleep(600);
            await shot(dark.page, "desktop-share-create-dark");
        }
        await dark.frame.evaluate((w) => window.glob.appContext.triggerCommand("searchNotes", { searchString: w }), WORD);
        await until(() => dark.frame.evaluate(() => !!document.querySelector(".tf-other-notebooks .tf-other-hit")), 15000);
        await shot(dark.page, "desktop-search-full-dark");
        check("dark mode screenshots taken", true, SHOTS ?? "no --shots");
        const darkPhone = await openTab(browser, ada, nb.a, { phone: true, mode: "dark" });
        const noteId = await makeNote(darkPhone.frame, "Phone dark", "<p>Dark phone.</p>");
        await gotoNote(darkPhone.frame, noteId);
        await caretAtEndOf(darkPhone.frame, 0);
        await sleep(800);
        await tapVoiceButton(darkPhone);
        await until(() => darkPhone.frame.evaluate(() => !!document.querySelector(".tf-voice-bar.state-recording")), 10000);
        await sleep(2000);
        await shot(darkPhone.page, "phone-recorder-dark");
        await darkPhone.frame.evaluate(() => document.querySelector(".tf-voice-discard")?.click());
        await sleep(5600);
        await dark.context.close();
        await darkPhone.context.close();
    }
} catch (err) {
    check("the walk ran to the end", false, err?.stack ?? err);
} finally {
    await browser?.close().catch(() => {});
    if (!KEEP) await teardown().catch((e) => console.error("teardown", e.message));
    await sql.end({ timeout: 5 }).catch(() => {});
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    exitCode = failed.length ? 1 : 0;
    process.exit(exitCode);
}

/** A finger tap on the formatting island's voice button, once it is on screen. */
async function tapVoiceButton({ page, frame }) {
    const selector = ".classic-toolbar-island .tf-voice-note-button";
    await until(() => frame.evaluate((sel) => {
        const button = [ ...document.querySelectorAll(sel) ].find((b) => b.getBoundingClientRect().width > 0);
        const island = button?.closest(".classic-toolbar-island");
        if (!button || !island) return false;
        // The island scrolls sideways; a swipe brings the button in, as it does the paperclip.
        button.scrollIntoView({ block: "nearest", inline: "center" });
        const r = button.getBoundingClientRect();
        const i = island.getBoundingClientRect();
        return r.width > 0 && r.left >= i.left && r.right <= i.right && r.top >= 0 && r.bottom <= innerHeight;
    }, selector), 8000);
    await sleep(300);
    let box = null;
    for (const handle of await frame.$$(selector)) {
        const b = await handle.boundingBox();
        if (b && b.width > 0) box = b;
    }
    trace(`voice button box ${JSON.stringify(box)}`);
    if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function enterView(who) {
    const token = mintEnterToken({ nb: nb.a.notebookId, uid: who.id, name: who.name, role: "view", org: orgId });
    const r = await http(PUB, "GET", `/__tf/enter?t=${encodeURIComponent(token)}&layout=desktop&next=%2F`, { host: hostOf(nb.a.notebookId) });
    return cookiesOf(r.headers).join("; ");
}

void existsSync;
