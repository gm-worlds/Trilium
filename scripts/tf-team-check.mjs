#!/usr/bin/env node
/**
 * The team features of NoteForce, end to end with two people through the REAL stack: the
 * Taskforce web page (http://localhost:9777), its notes tab, the notes gateway and an engine built
 * from this checkout. Two browser contexts are two people (Ada and Bea) of a throw-away workspace
 * (rows made here and removed at the end, as `scripts/notes-tests/team-api.mjs` in Taskforce does).
 *
 *   node scripts/tf-team-check.mjs [--shots <dir>] [--keep] [--only <substring>]
 *
 * One line per check, exit 1 when any failed. Needs the Taskforce worktree (TF_TASKFORCE, default
 * ~/Apps/Taskforce-wt-notes) for its .env, puppeteer-core and postgres.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const TASKFORCE = process.env.TF_TASKFORCE ?? process.env.TASKFORCE_DIR ?? path.join(os.homedir(), "Apps/Taskforce-wt-notes");
const requireTf = (pkg) => createRequire(path.join(TASKFORCE, pkg, "package.json"));
const puppeteer = requireTf("apps/worker")("puppeteer-core");
const postgres = requireTf("packages/db")("postgres");

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const SHOTS = arg("shots");
const KEEP = argv.includes("--keep");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = { ...loadEnv(path.join(TASKFORCE, ".env")), ...process.env };
const API = Number(env.API_PORT ?? 9778);
const WEB = new URL(env.BETTER_AUTH_URL ?? "http://localhost:9777").origin;
const BASE = env.NOTES_BASE_DOMAIN ?? "localhost:9779";
const SCHEME = env.NOTES_SCHEME ?? "http";
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH
  ?? path.join(os.homedir(), ".agent-browser/browsers/chrome-148.0.7778.167/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

let failures = 0;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
async function check(name, fn) {
  if (process.env.TF_TEAM_TRACE) console.log(`${stamp()} ...  ${name}`);
  try {
    const detail = await fn();
    console.log(`${stamp()} PASS ${name}${detail ? ` (${String(detail).slice(0, 200)})` : ""}`);
    return true;
  } catch (err) {
    failures++;
    console.log(`${stamp()} FAIL ${name}: ${String(err?.message ?? err).slice(0, 400)}`);
    return false;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch (err) {
      last = undefined;
    }
    if (last) return last;
    await sleep(every);
  }
  return last;
}
function http(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    r.end(body);
  });
}
const cookiesOf = (headers) => (headers["set-cookie"] ?? []).map((c) => c.split(";")[0]);

// ── The people and the place ────────────────────────────────────────────────
const sql = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });
const tag = `noteforce-team-${randomUUID().slice(0, 8)}`;
const ada = { id: randomUUID(), email: `${tag}-ada@taskforce.local`, name: "Ada Team" };
const bea = { id: randomUUID(), email: `${tag}-bea@taskforce.local`, name: "Bea Team" };
const orgId = `org_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const ws = randomUUID();
const projectId = randomUUID();
const tasksDs = randomUUID();
let notebookId = "";
let viewId = "";

async function setup() {
  for (const u of [ada, bea]) await sql`INSERT INTO "user" (id, email, name, "emailVerified") VALUES (${u.id}, ${u.email}, ${u.name}, true)`;
  await sql`INSERT INTO organization (id, name, slug) VALUES (${orgId}, ${tag}, ${tag})`;
  for (const [u, role] of [[ada, "owner"], [bea, "member"]]) await sql`INSERT INTO member (id, "organizationId", "userId", role) VALUES (${randomUUID()}, ${orgId}, ${u.id}, ${role})`;
  await sql`INSERT INTO workspace (id, slug, name, kind, "legacyOrganizationId") VALUES (${ws}, ${tag + "-ws"}, ${tag}, 'team', ${orgId})`;
  for (const [u, role] of [[ada, "owner"], [bea, "member"]]) await sql`INSERT INTO workspace_member ("workspaceId", "userId", role) VALUES (${ws}, ${u.id}, ${role})`;
  await sql`INSERT INTO project (id, "organizationId", "workspaceId", name, slug, "createdById") VALUES (${projectId}, ${orgId}, ${ws}, ${"Team check"}, ${tag}, ${ada.id})`;
  const statusSet = [
    { id: "st_todo", name: "Todo", color: "#a1a1aa", order: 0, category: "open" },
    { id: "st_done", name: "Done", color: "#10b981", order: 1, category: "done" },
  ];
  await sql`INSERT INTO data_source (id, "projectId", name, kind, "createdById", "statusSet") VALUES (${tasksDs}, ${projectId}, 'Tasks', 'tasks', ${ada.id}, ${sql.json(statusSet)})`;
}

async function teardown() {
  if (notebookId) await apiCall(ada, "DELETE", `/api/notebooks/${notebookId}`).catch(() => {});
  await sql`DELETE FROM notification WHERE "userId" IN (${ada.id}, ${bea.id})`;
  await sql`DELETE FROM notebook WHERE "projectId" = ${projectId}`;
  await sql`DELETE FROM activity_log WHERE "projectId" = ${projectId}`;
  await sql`DELETE FROM task WHERE "projectId" = ${projectId}`;
  await sql`DELETE FROM saved_view WHERE "projectId" = ${projectId}`;
  await sql`DELETE FROM data_source WHERE "projectId" = ${projectId}`;
  await sql`DELETE FROM project WHERE id = ${projectId}`;
  await sql`DELETE FROM workspace_member WHERE "workspaceId" = ${ws}`;
  await sql`DELETE FROM workspace WHERE id = ${ws}`;
  await sql`DELETE FROM member WHERE "organizationId" = ${orgId}`;
  await sql`DELETE FROM session WHERE "userId" IN (${ada.id}, ${bea.id})`;
  await sql`DELETE FROM organization WHERE id = ${orgId}`;
  await sql`DELETE FROM "user" WHERE id IN (${ada.id}, ${bea.id})`;
}

async function devLogin(p) {
  const r = await http(API, "GET", `/api/dev/login?email=${encodeURIComponent(p.email)}&token=${encodeURIComponent(env.DEV_LOGIN_TOKEN ?? "")}`);
  assert(r.status === 200, `dev login ${r.status} ${r.text.slice(0, 200)}`);
  p.cookie = cookiesOf(r.headers).join("; ");
  await sql`UPDATE session SET "activeOrganizationId" = ${orgId} WHERE "userId" = ${p.id}`;
  // A person who already went through the welcome flow and agreed to the terms, so the page opens
  // on the notes tab rather than on onboarding.
  await sql`UPDATE "user" SET "onboardingCompletedAt" = now() WHERE id = ${p.id}`;
  const terms = await apiCall(p, "GET", "/api/me/terms");
  if (terms.json?.currentVersion) await apiCall(p, "POST", "/api/me/terms", { version: terms.json.currentVersion });
  // and has a PIN for hidden text, so the PIN gate stays shut.
  await apiCall(p, "POST", "/api/secrets/pin", { pin: "246813" });
}
function apiCall(p, method, url, body) {
  return http(API, method, url, {
    headers: { cookie: p.cookie, origin: WEB, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const nbOrigin = () => `${SCHEME}://nb-${notebookId}.${BASE}`;

// ── Browsers ────────────────────────────────────────────────────────────────
let browser = null;

/** A person's page on the notes tab, signed in through their own browser context. */
async function openPerson(p, viewport) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  if (viewport.isMobile) {
    await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
  }
  page.on("pageerror", (err) => p.errors.push(String(err?.message ?? err)));
  for (const c of p.cookie.split("; ")) {
    const [k, ...v] = c.split("=");
    await page.setCookie({ name: k, value: v.join("="), url: WEB });
  }
  const href = `${WEB}/p/${projectId}?tab=table&view=${viewId}&overview=${tasksDs}`;
  await page.goto(href, { waitUntil: "domcontentloaded" });
  const ready = await until(() => page.evaluate(() => document.querySelector('[data-testid="notes-tab"]')?.getAttribute("data-bridge") === "ready"), 90_000, 300);
  if (!ready) {
    const state = await page.evaluate(() => ({ bridge: document.querySelector('[data-testid="notes-tab"]')?.getAttribute("data-bridge"), url: location.href, body: document.body.innerText.slice(0, 300) })).catch((e) => String(e));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `debug-${p.name.split(" ")[0]}.png`) });
    throw new Error(`${p.name}: the notebook frame never said ready ${JSON.stringify(state)} frames=${page.frames().map((f) => f.url().slice(0, 60)).join(",")}`);
  }
  const frame = await until(() => page.frames().find((f) => f.url().startsWith(nbOrigin())), 10_000);
  assert(frame, `${p.name}: no notebook frame`);
  await until(() => frame.evaluate(() => !!window.glob?.appContext?.tabManager?.getActiveContext()), 30_000);
  await sleep(800);
  await dismissHost(page);
  return { page, frame, context };
}

/** Closes the host's own dialogs (what's new, tutorials, hints) the way a person would. */
async function dismissHost(page) {
  for (let i = 0; i < 12; i++) {
    const clicked = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-sonner-toast], [role="status"]')]
        .filter((el) => !el.closest("[data-notes-surface]") && el.getBoundingClientRect().width > 0);
      for (const dialog of candidates) {
        const buttons = [...dialog.querySelectorAll("button")];
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

/** Runs `fn` in a person's notebook frame; gives up after 20 s instead of hanging the walk. */
const inFrame = (who, fn, ...args) => Promise.race([
  who.frame.evaluate(fn, ...args),
  sleep(20_000).then(() => {
    throw new Error(`frame call timed out: ${String(fn).slice(0, 80)}`);
  }),
]);

async function shot(who, name) {
  if (!SHOTS) return;
  await who.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Creates a note through the engine API from inside the frame (as the frame's own code would). */
function createNote(who, parentNoteId, title, content, type = "text") {
  return inFrame(who, async (parent, title, content, type) => {
    const res = await fetch(`/api/notes/${parent}/children?target=into`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": window.glob.csrfToken },
      body: JSON.stringify({ title, type, content, ...(type === "code" ? { mime: "text/plain" } : {}) }),
    });
    const json = await res.json();
    return json.note.noteId;
  }, parentNoteId, title, content, type);
}

function openNote(who, noteId) {
  return inFrame(who, async (noteId) => {
    await window.glob.appContext.tabManager.getActiveContext().setNote(noteId);
    return true;
  }, noteId);
}

// ── Frame helpers ───────────────────────────────────────────────────────────
/** Opens `noteId` and waits until the visible text editor holds `text`. */
async function openNoteAndWait(who, noteId, text) {
  await openNote(who, noteId);
  const ok = await until(() => inFrame(who, (text) => {
    const el = document.querySelector(".note-detail-editable-text-editor.ck-editor__editable, .note-detail-editable-text-editor .ck-editor__editable");
    return !!el?.ckeditorInstance && el.ckeditorInstance.getData().includes(text);
  }, text), 10000);
  assert(ok, `the editor never showed "${text}"`);
}

const editorState = (who) => inFrame(who, () => {
  const el = document.querySelector(".note-detail-editable-text-editor.ck-editor__editable, .note-detail-editable-text-editor .ck-editor__editable");
  const editor = el?.ckeditorInstance;
  return editor ? { readOnly: editor.isReadOnly, data: editor.getData() } : null;
});
const barText = (who) => inFrame(who, () => [...document.querySelectorAll(".tf-team-bar")].map((b) => b.textContent ?? "").join(" | "));

/** Puts the caret at the end of the first paragraph of the open text note and types `text`. */
async function typeInEditor(who, text, { delay = 40, paragraph = 0 } = {}) {
  await inFrame(who, (index) => {
    const el = document.querySelector(".note-detail-editable-text-editor.ck-editor__editable, .note-detail-editable-text-editor .ck-editor__editable");
    const editor = el.ckeditorInstance;
    editor.editing.view.focus();
    editor.model.change((writer) => {
      const root = editor.model.document.getRoot();
      const block = root.getChild(Math.min(index, root.childCount - 1));
      writer.setSelection(writer.createPositionAt(block, "end"));
    });
  }, paragraph);
  await who.page.keyboard.type(text, { delay });
}

async function openCommentsDesktop(who) {
  await inFrame(who, () => {
    const shown = document.querySelector("#right-pane-host:not(.hidden) .right-pane-tab-body[data-tab-id='tf-comments']:not(.hidden-ext)");
    if (!shown) window.glob.appContext.triggerEvent("selectRightPaneTab", { tabId: "tf-comments" });
  });
  return until(() => inFrame(who, () => !!document.querySelector(".right-pane-tab-body[data-tab-id='tf-comments']:not(.hidden-ext) .tf-team-comments")), 8000);
}

async function notifications(p, kind) {
  const r = await apiCall(p, "GET", "/api/notifications");
  const list = r.json?.notifications ?? r.json?.items ?? (Array.isArray(r.json) ? r.json : []);
  return list.filter((n) => !kind || n.kind === kind);
}

/** The hit area of each visible control matching `selector`, measured with elementFromPoint. */
const hitAreas = (who, selector) => inFrame(who, (selector) => {
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let x = r.left - 14; x <= r.right + 14; x += 2) {
      for (let y = r.top - 14; y <= r.bottom + 14; y += 2) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit))) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    // A control another layer covers entirely (the page behind an open sheet) takes no taps.
    if (!Number.isFinite(maxX)) continue;
    const w = maxX - minX + 2, h = maxY - minY + 2;
    out.push({ what: (el.getAttribute("aria-label") || el.textContent || el.className).toString().trim().slice(0, 30), w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 });
  }
  return out;
}, selector);

// ── The walk ───────────────────────────────────────────────────────────────
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
ada.errors = [];
bea.errors = [];
let A = null;
let B = null;
let P = null;
const ids = {};
const only = arg("only");
const trace = (text) => process.env.TF_TEAM_TRACE && console.log(`${stamp()}   .. ${text}`);
const step = (name, fn) => (!only || name.includes(only) || name.startsWith("setup:") ? check(name, fn) : Promise.resolve(true));

try {
  await check("setup: two people of a throw-away workspace sign in; a notes tab is made", async () => {
    await setup();
    await devLogin(ada);
    await devLogin(bea);
    const r = await apiCall(ada, "POST", `/api/projects/${projectId}/views/save-as-tab`, { name: "Team notes", parentDataSourceId: tasksDs, notes: true });
    assert(r.status === 201, `save-as-tab ${r.status} ${r.text.slice(0, 300)}`);
    notebookId = r.json.notebookId;
    viewId = r.json.view?.id ?? r.json.viewId ?? r.json.id;
    if (!viewId) {
      const [row] = await sql`SELECT id FROM saved_view WHERE "projectId" = ${projectId} AND name = 'Team notes'`;
      viewId = row?.id;
    }
    assert(notebookId && viewId, `no notebook or view: ${r.text.slice(0, 200)}`);
    return `notebook ${notebookId}`;
  });

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-features=Translate", "--touch-events=enabled"] });

  await check("setup: both open the notes tab in the real Taskforce page; the frame announces the team capabilities", async () => {
    A = await openPerson(ada, DESKTOP);
    B = await openPerson(bea, DESKTOP);
    const ready = await A.page.evaluate(() => document.querySelector('[data-testid="notes-tab"]')?.getAttribute("data-bridge"));
    const engine = await inFrame(A, () => !!window.__tfTeam);
    assert(ready === "ready" && engine, `bridge ${ready}, team ${engine}`);
    return "bridge ready in both";
  });

  await check("setup: Ada writes notes in the engine (a plan with blocks, a folder with a child, a code note)", async () => {
    ids.plan = await createNote(A, "root", "Team plan", "<p>Print run first, then the venue.</p><p>Second paragraph about the budget.</p>");
    ids.folder = await createNote(A, "root", "Folder", "<p>folder</p>");
    ids.child = await createNote(A, ids.folder, "Deep child", "<p>child text</p>");
    ids.code = await createNote(A, "root", "Script notes", "line one", "code");
    return `${ids.plan}, ${ids.folder}/${ids.child}, ${ids.code}`;
  });

  await step("presence: both open the plan and see each other in the title row", async () => {
    await openNote(A, ids.plan);
    await openNote(B, ids.plan);
    const seeA = await until(() => inFrame(A, (name) => [...document.querySelectorAll(".tf-team-presence-button")].some((b) => (b.getAttribute("aria-label") ?? "").includes(name)), bea.name));
    const seeB = await until(() => inFrame(B, (name) => [...document.querySelectorAll(".tf-team-presence-button")].some((b) => (b.getAttribute("aria-label") ?? "").includes(name)), ada.name));
    assert(seeA && seeB, `ada sees bea: ${!!seeA}, bea sees ada: ${!!seeB}`);
    const self = await inFrame(A, (name) => [...document.querySelectorAll(".tf-team-presence-button")].some((b) => (b.getAttribute("aria-label") ?? "").includes(name)), ada.name);
    assert(!self, "Ada sees herself");
    return "stack of the other person only";
  });

  await step("presence: the tree marks the plan with the other's dot and names them in the row's label", async () => {
    const row = await until(() => inFrame(A, (noteId, name) => {
      const span = document.querySelector(`span.fancytree-node[data-tf-note-id="${noteId}"]`);
      const dot = span?.querySelector(".tf-team-tree-mark .tf-team-dot.is-person");
      const label = span?.querySelector(".fancytree-title")?.textContent ?? "";
      return dot && label.includes(name) ? label : null;
    }, ids.plan, bea.name));
    assert(row, "no presence dot on the plan's tree row");
    await shot(A, "desktop-light-presence-tree");
    return JSON.stringify(row);
  });

  await step("presence: the launch bar lists people here with their note, and a press jumps there", async () => {
    await openNote(B, ids.folder);
    const listed = await until(async () => {
      await inFrame(A, () => document.querySelector(".tf-team-people-here button")?.click());
      return inFrame(A, (name) => {
        const rows = [...document.querySelectorAll(".tf-team-list-panel .tf-team-person-row")];
        const row = rows.find((r) => r.textContent.includes(name) && r.textContent.includes("Folder"));
        return row ? row.textContent : (document.querySelector(".tf-team-people-here button")?.click(), null);
      }, bea.name);
    }, 10000, 700);
    assert(listed, "Bea not listed on Folder");
    await shot(A, "desktop-light-people-here");
    await inFrame(A, (name) => [...document.querySelectorAll(".tf-team-list-panel .tf-team-person-row")].find((r) => r.textContent.includes(name))?.click(), bea.name);
    const jumped = await until(() => inFrame(A, () => window.glob.appContext.tabManager.getActiveContext().note?.noteId), 5000);
    assert(jumped === ids.folder, `Ada is on ${jumped}`);
    await openNoteAndWait(A, ids.plan, "Print run");
    await openNoteAndWait(B, ids.plan, "Print run");
    return listed.trim().slice(0, 60);
  });

  await step("turns: Bea's editor locks while Ada types, and Ada's text reaches Bea live", async () => {
    await openNoteAndWait(A, ids.plan, "Print run");
    await openNoteAndWait(B, ids.plan, "Print run");
    await until(() => inFrame(B, (noteId) => window.__tfTeam.getTeam().presence.some((p) => p.noteId === noteId && p.name === "Ada Team"), ids.plan), 8000, 200);
    await until(async () => (await editorState(B))?.readOnly === false, 8000);
    const typing = typeInEditor(A, " Ada writes here", { delay: 120 });
    const locked = await until(async () => (await editorState(B))?.readOnly === true, 6000, 100);
    const bar = await barText(B);
    await shot(B, "desktop-light-typing-bar");
    await typing;
    assert(locked, "Bea's editor never became read-only");
    assert(/Ada Team is typing/.test(bar), `bar: ${bar}`);
    const live = await until(async () => (await editorState(B))?.data.includes("Ada writes here"), 12000, 300);
    assert(live, "Ada's text did not reach Bea");
    return `bar "${bar.trim()}"`;
  });

  await step("turns: Bea's editor unlocks by itself once Ada pauses", async () => {
    const start = Date.now();
    const unlocked = await until(async () => (await editorState(B))?.readOnly === false, 15000, 200);
    assert(unlocked, "still read-only after 15 s");
    const bar = await barText(B);
    assert(!bar, `bar still shown: ${bar}`);
    return `${((Date.now() - start) / 1000).toFixed(1)} s after Ada's last key`;
  });

  await step("turns: a keystroke of Bea is not applied while Ada holds the lock; Take over is refused while she speaks, granted after 8 s of silence", async () => {
    // A second socket of Ada's holds the lock as a typing client does, without the editor.
    await inFrame(A, (noteId) => new Promise((resolve) => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/__tf/rt`);
      window.__rawRt = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ event: "lock.request", data: { noteId } }));
        window.__rawTimer = setInterval(() => ws.send(JSON.stringify({ event: "lock.request", data: { noteId } })), 1000);
        resolve(true);
      };
    }), ids.plan);
    const shown = await until(async () => /Ada Team is typing/.test(await barText(B)) && (await editorState(B))?.readOnly, 6000, 100);
    assert(shown, "Bea did not learn of the lock");
    const before = (await editorState(B)).data;
    await inFrame(B, () => {
      const el = document.querySelector(".note-detail-editable-text-editor.ck-editor__editable, .note-detail-editable-text-editor .ck-editor__editable");
      el.focus();
    });
    await B.page.keyboard.type("zz");
    await sleep(500);
    assert((await editorState(B)).data === before, "Bea's keys changed the text");

    await inFrame(B, () => document.querySelector(".tf-team-take-over")?.click());
    const refused = await until(async () => /Ada Team is still typing/.test(await barText(B)), 5000, 100);
    assert(refused, `no refusal: ${await barText(B)}`);
    await shot(B, "desktop-light-take-over-refused");

    await inFrame(A, () => clearInterval(window.__rawTimer));
    await sleep(8600);
    await inFrame(B, () => document.querySelector(".tf-team-take-over")?.click());
    const granted = await until(async () => (await editorState(B))?.readOnly === false && !(await barText(B)), 5000, 100);
    await inFrame(A, () => window.__rawRt?.close());
    assert(granted, `not granted: ${await barText(B)}`);
    const mine = await inFrame(B, () => window.__tfTeam.getTeam().turn.mine);
    assert(mine, "Bea's frame does not hold the lock");
    return "blocked, refused, then granted";
  });

  await step("turns: the 409 dialog still appears when the lock is bypassed", async () => {
    await inFrame(B, () => { window.localStorage.setItem("tfCheck", "1"); window.__tfTeam.setTurnBypass(true); });
    await sleep(6000);
    await until(async () => (await editorState(A))?.readOnly === false, 8000);
    const bTyping = typeInEditor(B, " Bea offline edit", { delay: 20, paragraph: 1 });
    await sleep(150);
    await typeInEditor(A, " Ada edit", { delay: 20, paragraph: 0 });
    await bTyping;
    const dialog = await until(async () => {
      const a = await inFrame(A, () => !!document.querySelector(".modal.tf-conflict-dialog.show, .tf-conflict-dialog .modal-content"));
      const b = await inFrame(B, () => !!document.querySelector(".modal.tf-conflict-dialog.show, .tf-conflict-dialog .modal-content"));
      return a ? "Ada" : b ? "Bea" : null;
    }, 15000, 200);
    if (dialog) {
      await sleep(700);
      await shot(dialog === "Ada" ? A : B, "desktop-light-conflict");
    }
    for (const who of [A, B]) {
      await inFrame(who, () => [...document.querySelectorAll(".tf-conflict-dialog button")].find((b) => /Use theirs/.test(b.textContent))?.click());
    }
    await inFrame(B, () => { window.__tfTeam.setTurnBypass(false); window.localStorage.removeItem("tfCheck"); });
    assert(dialog, "no conflict dialog on either side");
    await sleep(1500);
    return `${dialog} got the conflict dialog`;
  });

  await step("turns: after the conflict both editors save again and hold the same text", async () => {
    const settled = await until(async () => {
      const a = await editorState(A);
      const b = await editorState(B);
      const saving = await inFrame(B, () => !!document.querySelector(".save-status-badge.saving, .save-status-badge.unsaved"));
      return a && b && !saving && a.data === b.data && !b.readOnly ? a.data : null;
    }, 20000, 500);
    const why = settled ? "" : await inFrame(B, () => {
      const el = document.querySelector(".note-detail-editable-text-editor.ck-editor__editable, .note-detail-editable-text-editor .ck-editor__editable");
      const team = window.__tfTeam.getTeam();
      return JSON.stringify({
        badge: document.querySelector(".save-status-badge")?.className,
        dialog: !!document.querySelector(".tf-conflict-dialog"),
        readOnly: el?.ckeditorInstance?.isReadOnly,
        turn: team.turn,
        data: el?.ckeditorInstance?.getData().slice(0, 160)
      });
    });
    const aData = settled ? "" : (await editorState(A))?.data.slice(0, 160);
    assert(settled, `Bea ${why}; Ada ${aData}`);
    return "same text, nothing pending";
  });

  await step("comments: Ada starts a thread on a block from the editor's menu and names Bea with @", async () => {
    await sleep(6000);
    await openNoteAndWait(A, ids.plan, "Print run");
    await openNoteAndWait(B, ids.plan, "Print run");
    await openCommentsDesktop(B);
    assert(await openCommentsDesktop(A), "comments tab did not open");
    // Trilium's own menu opens on a selection (a bare caret keeps the browser's), so Ada selects
    // the first words of the block and right-clicks on them.
    await inFrame(A, () => {
      const el = document.querySelector(".note-detail-editable-text-editor.ck-editor__editable, .note-detail-editable-text-editor .ck-editor__editable");
      const editor = el.ckeditorInstance;
      editor.editing.view.focus();
      editor.model.change((writer) => {
        const block = editor.model.document.getRoot().getChild(0);
        writer.setSelection(writer.createRange(writer.createPositionAt(block, 0), writer.createPositionAt(block, 9)));
      });
    });
    await sleep(300);
    const rect = await inFrame(A, () => {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return { error: "no DOM selection" };
      const r = selection.getRangeAt(0).getBoundingClientRect();
      return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2, text: selection.toString() };
    });
    const frameHandle = await A.page.$(`iframe[src^="${nbOrigin()}"]`) ?? await A.page.$("iframe");
    const frameBox = await frameHandle?.boundingBox();
    trace(`comments: selection ${JSON.stringify(rect)}, frame ${JSON.stringify(frameBox)}`);
    assert(rect && !rect.error && frameBox, `selection ${JSON.stringify(rect)}, frame ${JSON.stringify(frameBox)}`);
    await A.page.mouse.click(frameBox.x + rect.x, frameBox.y + rect.y, { button: "right" });
    const item = await until(() => inFrame(A, () => [...document.querySelectorAll(".dropdown-menu .dropdown-item, .context-menu .dropdown-item, [role=menuitem]")].some((i) => i.textContent.trim() === "Comment")), 5000);
    const menu = item ? "" : await inFrame(A, () => [...document.querySelectorAll(".dropdown-menu .dropdown-item, [role=menuitem]")].map((i) => i.textContent.trim()).filter(Boolean).slice(0, 12).join("|"));
    assert(item, `no Comment entry in the context menu (items: ${menu})`);
    await inFrame(A, () => [...document.querySelectorAll(".dropdown-menu .dropdown-item, .context-menu .dropdown-item, [role=menuitem]")].find((i) => i.textContent.trim() === "Comment").click());
    const target = await until(() => inFrame(A, () => document.querySelector(".tf-team-composer-target-text")?.textContent), 5000);
    assert(target && /Print run/.test(target), `quote: ${target}`);
    await A.frame.focus(".tf-team-composer-dock .tf-team-composer-input");
    await A.page.keyboard.type("@Bea", { delay: 60 });
    const option = await until(() => inFrame(A, () => document.querySelector(".tf-team-people-option")?.textContent), 5000);
    assert(option && option.includes("Bea Team"), `people list: ${option}`);
    await shot(A, "desktop-light-composer-people");
    await A.page.keyboard.press("Enter");
    await A.page.keyboard.type("can you book the printer?", { delay: 10 });
    await A.page.keyboard.down("Meta");
    await A.page.keyboard.press("Enter");
    await A.page.keyboard.up("Meta");
    const posted = await until(() => inFrame(A, () => [...document.querySelectorAll(".tf-team-thread")].find((t) => t.textContent.includes("book the printer"))?.textContent), 8000);
    assert(posted, "thread not shown for Ada");
    ids.blockId = await inFrame(A, () => document.querySelector(".tf-team-thread .tf-team-quote") ? window.__tfTeam.getTeam().threads.get(window.glob.appContext.tabManager.getActiveContext().note.noteId)?.[0]?.blockId : null);
    assert(ids.blockId, "the thread has no block");
    return `block ${ids.blockId}, quote "${target.slice(0, 30)}"`;
  });

  await step("comments: Bea sees the thread live, the margin marker on the block, and a notification row", async () => {
    const live = await until(() => inFrame(B, () => [...document.querySelectorAll(".tf-team-thread")].find((t) => t.textContent.includes("book the printer"))?.textContent), 10000);
    assert(live, "no live thread for Bea");
    const marker = await until(() => inFrame(B, (blockId) => document.querySelector(`.tf-team-marker[data-block-id="${blockId}"]`)?.getAttribute("aria-label"), ids.blockId), 10000);
    assert(marker, "no margin marker");
    const badge = await inFrame(B, () => document.querySelector(".right-pane-tabs .tf-tab-badge")?.textContent);
    await shot(B, "desktop-light-comments-panel");
    const n = await until(async () => (await notifications(bea, "note.comment.mentioned"))[0], 8000, 500);
    assert(n, "no note.comment.mentioned notification for Bea");
    return `marker "${marker}", tab badge ${badge}, notice "${n.title}"`;
  });

  await step("comments: Bea replies and resolves; Ada sees both live", async () => {
    await inFrame(B, () => [...document.querySelectorAll(".tf-team-thread-actions button")].find((b) => /Reply/.test(b.textContent))?.click());
    await B.frame.waitForSelector(".tf-team-thread .tf-team-composer-input", { timeout: 5000 });
    await B.frame.focus(".tf-team-thread .tf-team-composer-input");
    await B.page.keyboard.type("Booked for Tuesday", { delay: 10 });
    await B.page.keyboard.down("Control");
    await B.page.keyboard.press("Enter");
    await B.page.keyboard.up("Control");
    const reply = await until(() => inFrame(A, () => [...document.querySelectorAll(".tf-team-comment.is-reply")].some((c) => c.textContent.includes("Booked for Tuesday"))), 10000);
    assert(reply, "Ada did not see the reply");
    const clicked = await until(() => inFrame(B, () => {
      const button = [...document.querySelectorAll(".tf-team-thread-actions button")].find((b) => /Resolve/.test(b.textContent));
      button?.click();
      return !!button;
    }), 5000);
    const resolved = await until(() => inFrame(A, () => document.querySelector(".tf-team-resolved")?.textContent ?? null), 10000);
    const state = resolved ? "" : await inFrame(B, () => JSON.stringify({
      buttons: [...document.querySelectorAll(".tf-team-thread-actions button")].map((b) => b.textContent),
      threads: [...window.__tfTeam.getTeam().threads.values()].flat().map((t) => ({ resolvedAt: t.resolvedAt, replies: t.replies?.length })),
      bResolved: document.querySelector(".tf-team-resolved")?.textContent ?? null
    }));
    assert(resolved && /1 resolved/i.test(resolved), `resolved section: ${resolved}; clicked ${clicked}; Bea ${state}`);
    const markerGone = await until(() => inFrame(A, () => !document.querySelector(".tf-team-marker")), 5000);
    assert(markerGone, "marker still shown after resolve");
    return "reply and resolve arrived";
  });

  await step("mentions: the @ list of the editor shows People first; picking Bea inserts a mention that notifies her once", async () => {
    await openNoteAndWait(A, ids.plan, "Print run");
    await typeInEditor(A, " ask @Be", { delay: 80, paragraph: 1 });
    const list = await until(() => inFrame(A, () => {
      const menu = document.querySelector(".note-mention-menu");
      if (!menu) return null;
      const heading = menu.querySelector("h6, .dropdown-header")?.textContent ?? "";
      const first = menu.querySelector(".dropdown-item:not(.disabled)")?.textContent ?? "";
      return heading.includes("People") && first.includes("Bea Team") ? `${heading} / ${first}` : null;
    }), 6000);
    await shot(A, "desktop-light-mention-list");
    assert(list, "no People heading with Bea first");
    await A.page.keyboard.press("Enter");
    const inserted = await until(() => inFrame(A, () => {
      const el = document.querySelector(".ck-content .tf-mention");
      return el ? `${el.textContent} ${getComputedStyle(el).textDecorationLine}` : null;
    }), 5000);
    assert(inserted && inserted.startsWith("@Bea Team"), `mention: ${inserted}`);
    const first = await until(async () => (await notifications(bea, "note.mentioned")).length === 1, 12000, 500);
    assert(first, `note.mentioned notices: ${(await notifications(bea, "note.mentioned")).length}`);
    await typeInEditor(A, " more words", { delay: 20, paragraph: 1 });
    await sleep(4000);
    const count = (await notifications(bea, "note.mentioned")).length;
    assert(count === 1, `${count} notices after a second save`);
    const saved = await inFrame(A, async (noteId) => (await (await fetch(`/api/notes/${noteId}/blob`, { cache: "no-store" })).json()).content, ids.plan);
    assert(/class="tf-mention"/.test(saved) && /data-tf-person-id/.test(saved), `the saved HTML has no mention span: ${String(saved).slice(0, 300)}`);
    return `${inserted}; 1 notice`;
  });

  await step("mentions: pressing a mention shows the person and where they are", async () => {
    await inFrame(A, () => {
      window.__tfClicks = [];
      document.addEventListener("click", (e) => window.__tfClicks.push(e.target?.className ?? String(e.target)), true);
    });
    const el = await A.frame.$(".ck-content .tf-mention");
    await el.click();
    const card = await until(() => inFrame(A, () => document.querySelector(".tf-team-card")?.textContent), 5000);
    const why = card ? "" : await inFrame(A, () => {
      const m = document.querySelector(".ck-content .tf-mention");
      const r = m?.getBoundingClientRect();
      const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return JSON.stringify({ clicks: window.__tfClicks, top: top?.className, host: !!document.querySelector(".tf-team-card-host") });
    });
    assert(card && card.includes("Bea Team") && /On .+ now/.test(card), `card: ${card} ${why}`);
    await A.page.keyboard.press("Escape");
    return card;
  });

  await step("authors: the title shows who edited last; the revisions dialog names each revision's author with a By filter", async () => {
    const line = await until(() => inFrame(A, () => document.querySelector(".title-details .tf-team-author-line")?.textContent), 15000, 500);
    assert(line && /Edited by (Ada|Bea) Team/.test(line), `author line: ${line}`);
    await inFrame(A, async (noteId) => fetch(`/api/notes/${noteId}/revision`, { method: "POST", headers: { "x-csrf-token": window.glob.csrfToken } }), ids.plan);
    await typeInEditor(B, " Bea adds a line", { delay: 20, paragraph: 1 });
    await sleep(2500);
    await inFrame(B, async (noteId) => fetch(`/api/notes/${noteId}/revision`, { method: "POST", headers: { "x-csrf-token": window.glob.csrfToken } }), ids.plan);
    await sleep(3500);
    await inFrame(A, (noteId) => window.glob.appContext.triggerEvent("showRevisions", { noteId }), ids.plan);
    const authors = await until(() => inFrame(A, () => {
      const names = [...document.querySelectorAll(".revisions-dialog .tf-team-revision-author")].map((e) => e.textContent);
      return names.length >= 2 ? names : null;
    }), 15000, 700);
    const filter = await inFrame(A, () => !!document.querySelector(".revisions-dialog .tf-team-revision-filter select"));
    await shot(A, "desktop-light-revisions");
    assert(authors, "no revision authors");
    assert(filter, "no By filter with two authors");
    const before = await inFrame(A, () => document.querySelectorAll(".revisions-dialog .revision-list .tf-team-revision-author").length);
    await inFrame(A, () => {
      const select = document.querySelector(".revisions-dialog .tf-team-revision-filter select");
      const option = [...select.options].find((o) => o.textContent.includes("Bea"));
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const filtered = await until(() => inFrame(A, () => {
      const names = [...document.querySelectorAll(".revisions-dialog .tf-team-revision-author")].map((e) => e.textContent);
      return names.length && names.every((n) => n.includes("Bea")) ? names.length : null;
    }), 5000);
    await A.page.keyboard.press("Escape");
    assert(filtered, "the By filter did not narrow the list");
    return `"${line}", ${authors.join(", ")}; filter ${before} -> ${filtered}`;
  });

  await step("unread: Ada edits a note Bea is not on; Bea sees it unread, the folded folder hollow, and the What changed list", async () => {
    // A clean start: Bea marks everything read from the What changed list, sits on the code note
    // and folds the folder.
    await openNote(B, ids.code);
    await sleep(4000);
    trace("unread: Bea marks all read");
    await inFrame(B, () => document.querySelector(".tf-team-what-changed button")?.click());
    const markAll = await until(() => inFrame(B, () => {
      const button = document.querySelector(".tf-team-mark-all");
      button?.click();
      return !!button;
    }), 5000);
    await B.page.keyboard.press("Escape");
    const zero = await until(() => inFrame(B, () => window.__tfTeam.getTeam().unread.count === 0), 8000, 300);
    assert(zero, `mark all read: button ${!!markAll}, count still above 0`);
    const serverZero = await until(async () => {
      const r = await apiCall(bea, "GET", `/api/notebooks/${notebookId}/badge`);
      return r.json?.unread === 0 ? true : null;
    }, 6000, 500);
    assert(serverZero, `server badge after mark all read: ${JSON.stringify((await apiCall(bea, "GET", `/api/notebooks/${notebookId}/badge`)).json)}`);
    trace("unread: Bea folds the folder");
    await inFrame(B, async (folderId) => {
      const tree = window.$.ui.fancytree.getTree(".tree");
      let node = null;
      tree.visit((n) => { if (n.data?.noteId === folderId) { node = n; return false; } });
      if (node?.isExpanded()) await node.setExpanded(false);
    }, ids.folder);
    trace("unread: Ada edits the child");
    await openNoteAndWait(A, ids.child, "child text");
    await typeInEditor(A, " changed by Ada", { delay: 20 });
    await sleep(3000);
    await openNoteAndWait(A, ids.plan, "Print run");
    const marks = await until(() => inFrame(B, (childId, folderId) => {
      const team = window.__tfTeam.getTeam();
      return team.unreadMarks.get(childId) === "unread" && team.unreadMarks.get(folderId) === "ancestor" ? team.unread.count : null;
    }, ids.child, ids.folder), 20000, 500);
    const seen = marks ? "" : await inFrame(B, () => {
      const team = window.__tfTeam.getTeam();
      return JSON.stringify({ unread: team.unread, marks: [...team.unreadMarks] });
    });
    assert(marks, `Bea's unread marks never arrived: ${seen}`);
    const folded = await inFrame(B, (folderId) => {
      const span = document.querySelector(`span.fancytree-node[data-tf-note-id="${folderId}"]`);
      const dot = span?.querySelector(".tf-team-dot.is-ancestor");
      return { collapsed: !span?.classList.contains("fancytree-expanded"), dot: !!dot && getComputedStyle(dot).display !== "none", label: span?.querySelector(".fancytree-title")?.textContent };
    }, ids.folder);
    assert(folded.dot && folded.collapsed, `folder: ${JSON.stringify(folded)}`);
    await inFrame(B, () => document.querySelector(".tf-team-what-changed button")?.click());
    const listed = await until(() => inFrame(B, () => [...document.querySelectorAll(".tf-team-unread-row")].map((r) => r.textContent).join(" | ") || null), 5000);
    await sleep(500);
    await shot(B, "desktop-light-what-changed");
    assert(listed && listed.includes("Deep child") && listed.includes("Ada Team"), `list: ${listed}`);
    await B.page.keyboard.press("Escape");
    return `${marks} unread; folder ${JSON.stringify(folded.label)}; list "${listed.slice(0, 60)}"`;
  });

  await step("unread: the badge message reaches the host (dot on the notes tab)", async () => {
    await B.page.mouse.move(700, 400);
    await B.page.mouse.move(700, 2);
    const dot = await until(() => B.page.evaluate(() => !!document.querySelector('[data-testid="notes-tab-unread"]')), 6000, 200);
    await B.page.mouse.move(700, 500);
    assert(dot, "no unread dot on the host's notes tab");
    return "notes-tab-unread shown";
  });

  await step("unread: opening the child marks it seen after 1.5 s; the marks and the badge clear", async () => {
    await openNote(B, ids.child);
    await sleep(800);
    const early = await inFrame(B, (childId) => window.__tfTeam.getTeam().unreadMarks.get(childId), ids.child);
    const cleared = await until(() => inFrame(B, (childId, folderId) => {
      const team = window.__tfTeam.getTeam();
      const rows = [childId, folderId].map((id) => document.querySelector(`span.fancytree-node[data-tf-note-id="${id}"] .tf-team-dot.is-unread, span.fancytree-node[data-tf-note-id="${id}"] .tf-team-dot.is-ancestor`));
      return !team.unreadMarks.has(childId) && !team.unreadMarks.has(folderId) && rows.every((row) => !row);
    }, ids.child, ids.folder), 8000, 200);
    assert(early === "unread", `cleared before 1.5 s: ${early}`);
    assert(cleared, "marks still shown");
    const server = await until(async () => {
      const r = await apiCall(bea, "GET", `/api/notebooks/${notebookId}/badge`);
      return r.json?.unread === 0 ? r.json : null;
    }, 8000, 500);
    assert(server, "server badge not zero");
    return `badge ${JSON.stringify(server)}`;
  });

  await step("dark mode: the same surfaces in the dark theme", async () => {
    for (const who of [A, B]) await who.page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    const dark = await until(() => inFrame(A, () => {
      // The first painted background behind the note.
      for (let el = document.querySelector(".note-split"); el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor;
        const [r, g, b, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
        if (a === 0) continue;
        return r + g + b < 200 ? color : null;
      }
      return null;
    }), 8000);
    assert(dark, "the frame did not turn dark");
    await openNote(B, ids.plan);
    await openNote(A, ids.plan);
    await sleep(2500);
    await openCommentsDesktop(A);
    await inFrame(A, () => document.querySelector(".tf-team-resolved button, .tf-team-resolved .collapsible-title")?.click());
    await shot(A, "desktop-dark-comments-presence");
    await inFrame(B, () => document.querySelector(".tf-team-people-here button")?.click());
    await sleep(500);
    await shot(B, "desktop-dark-people-here");
    await B.page.keyboard.press("Escape");
    return dark;
  });

  await step("phone: the comments sheet opens from the note panel; the composer stays usable above a keyboard inset", async () => {
    P = await openPerson(bea, PHONE);
    const header = await until(() => inFrame(P, () => !!document.querySelector(".tf-team-navigator-header")), 8000);
    await inFrame(P, () => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "tree" }));
    await sleep(800);
    await shot(P, "phone-light-navigator");
    await openNote(P, ids.plan);
    await inFrame(P, () => window.glob.appContext.triggerCommand("setActiveScreen", { screen: "detail" }));
    await sleep(1200);
    await shot(P, "phone-light-note");
    await inFrame(P, () => document.querySelector(".mobile-note-panel-button button")?.click());
    const tab = await until(() => inFrame(P, () => [...document.querySelectorAll(".mobile-note-panel-tabs button")].find((b) => /Comments/.test(b.textContent)) ? true : null), 6000);
    assert(tab, "no Comments tab in the note panel");
    await inFrame(P, () => [...document.querySelectorAll(".mobile-note-panel-tabs button")].find((b) => /Comments/.test(b.textContent)).click());
    const composer = await until(() => inFrame(P, () => !!document.querySelector(".mobile-note-panel .tf-team-composer-input")), 6000);
    assert(composer, "no composer in the sheet");
    await inFrame(P, () => document.querySelector(".tf-team-resolved button, .tf-team-resolved .collapsible-title")?.click());
    await sleep(400);
    await shot(P, "phone-light-comments-sheet");
    const inset = 320;
    await inFrame(P, (inset) => {
      document.body.style.setProperty("--tf-keyboard-inset", `${inset}px`);
      document.body.style.setProperty("--tn-keyboard-height", `${inset}px`);
      document.documentElement.classList.add("tf-keyboard-covers");
      document.getElementById("root-widget")?.classList.add("virtual-keyboard-opened");
      document.querySelector(".mobile-note-panel .tf-team-composer-input")?.focus();
    }, inset);
    await sleep(500);
    const fits = await inFrame(P, (inset) => {
      const r = document.querySelector(".mobile-note-panel .tf-team-composer-input").getBoundingClientRect();
      return { bottom: Math.round(r.bottom), limit: innerHeight - inset, height: Math.round(r.height) };
    }, inset);
    await shot(P, "phone-light-composer-keyboard");
    await P.frame.focus(".mobile-note-panel .tf-team-composer-input");
    await P.page.keyboard.type("From the phone", { delay: 10 });
    const typed = await inFrame(P, () => document.querySelector(".mobile-note-panel .tf-team-composer-input").value);
    await inFrame(P, () => {
      document.body.style.removeProperty("--tf-keyboard-inset");
      document.body.style.removeProperty("--tn-keyboard-height");
      document.documentElement.classList.remove("tf-keyboard-covers");
      document.getElementById("root-widget")?.classList.remove("virtual-keyboard-opened");
    });
    assert(fits.bottom <= fits.limit, `composer under the keyboard: ${JSON.stringify(fits)}`);
    assert(typed === "From the phone", `typed: ${typed}`);
    return `navigator header ${!!header}; composer bottom ${fits.bottom} <= ${fits.limit}`;
  });

  await step("phone: touch audit of the new controls (44 px hit areas)", async () => {
    const selector = [
      ".mobile-note-panel .tf-team-thread-actions button", ".mobile-note-panel .tf-team-composer-actions button",
      ".mobile-note-panel .tf-team-time", ".mobile-note-panel .tf-team-quote", ".mobile-note-panel-tabs button",
      ".tf-team-presence-button", ".tf-team-marker", ".tf-team-row-button"
    ].join(", ");
    const panel = await hitAreas(P, selector);
    await inFrame(P, () => document.querySelector(".mobile-note-panel .btn-close, .mobile-note-panel [data-bs-dismiss], .mobile-note-panel .modal-header button")?.click());
    await sleep(600);
    const page = await hitAreas(P, ".tf-team-presence-button, .tf-team-marker, .tf-team-row-button");
    const small = [...panel, ...page].filter((t) => t.w < 44 || t.h < 44);
    assert(panel.length > 0, "nothing measured");
    assert(!small.length, `under 44 px: ${JSON.stringify(small)}`);
    await P.page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await sleep(1500);
    await inFrame(P, () => document.querySelector(".mobile-note-panel-button button")?.click());
    await sleep(800);
    await shot(P, "phone-dark-comments-sheet");
    return `${panel.length + page.length} controls, all >= 44 px`;
  });
} catch (err) {
  failures++;
  console.log(`CRASH ${err?.stack ?? err}`);
} finally {
  for (const p of [ada, bea]) if (p.errors.length) console.log(`page errors (${p.name}): ${[...new Set(p.errors)].slice(0, 5).join(" | ")}`);
  await browser?.close().catch(() => {});
  if (!KEEP) await teardown().catch((e) => console.log(`cleanup: ${e.message}`));
  await sql.end();
}
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
