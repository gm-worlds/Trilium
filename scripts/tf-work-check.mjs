#!/usr/bin/env node
/**
 * NoteForce work features end to end through the REAL stack: Taskforce web (9777), API (9778), notes
 * gateway (9779/9780) and the engine build the manifest names `current`.
 *
 *   node scripts/tf-work-check.mjs [--shots <dir>] [--keep] [--chrome <path>]
 *
 * Two dev-login people (Ada: owner, edit; Bea: member) in a throw-away workspace, one notes tab made
 * through the web API, both driving the real Taskforce page with the notebook in its frame. One line
 * per check, exit 1 when any failed. Rows are removed at the end unless --keep.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORK = path.resolve(HERE, "..");
const TF = process.env.TF_TASKFORCE ?? path.join(os.homedir(), "Apps/Taskforce-wt-notes");
const puppeteer = createRequire(path.join(TF, "apps/worker/package.json"))("puppeteer-core");
const postgres = createRequire(path.join(TF, "packages/db/package.json"))("postgres");
const yauzl = createRequire(path.join(FORK, "apps/server/package.json"))("yauzl");

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const SHOTS = arg("shots");
const KEEP = argv.includes("--keep");
const CHROME = arg("chrome", process.env.PUPPETEER_EXECUTABLE_PATH
    ?? path.join(os.homedir(), ".agent-browser/browsers/chrome-148.0.7778.167/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));

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
const BASE = env.NOTES_BASE_DOMAIN ?? "localhost:9779";
const SCHEME = env.NOTES_SCHEME ?? "http";

// ── Results ─────────────────────────────────────────────────────────────────
let failures = 0;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`${stamp()} PASS ${name}${detail ? ` (${String(detail).slice(0, 220)})` : ""}`);
    return true;
  } catch (err) {
    failures++;
    console.log(`${stamp()} FAIL ${name}: ${String(err?.message ?? err).slice(0, 2400)}`);
    return false;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
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

// ── Throw-away people and place ─────────────────────────────────────────────
const sql = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });
const tag = `noteforce-work-${randomUUID().slice(0, 8)}`;
const ada = { id: randomUUID(), email: `${tag}-ada@taskforce.local`, name: "Ada Work" };
const bea = { id: randomUUID(), email: `${tag}-bea@taskforce.local`, name: "Bea Work" };
const orgId = `org_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const ws = randomUUID();
const personalWs = randomUUID();
const projectId = randomUUID();
const privateProjectId = randomUUID();
const tasksDs = randomUUID();
let notebookId = "";
let tabUrl = "";

async function setup() {
  for (const u of [ada, bea]) await sql`INSERT INTO "user" (id, email, name, "emailVerified") VALUES (${u.id}, ${u.email}, ${u.name}, true)`;
  await sql`INSERT INTO organization (id, name, slug) VALUES (${orgId}, ${tag}, ${tag})`;
  for (const [u, role] of [[ada, "owner"], [bea, "member"]]) await sql`INSERT INTO member (id, "organizationId", "userId", role) VALUES (${randomUUID()}, ${orgId}, ${u.id}, ${role})`;
  await sql`INSERT INTO workspace (id, slug, name, kind, "legacyOrganizationId") VALUES (${ws}, ${tag + "-ws"}, ${tag}, 'team', ${orgId})`;
  await sql`INSERT INTO workspace (id, slug, name, kind, "personalOwnerId") VALUES (${personalWs}, ${tag + "-personal"}, ${tag + " personal"}, 'personal', ${ada.id})`;
  for (const [w, u, role] of [[ws, ada, "owner"], [ws, bea, "member"], [personalWs, ada, "owner"]]) await sql`INSERT INTO workspace_member ("workspaceId", "userId", role) VALUES (${w}, ${u.id}, ${role})`;
  await sql`INSERT INTO project (id, "organizationId", "workspaceId", name, slug, "createdById") VALUES (${projectId}, ${orgId}, ${ws}, ${"Work launch"}, ${tag}, ${ada.id})`;
  await sql`INSERT INTO project (id, "organizationId", "workspaceId", name, slug, "createdById") VALUES (${privateProjectId}, ${orgId}, ${personalWs}, ${"Ada private"}, ${tag + "-p"}, ${ada.id})`;
  const statusSet = [
    { id: "st_todo", name: "Todo", color: "#a1a1aa", order: 0, category: "open" },
    { id: "st_doing", name: "Doing", color: "#3b82f6", order: 1, category: "open" },
    { id: "st_done", name: "Done", color: "#10b981", order: 2, category: "done" },
  ];
  await sql`INSERT INTO data_source (id, "projectId", name, kind, "createdById", "statusSet") VALUES (${tasksDs}, ${projectId}, 'Tasks', 'tasks', ${ada.id}, ${sql.json(statusSet)})`;
}

async function teardown() {
  if (notebookId) await webApi(ada, "DELETE", `/api/notebooks/${notebookId}`).catch(() => {});
  await sql`DELETE FROM notification WHERE "userId" IN (${ada.id}, ${bea.id})`.catch(() => {});
  for (const table of ["notebook", "activity_log", "task", "saved_view", "data_source"]) {
    await sql`DELETE FROM ${sql(table)} WHERE "projectId" IN (${projectId}, ${privateProjectId})`.catch(() => {});
  }
  await sql`DELETE FROM project WHERE id IN (${projectId}, ${privateProjectId})`.catch(() => {});
  await sql`DELETE FROM workspace_member WHERE "workspaceId" IN (${ws}, ${personalWs})`.catch(() => {});
  await sql`DELETE FROM workspace WHERE id IN (${ws}, ${personalWs})`.catch(() => {});
  await sql`DELETE FROM member WHERE "organizationId" = ${orgId}`.catch(() => {});
  await sql`DELETE FROM session WHERE "userId" IN (${ada.id}, ${bea.id})`.catch(() => {});
  await sql`DELETE FROM organization WHERE id = ${orgId}`.catch(() => {});
  await sql`DELETE FROM "user" WHERE id IN (${ada.id}, ${bea.id})`.catch(() => {});
}

function http(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: API_PORT, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: text.slice(0, 600), json });
      });
    });
    r.on("error", reject);
    r.end(body);
  });
}

/** A Taskforce web API call as a person (their session cookie). */
function webApi(person, method, url, body) {
  return http(method, url, {
    headers: { cookie: person.cookie, origin: WEB, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Signs a person in, past onboarding, the terms and the PIN gate, like `tf-team-check.mjs`. */
async function devLogin(person) {
  const r = await http("GET", `/api/dev/login?email=${encodeURIComponent(person.email)}&token=${encodeURIComponent(env.DEV_LOGIN_TOKEN ?? "")}`);
  assert(r.status === 200, `dev login ${r.status} ${r.text.slice(0, 200)}`);
  person.cookie = (r.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
  await sql`UPDATE session SET "activeOrganizationId" = ${orgId} WHERE "userId" = ${person.id}`;
  await sql`UPDATE "user" SET "onboardingCompletedAt" = now() WHERE id = ${person.id}`;
  const terms = await webApi(person, "GET", "/api/me/terms");
  if (terms.json?.currentVersion) await webApi(person, "POST", "/api/me/terms", { version: terms.json.currentVersion });
  await webApi(person, "POST", "/api/secrets/pin", { pin: "246813" });
}

// ── Inside the notebook frame ───────────────────────────────────────────────
const nbOrigin = () => `${SCHEME}://nb-${notebookId}.${BASE}`;

async function frameOf(person, ms = 60000) {
  const f = await until(async () => {
    const frame = person.page.frames().find((fr) => fr.url().startsWith(nbOrigin()));
    if (!frame) return null;
    const ready = await frame.evaluate(() => !!window.glob?.appContext?.tabManager?.getActiveContext?.() && document.documentElement.classList.contains("tf-embedded")).catch(() => false);
    return ready ? frame : null;
  }, ms, 400);
  assert(f, "the notebook frame did not become ready");
  person.frame = f;
  return f;
}

/** Engine API call from inside the frame (page cookies, CSRF token). */
function engine(person, method, url, body) {
  return person.frame.evaluate(async (m, u, b) => {
    const res = await fetch(u, { method: m, credentials: "same-origin", headers: { "x-csrf-token": window.glob.csrfToken, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text: text.slice(0, 400) };
  }, method, url, body ?? null);
}
const gw = (person, method, rest, body) => engine(person, method, `/__tf/api/${rest}`, body);

async function openNote(person, noteId) {
  await person.frame.evaluate(async (id) => {
    await window.glob.appContext.tabManager.getActiveContext().setNote(id);
  }, noteId);
  await until(() => person.frame.evaluate((id) => {
    const ctx = window.glob.appContext.tabManager.getActiveContext();
    return ctx?.note?.noteId === id && !!document.querySelector(".note-split:not(.hidden-ext) .ck-editor__editable, .ck-editor__editable");
  }, noteId), 15000);
  await sleep(600);
}

/** Runs `fn(editor)` with the active note's CKEditor inside the frame. */
function withEditor(person, fn, ...args) {
  return person.frame.evaluate(async (source, rest) => {
    const editor = await window.glob.appContext.tabManager.getActiveContext().getTextEditor();
    // eslint-disable-next-line no-new-func
    return new Function("editor", "args", `return (${source})(editor, ...args);`)(editor, rest);
  }, fn.toString(), args);
}

/** Puts the caret at the end of the to-do item `index` (document order). */
async function caretInTodo(person, index) {
  await withEditor(person, (editor, i) => {
    const items = [];
    for (const { item } of editor.model.createRangeIn(editor.model.document.getRoot())) {
      if (item.is("element") && item.getAttribute("listType") === "todo") items.push(item);
    }
    editor.model.change((w) => w.setSelection(w.createPositionAt(items[i], "end")));
    editor.editing.view.focus();
    return items.length;
  }, index);
}

async function todoLi(person, index) {
  return (await person.frame.$$(".ck-editor__editable ul.todo-list > li"))[index];
}

/** What the frame shows, for a failure message. */
function diag(person) {
  return person.frame.evaluate(async () => {
    const boot = await (await fetch("/api/tf/bootstrap")).json().catch(() => null);
    const layer = document.querySelector(".tf-todo-layer");
    return JSON.stringify({
      role: boot?.user?.role,
      layer: layer ? layer.children.length : "none",
      todos: document.querySelectorAll(".ck-editor__editable ul.todo-list > li").length,
      makeTaskButton: !!document.querySelector('.ck-toolbar [data-cke-tooltip-text*="task" i], .ck-toolbar .ck-button[aria-label*="task" i]'),
      menu: [...document.querySelectorAll(".dropdown-menu .dropdown-item, [role=menuitem]")].filter((el) => el.offsetParent !== null).map((el) => el.textContent.trim().slice(0, 30)),
      focus: document.activeElement?.className?.toString().slice(0, 60),
      errors: window.__tfErrors ?? null,
    });
  });
}

async function clickMenuItem(person, label, ms = 5000) {
  const ok = await until(() => person.frame.evaluate((text) => {
    const items = [...document.querySelectorAll(".dropdown-menu .dropdown-item, .dropdown-menu li, [role=menuitem]")].filter((el) => el.offsetParent !== null);
    const item = items.find((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(text));
    if (!item) return false;
    item.click();
    return true;
  }, label), ms, 150);
  assert(ok, `no menu item "${label}" ${await diag(person)}`);
}

async function shot(person, name, target = "page") {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await sleep(350);
  await person.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Waits until no dialog or backdrop is left on the frame. */
function noModal(person, ms = 4000) {
  return until(() => person.frame.evaluate(() => (document.querySelector(".modal-backdrop, .modal.show") ? null : true)), ms);
}

/** The phone layout's screen: "tree" (the navigator) or "detail" (the note). */
async function screen(person, name) {
  await person.frame.evaluate((n) => window.glob.appContext.triggerCommand("setActiveScreen", { screen: n }), name);
  await sleep(500);
}

async function closeModals(person) {
  // A dialog ignores its close button while it is still fading in, and a phone sheet slides
  // away for longer than a desktop dialog fades: press close until nothing is left.
  for (let i = 0; i < 12; i++) {
    const open = await person.frame.evaluate(() => {
      const buttons = document.querySelectorAll(".modal.show .btn-close, .modal.show button.close, .modal.show [data-bs-dismiss=modal]");
      for (const btn of buttons) btn.click();
      return !!document.querySelector(".modal-backdrop, .modal.show");
    });
    if (!open) break;
    await sleep(350);
  }
  await sleep(200);
}

async function newPerson(browser, person, viewport) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  page.on("pageerror", (err) => (person.errors ??= []).push(String(err?.message ?? err)));
  person.saves = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && /\/api\/notes\/[^/]+\/data/.test(req.url())) person.saves.push(`${(Date.now() - t0) / 1000 | 0}s sent ${req.url().split("/api/notes/")[1]}`);
  });
  page.on("response", (res) => {
    const req = res.request();
    if (req.method() === "PUT" && /\/api\/notes\/[^/]+\/data/.test(req.url())) person.saves.push(`${(Date.now() - t0) / 1000 | 0}s ${res.status()} ${req.url().split("/api/notes/")[1]}`);
  });
  for (const c of person.cookie.split("; ")) {
    const [k, ...v] = c.split("=");
    await page.setCookie({ name: k, value: v.join("="), url: WEB });
  }
  person.context = context;
  person.page = page;
  return page;
}

/** Closes the host's own dialogs (what's new, tutorials, hints), as `tf-team-check.mjs` does. */
async function dismissHostDialogs(page) {
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

async function enterTab(person) {
  await person.page.goto(`${WEB}${tabUrl}`, { waitUntil: "domcontentloaded" });
  const ready = await until(() => person.page.evaluate(() => document.querySelector('[data-testid="notes-tab"]')?.getAttribute("data-bridge") === "ready"), 90_000, 300);
  if (!ready) {
    const state = await person.page.evaluate(() => ({ bridge: document.querySelector('[data-testid="notes-tab"]')?.getAttribute("data-bridge"), url: location.href, body: document.body.innerText.slice(0, 200) })).catch((e) => String(e));
    throw new Error(`the notebook frame never said ready ${JSON.stringify(state)}`);
  }
  const frame = await frameOf(person, 30_000);
  await sleep(800);
  await dismissHostDialogs(person.page);
  return frame;
}

function unzip(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map();
      zip.on("entry", (entry) => zip.openReadStream(entry, (e, stream) => {
        if (e) return reject(e);
        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      }));
      zip.on("end", () => resolve(files));
      zip.readEntry();
    });
  });
}

/** "checked" / "open" for the saved to-do item whose text starts with `text`, else null. */
function todoState(html, text) {
  for (const li of html.split(/<li\b/).slice(1)) {
    const body = li.slice(li.indexOf(">") + 1).split("</li>")[0];
    // Either `<span class="todo-list__label__description">` or, with a block id, a `<p>` after the label.
    const description = body.replace(/<a class="tf-chip"[\s\S]*?<\/a>/g, "").replace(/<[^>]+>/g, "").replace(/&nbsp;|\u00a0/g, " ").trim();
    if (description.startsWith(text)) return /<input[^>]*\bchecked\b/.test(body) ? "checked" : "open";
  }
  return null;
}

const todo = (text, { id, checked } = {}) =>
  `<li${id ? ` data-trilium-block-id="${id}"` : ""}><label class="todo-list__label"><input type="checkbox" disabled="disabled"${checked ? ' checked="checked"' : ""}><span class="todo-list__label__description">${text}</span></label></li>`;

// ── The walk ────────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-features=PrivateNetworkAccessRespectPreflightResults"] });
const notes = {};
let taskId = "";
let downloadEvents = [];
let taskHref = "";

try {
  await check("two people sign in to a throw-away workspace", async () => {
    await setup();
    await devLogin(ada);
    await devLogin(bea);
    await newPerson(browser, ada, { width: 1440, height: 900 });
    await newPerson(browser, bea, { width: 1440, height: 900 });
    return `${ada.name} (edit), ${bea.name} (member)`;
  });

  await check("a notes tab is made through the web API", async () => {
    const r = await webApi(ada, "POST", `/api/projects/${projectId}/views/save-as-tab`, { name: "Work notes", parentDataSourceId: tasksDs, notes: true });
    assert(r.status === 201 && r.json?.notebookId, `save-as-tab ${r.status} ${r.text}`);
    notebookId = r.json.notebookId;
    let viewId = r.json.view?.id ?? r.json.viewId ?? r.json.id;
    if (!viewId) {
      const [row] = await sql`SELECT id FROM saved_view WHERE "projectId" = ${projectId} AND name = 'Work notes'`;
      viewId = row?.id;
    }
    assert(notebookId && viewId, `no notebook or view: ${r.text.slice(0, 200)}`);
    tabUrl = `/p/${projectId}?tab=table&view=${viewId}&overview=${tasksDs}`;
    return notebookId;
  });

  await check("Ada's notebook frame runs this build and announces the work capabilities", async () => {
    await enterTab(ada);
    const caps = await until(() => ada.page.evaluate(() => document.querySelector('[data-testid="notes-tab"]')?.getAttribute("data-bridge")), 20000);
    const boot = await engine(ada, "GET", "/api/tf/bootstrap");
    assert(boot.status === 200, `bootstrap ${boot.status} ${boot.text}`);
    const launch = await until(async () => ((await ada.frame.$$('[data-tf-work="todos"], [data-tf-work="reminders"]')).length >= 2 ? true : null), 10000);
    assert(launch, "no To-dos / Reminders buttons in the launch bar");
    return `engine ${boot.json.engineVersion ?? boot.json.version ?? JSON.stringify(boot.json).slice(0, 120)}, bridge ${caps}`;
  });

  await check("three text notes with to-dos, a heading, a table and an image are written in the engine", async () => {
    const mk = async (title, content) => {
      const r = await engine(ada, "POST", "/api/notes/root/children?target=into", { title, type: "text", content });
      assert(r.status === 200, `create ${title}: ${r.status} ${r.text}`);
      return r.json.note.noteId;
    };
    notes.plan = await mk("Launch plan", `<h2>Launch plan</h2><p>Venue and invites first.</p><ul class="todo-list">${todo("Book the venue", { id: "venue1" })}${todo("Send invites")}</ul><figure class="table"><table><thead><tr><th>Item</th><th>Owner</th></tr></thead><tbody><tr><td>Venue</td><td>Ada</td></tr><tr><td colspan="2">Budget to follow</td></tr></tbody></table></figure>`);
    // The picture goes in the way a paste does: multipart upload, then an <img> with the answered URL.
    const upload = await ada.frame.evaluate(async (noteId) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 400;
      const g = canvas.getContext("2d");
      g.fillStyle = "#e8eef5"; g.fillRect(0, 0, 1200, 400);
      g.fillStyle = "#2b6cb0"; for (let i = 0; i < 6; i++) g.fillRect(80 + i * 180, 360 - (i + 2) * 40, 120, (i + 2) * 40);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const form = new FormData();
      form.append("upload", blob, "chart.png");
      const res = await fetch(`api/notes/${noteId}/attachments/upload`, { method: "POST", body: form, headers: { "x-csrf-token": window.glob.csrfToken } });
      return { status: res.status, size: blob.size, json: await res.json().catch(() => null) };
    }, notes.plan);
    assert(upload.status === 200 && upload.json?.uploaded && upload.json.url, `upload ${upload.status} ${JSON.stringify(upload.json)}`);
    const blob = await engine(ada, "GET", `/api/notes/${notes.plan}/blob`);
    const withImage = `${blob.json.content}<figure class="image"><img src="${upload.json.url}" alt="Chart"></figure>`;
    const put = await engine(ada, "PUT", `/api/notes/${notes.plan}/data`, { content: withImage });
    assert(put.status < 300, `put ${put.status} ${put.text}`);
    notes.print = await mk("Print run", `<p>Printer notes.</p><ul class="todo-list">${todo("Call the printer", { id: "print1" })}${todo("Approve proofs", { id: "print2" })}${todo("Old item", { checked: true })}</ul>`);
    notes.shop = await mk("Shop", `<ul class="todo-list">${todo("Order boxes")}</ul><p>Links: </p>`);
    return `${notes.plan}, ${notes.print}, ${notes.shop}; image ${upload.size} bytes`;
  });

  // ── Reminders ─────────────────────────────────────────────────────────────
  await check("Remind me from the note menu: quick choice saves a reminder and the bell shows 1", async () => {
    await openNote(ada, notes.plan);
    await ada.frame.click(".note-actions .dropdown-toggle, .note-actions button");
    await clickMenuItem(ada, "Remind me");
    await ada.frame.waitForSelector(".modal.tf-reminder-dialog.show", { timeout: 5000 });
    const prefilled = await ada.frame.$eval(".tf-reminder-dialog input[name=tf-reminder-text]", (el) => el.value);
    assert(prefilled === "Launch plan", `prefilled "${prefilled}"`);
    await shot(ada, "desktop-light-reminder-sheet");
    await ada.frame.evaluate(() => [...document.querySelectorAll(".tf-reminder-quick-button")].find((b) => /1 hour|1 uur/.test(b.textContent))?.click());
    const bell = await until(() => ada.frame.$eval('[data-tf-work="bell"]', (el) => el.textContent.trim()).catch(() => null), 8000);
    assert(bell === "1", `bell "${bell}"`);
    const cleared = await until(() => ada.frame.evaluate(() => (document.querySelector(".modal-backdrop, .modal.show") ? null : true)), 4000);
    const left = await ada.frame.evaluate(() => [...document.querySelectorAll(".modal-backdrop, .modal.show, body.modal-open")].map((e) => `${e.tagName}.${e.className}`));
    assert(cleared, `the dialog left ${JSON.stringify(left)} on the page`);
    return "bell 1, dialog and backdrop gone";
  });

  await check("Remind me on a to-do item (right-click at a bare caret): saved with its block id, clock beside the item", async () => {
    await caretInTodo(ada, 0);
    const li = await todoLi(ada, 0);
    const box = await li.boundingBox();
    await ada.frame.evaluate(() => {
      window.getSelection()?.collapseToEnd();
      window.__tfCtx = [];
      document.addEventListener("contextmenu", (e) => window.__tfCtx.push({ phase: "capture", t: e.target.className?.toString().slice(0, 40) }), { capture: true, once: true });
      document.addEventListener("contextmenu", (e) => window.__tfCtx.push({ phase: "bubble", t: e.target.className?.toString().slice(0, 40), prevented: e.defaultPrevented }), { once: true });
    });
    await li.click({ button: "right", offset: { x: Math.min(120, box.width / 2), y: box.height / 2 } });
    await sleep(400);
    const ctx = await ada.frame.evaluate(() => JSON.stringify(window.__tfCtx));
    try {
      await clickMenuItem(ada, "Remind me");
    } catch (e) {
      throw new Error(`${e.message} contextmenu ${ctx}`);
    }
    await ada.frame.waitForSelector(".modal.tf-reminder-dialog.show", { timeout: 5000 });
    const text = await ada.frame.$eval(".tf-reminder-dialog input[name=tf-reminder-text]", (el) => el.value);
    assert(text === "Book the venue", `prefilled "${text}"`);
    await ada.frame.evaluate(() => [...document.querySelectorAll(".tf-reminder-quick-button")].find((b) => /Tomorrow|Morgen/.test(b.textContent))?.click());
    const clock = await until(() => ada.frame.$(".tf-todo-layer .tf-todo-clock"), 8000);
    assert(clock, "no clock beside the item");
    const mine = await gw(ada, "GET", "reminders?mine=1");
    const onItem = mine.json.reminders.find((r) => r.blockId === "venue1");
    assert(mine.status === 200 && mine.json.reminders.length === 2 && onItem, JSON.stringify(mine.json).slice(0, 300));
    const bell = await ada.frame.$eval('[data-tf-work="bell"]', (el) => el.textContent.trim());
    return `GET /__tf/api/reminders?mine=1 → ${mine.json.reminders.length} rows, block ${onItem.blockId}, bell ${bell}`;
  });

  await check("the bell lists the note's reminders; the notebook list groups them", async () => {
    await noModal(ada);
    await ada.frame.click('[data-tf-work="bell"]');
    const rows = await until(() => ada.frame.$$eval(".tf-note-bell-menu .tf-reminder-row", (els) => els.length), 5000);
    if (rows !== 2) await shot(ada, "debug-bell");
    assert(rows === 2, `bell rows ${rows}; ${await ada.frame.evaluate(() => JSON.stringify({ menus: [...document.querySelectorAll(".tf-note-bell-menu, .dropdown-menu.show")].map((m) => `${m.className}:${m.children.length}`), bells: document.querySelectorAll('[data-tf-work="bell"]').length }))}`);
    await shot(ada, "desktop-light-bell");
    await ada.page.keyboard.press("Escape");
    await ada.frame.click('[data-tf-work="reminders"]');
    await ada.frame.waitForSelector(".modal.tf-reminders-dialog.show .tf-reminder-row", { timeout: 8000 });
    const groups = await ada.frame.$$eval(".tf-reminders-dialog .tf-reminder-group", (els) => els.map((e) => `${e.querySelector("h3").textContent}:${e.querySelectorAll(".tf-reminder-row").length}`));
    await shot(ada, "desktop-light-reminders-list");
    await closeModals(ada);
    return groups.join(", ");
  });

  // ── To-do roll-up ─────────────────────────────────────────────────────────
  let firstItem = null;
  await check("the roll-up lists the open items of three notes, grouped by note", async () => {
    await ada.frame.evaluate(() => {
      window.__tfClicks = [];
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        document.addEventListener(type, (e) => window.__tfClicks.push(`${type}:${e.target?.tagName}.${e.target?.className?.toString().slice(0, 40)}${e.defaultPrevented ? " prevented" : ""}`), { capture: true });
        window.addEventListener(type, (e) => window.__tfClicks.push(`${type}@bubble${e.defaultPrevented ? " prevented" : ""}`));
      }
      const root = document.querySelector(".tf-work-dialogs");
      if (root) new MutationObserver((ms) => window.__tfClicks.push(`root:+${ms.reduce((n, m) => n + m.addedNodes.length, 0)}-${ms.reduce((n, m) => n + m.removedNodes.length, 0)}`)).observe(root, { childList: true, subtree: false });
    });
    await ada.frame.click('[data-tf-work="todos"]');
    try {
      await ada.frame.waitForSelector(".modal.tf-todos-dialog.show .tf-todo-row", { timeout: 10000 });
    } catch (err) {
      // Say what is on screen instead: the dialog's own text, any other open dialog, and what the engine lists.
      const seen = await ada.frame.evaluate(() => ({
        button: !!document.querySelector('[data-tf-work="todos"]'),
        modals: [...document.querySelectorAll(".modal")].filter((m) => m.classList.contains("show")).map((m) => m.className.slice(0, 80)),
        dialog: document.querySelector(".tf-todos-dialog")?.textContent?.replace(/\s+/g, " ").slice(0, 300) ?? null,
        root: document.querySelector(".tf-work-dialogs")?.innerHTML.slice(0, 200) ?? "no root",
        buttons: [...document.querySelectorAll('[data-tf-work="todos"]')].map((b) => `${b.tagName}.${b.className.toString().slice(0, 50)} visible=${b.offsetParent !== null} disabled=${b.disabled}`),
        at: (() => { const b = document.querySelector('[data-tf-work="todos"]'); const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} top=${top?.tagName}.${top?.className?.toString().slice(0, 60)}`; })(),
      }));
      seen.events = await ada.frame.evaluate(() => window.__tfClicks.slice(0, 30));
      await ada.frame.evaluate(() => document.querySelector('[data-tf-work="todos"]').click());
      seen.afterDomClick = await ada.frame.waitForSelector(".modal.tf-todos-dialog.show", { timeout: 3000 }).then(() => "opens", () => "still nothing");
      const api = await engine(ada, "GET", "/api/tf/todos?scope=notebook&state=open");
      await shot(ada, "fail-todos");
      throw new Error(`${err.message}; on screen ${JSON.stringify(seen)}; engine ${api.status} ${JSON.stringify(api.json).slice(0, 500)}`);
    }
    const groups = await ada.frame.$$eval(".tf-todos-dialog .tf-todo-group", (els) => els.map((g) => `${g.querySelector(".tf-todo-note-title").textContent}:${g.querySelectorAll(".tf-todo-row").length}`));
    const count = await ada.frame.$eval(".tf-todos-dialog .tf-work-count", (el) => el.textContent);
    assert(groups.length === 3 && groups.join(",") === "Launch plan:2,Print run:2,Shop:1", groups.join(","));
    await shot(ada, "desktop-light-todos");
    const api = await engine(ada, "GET", "/api/tf/todos?scope=notebook&state=open");
    firstItem = api.json.items.find((i) => i.text === "Call the printer");
    return `${groups.join(", ")}; header ${count}`;
  });

  await check("ticking an item changes the note in the engine and it leaves the open list", async () => {
    const before = await engine(ada, "GET", `/api/notes/${notes.print}/blob`);
    await ada.frame.evaluate(() => {
      const row = [...document.querySelectorAll(".tf-todos-dialog .tf-todo-row")].find((r) => r.textContent.includes("Call the printer"));
      row.querySelector("input[type=checkbox]").click();
    });
    const after = await until(async () => {
      const b = await engine(ada, "GET", `/api/notes/${notes.print}/blob`);
      return /data-trilium-block-id="print1"><label class="todo-list__label"><input type="checkbox" disabled="disabled" checked="checked"/.test(b.json.content) ? b : null;
    }, 8000);
    assert(after, "the note content has no checked item");
    const gone = await until(() => ada.frame.evaluate(() => ![...document.querySelectorAll(".tf-todos-dialog .tf-todo-row")].some((r) => r.textContent.includes("Call the printer"))), 8000);
    assert(gone, "the ticked item is still listed");
    const api = await engine(ada, "GET", "/api/tf/todos?scope=notebook&state=open");
    assert(!api.json.items.some((i) => i.text === "Call the printer"), "still open in the API");
    return `blob ${before.json.blobId?.slice(0, 6) ?? "?"} → ${after.json.blobId?.slice(0, 6) ?? "?"}, ${api.json.total} open left`;
  });

  await check("a stale toggle gets 409 (API) and the list rolls back with a message (UI)", async () => {
    const stale = await engine(ada, "POST", "/api/tf/todos/toggle", { noteId: notes.print, blockId: "print2", checked: true, baseBlobId: firstItem ? "staleBlob000" : "x" });
    assert(stale.status === 409 && stale.json?.conflict === true, `${stale.status} ${stale.text}`);
    // Someone changes the note behind the open list; the next tick from the list is stale.
    const blob = await engine(ada, "GET", `/api/notes/${notes.shop}/blob`);
    await engine(ada, "PUT", `/api/notes/${notes.shop}/data`, { content: `${blob.json.content}<p>Changed elsewhere.</p>` });
    await ada.frame.evaluate(() => {
      // The list keeps the blob it loaded until it refetches; tick before it does.
      const row = [...document.querySelectorAll(".tf-todos-dialog .tf-todo-row")].find((r) => r.textContent.includes("Order boxes"));
      row?.querySelector("input[type=checkbox]")?.click();
    });
    const toastText = await until(() => ada.frame.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ")), 6000);
    const still = await until(() => ada.frame.evaluate(() => {
      const row = [...document.querySelectorAll(".tf-todos-dialog .tf-todo-row")].find((r) => r.textContent.includes("Order boxes"));
      return row && !row.querySelector("input").checked ? "unticked" : null;
    }), 6000);
    await closeModals(ada);
    return `API 409; UI ${/changed in the meantime/.test(toastText ?? "") ? "toast" : "refetched before the tick"}, row ${still}`;
  });

  // ── Make task, linked to-do, live chip ────────────────────────────────────
  await check("Make task on a to-do creates a real Taskforce task and puts its chip at the end of the line", async () => {
    await openNote(ada, notes.print);
    await caretInTodo(ada, 1);
    const li = await todoLi(ada, 1);
    await li.hover();
    const action = await until(() => ada.frame.$(".tf-todo-layer .tf-todo-action"), 5000);
    assert(action, `no Make task action at the end of the item ${await diag(ada)} errors ${JSON.stringify((ada.errors ?? []).slice(-3))}`);
    await action.click();
    await ada.frame.waitForSelector(".modal.tf-make-task-dialog.show", { timeout: 5000 });
    const title = await ada.frame.$eval(".tf-make-task-dialog input[name=tf-task-title]", (el) => el.value);
    assert(title === "Approve proofs", `title "${title}"`);
    await ada.frame.select(".tf-make-task-dialog select[name=tf-task-assignee]", bea.id).catch(() => {});
    await shot(ada, "desktop-light-make-task");
    await ada.frame.evaluate(() => document.querySelector(".tf-make-task-dialog .modal-footer .btn-primary")?.click());
    const chip = await until(() => ada.frame.evaluate(() => {
      const li = [...document.querySelectorAll(".ck-editor__editable ul.todo-list > li")].find((l) => l.textContent.includes("Approve proofs"));
      const c = li?.querySelector(".tf-chip.tf-chip--ok");
      return c ? { id: c.getAttribute("data-tf-id"), href: c.getAttribute("data-tf-href"), text: c.textContent } : null;
    }), 10000);
    assert(chip, "no resolved task chip in the line");
    taskId = chip.id;
    taskHref = chip.href;
    const list = await webApi(ada, "GET", `/api/projects/${projectId}/tasks`);
    const task = list.json.tasks.find((x) => x.id === taskId);
    assert(task && task.title === "Approve proofs", `task not in Taskforce: ${list.text}`);
    return `${task.title} (${task.status}), assignees ${task.assigneeIds?.length ?? 0}; chip "${chip.text}"`;
  });

  await check("ticking the linked to-do completes the task in Taskforce; the chip follows", async () => {
    await ada.frame.evaluate(() => {
      const li = [...document.querySelectorAll(".ck-editor__editable ul.todo-list > li")].find((l) => l.textContent.includes("Approve proofs"));
      li.querySelector("input[type=checkbox]").click();
    });
    const done = await until(async () => {
      const list = await webApi(ada, "GET", `/api/projects/${projectId}/tasks`);
      const task = list.json.tasks.find((x) => x.id === taskId);
      return task && task.status === "st_done" ? task : null;
    }, 10000);
    assert(done, "the task is not done in Taskforce");
    const chipDone = await until(() => ada.frame.$(".ck-editor__editable .tf-chip--done"), 6000);
    assert(chipDone, "the chip did not turn done");
    return `status ${done.status}`;
  });

  await check("reopening the task in Taskforce unticks the to-do in the note and updates the chip live", async () => {
    assert(taskId, "no task was made");
    ada.saves.push(`${(Date.now() - t0) / 1000 | 0}s PATCH st_todo`);
    await withEditor(ada, (editor, start) => {
      window.__tfWorkTrail = [];
      editor.model.document.on("change:data", (evt, batch) => window.__tfWorkTrail.push(`${((Date.now() - start) / 1000).toFixed(1)}s change undoable=${batch.isUndoable} local=${batch.isLocal}`));
      const ctx = window.glob.appContext.tabManager.getActiveContext();
      const set = ctx.setContextData.bind(ctx);
      ctx.setContextData = (key, value) => { if (key === "saveState") window.__tfWorkTrail.push(`${((Date.now() - start) / 1000).toFixed(1)}s ${value.state}`); return set(key, value); };
    }, t0);
    const r = await webApi(ada, "PATCH", `/api/projects/${projectId}/tasks/${taskId}`, { status: "st_todo" });
    assert(r.status === 200, `PATCH ${r.status} ${r.text}`);
    const chip = await until(() => ada.frame.evaluate(() => !document.querySelector(".ck-editor__editable .tf-chip--done") && !!document.querySelector(".ck-editor__editable .tf-chip--ok")), 10000);
    assert(chip, "the chip still shows done");
    await ada.frame.evaluate(() => document.activeElement?.blur());
    const content = await until(async () => {
      const b = await engine(ada, "GET", `/api/notes/${notes.print}/blob`);
      return todoState(b.json.content, "Approve proofs") === "open" ? b.json.content : null;
    }, 15000);
    if (!content) {
      const state = await withEditor(ada, (editor) => {
        const out = [];
        for (const { item } of editor.model.createRangeIn(editor.model.document.getRoot())) {
          if (item.is("element") && item.getAttribute("listType") === "todo") out.push(`${item.name}:${item.getAttribute("todoListChecked") ?? "-"}:${[...item.getChildren()].map((c) => c.is("$text") ? c.data : c.name).join("|")}`);
        }
        return out;
      });
      const dom = await ada.frame.evaluate(() => [...document.querySelectorAll(".ck-editor__editable ul.todo-list > li input")].map((i) => i.checked));
      const saved = (await engine(ada, "GET", `/api/notes/${notes.print}/blob`)).json?.content ?? "";
      const li = /<li(?:(?!<\/li>).)*Approve proofs(?:(?!<\/li>).)*<\/li>/.exec(saved)?.[0] ?? saved.slice(0, 600);
      throw new Error(`the to-do is still ticked in the saved note; state ${todoState(saved, "Approve proofs")} li ${li} model ${JSON.stringify(state)} dom ${JSON.stringify(dom)} saves ${JSON.stringify(ada.saves.slice(-10))} modals ${await ada.frame.evaluate(() => JSON.stringify([...document.querySelectorAll(".modal.show")].map((m) => m.className)))} saveState ${await ada.frame.evaluate(() => JSON.stringify(window.glob.appContext.tabManager.getActiveContext()?.getContextData?.("saveState") ?? null))} at ${(Date.now() - t0) / 1000 | 0}s trail ${await ada.frame.evaluate(() => JSON.stringify(window.__tfWorkTrail ?? null))}`);
    }
    const r2 = await webApi(ada, "PATCH", `/api/projects/${projectId}/tasks/${taskId}`, { status: "st_done" });
    const ticked = await until(async () => {
      const b = await engine(ada, "GET", `/api/notes/${notes.print}/blob`);
      return todoState(b.json.content, "Approve proofs") === "checked" ? true : null;
    }, 15000);
    if (!(r2.status === 200 && ticked)) {
      const state = await ada.frame.evaluate(() => {
        const li = [...document.querySelectorAll(".ck-editor__editable ul.todo-list > li")].find((l) => l.textContent.includes("Approve proofs"));
        return { checked: li?.querySelector("input")?.checked, chip: li?.querySelector(".tf-chip")?.className, focused: document.activeElement?.className?.toString().slice(0, 50) };
      });
      const b = await engine(ada, "GET", `/api/notes/${notes.print}/blob`);
      const task = (await webApi(ada, "GET", `/api/projects/${projectId}/tasks`)).json?.tasks?.find((x) => x.id === taskId);
      throw new Error(`completing in Taskforce did not tick the to-do: PATCH ${r2.status}, task ${task?.status}, editor ${JSON.stringify(state)}, saved ${todoState(b.json.content, "Approve proofs")} ${(/<li(?:(?!<\/li>).)*Approve proofs(?:(?!<\/li>).)*<\/li>/.exec(b.json.content)?.[0] ?? b.json.content).slice(0, 400)}`);
    }
    return "unticked, then ticked again from Taskforce";
  });

  await check("pasting a task URL makes a chip; undo turns it back into the link", async () => {
    assert(taskId, "no task was made, nothing to paste");
    await openNote(ada, notes.shop);
    await withEditor(ada, (editor) => {
      const root = editor.model.document.getRoot();
      const last = root.getChild(root.childCount - 1);
      editor.model.change((w) => w.setSelection(w.createPositionAt(last, "end")));
      editor.editing.view.focus();
    });
    const url = `${WEB}/p/${projectId}?task=${taskId}`;
    await ada.frame.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      document.querySelector(".ck-editor__editable").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, url);
    const chip = await until(() => ada.frame.$eval(".ck-editor__editable p .tf-chip", (el) => el.className).catch(() => null), 6000);
    assert(chip, "no chip after the paste");
    await withEditor(ada, (editor) => editor.execute("undo"));
    const link = await until(() => ada.frame.evaluate((u) => {
      const p = [...document.querySelectorAll(".ck-editor__editable p")].pop();
      return !p.querySelector(".tf-chip") && [...p.querySelectorAll("a")].some((a) => a.getAttribute("href") === u) ? "link" : null;
    }, url), 5000);
    assert(link, "undo did not leave the plain link");
    await withEditor(ada, (editor) => editor.execute("redo"));
    return `chip (${chip.split(" ").filter((c) => c.startsWith("tf-chip--")).join(" ")}), undo → link, redo → chip`;
  });

  await check("a paragraph with three chips: a task, a project, a project Ada alone can open", async () => {
    await withEditor(ada, (editor) => {
      const root = editor.model.document.getRoot();
      editor.model.change((w) => w.setSelection(w.createPositionAt(root.getChild(root.childCount - 1), "end")));
      editor.editing.view.focus();
    });
    for (const u of [`${WEB}/p/${projectId}`, `${WEB}/p/${privateProjectId}`]) {
      await ada.frame.evaluate((text) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        document.querySelector(".ck-editor__editable").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, ` ${u}`.trim());
      await sleep(600);
    }
    const kinds = await until(() => ada.frame.evaluate(() => {
      const chips = [...document.querySelectorAll(".ck-editor__editable p .tf-chip")];
      return chips.length >= 3 && chips.every((c) => c.matches(".tf-chip--ok")) ? chips.map((c) => `${c.getAttribute("data-tf-kind")}:${c.textContent.trim()}`) : null;
    }), 8000);
    assert(kinds, `the three chips did not resolve for Ada: ${await ada.frame.evaluate(() => JSON.stringify([...document.querySelectorAll(".ck-editor__editable p .tf-chip")].map((c) => `${c.className}|${c.textContent.trim()}`)))}`);
    await shot(ada, "desktop-light-chips");
    // Save now, so Bea's engine read has them.
    await ada.frame.evaluate(() => window.glob.appContext.triggerCommand("saveNoteDetailNow"));
    await until(async () => (await engine(ada, "GET", `/api/notes/${notes.shop}/blob`)).json.content.split("tf-chip").length >= 4, 8000);
    return kinds.join(", ");
  });

  await check("Bea sees the project she cannot open as No access", async () => {
    await enterTab(bea);
    await openNote(bea, notes.shop);
    const states = await until(() => bea.frame.evaluate(() => {
      const chips = [...document.querySelectorAll(".ck-content .tf-chip")];
      if (chips.length < 3 || chips.some((c) => c.matches(".tf-chip--loading"))) return null;
      return chips.map((c) => `${c.getAttribute("data-tf-kind") ?? "?"}:${c.matches(".tf-chip--no-access") ? "no-access" : c.matches(".tf-chip--removed") ? "removed" : "ok"}:${c.textContent.trim()}`);
    }), 15000);
    assert(states && states.some((s) => /project:no-access:No access/.test(s)), JSON.stringify(states));
    await shot(bea, "desktop-light-chips-bea");
    return states.join(", ");
  });

  await check("pressing a chip sends open to the host (Taskforce opens the task)", async () => {
    assert(taskId, "no task chip to press");
    const before = ada.page.url();
    const chip = await ada.frame.$(`.ck-editor__editable .tf-chip[data-tf-id="${taskId}"] .tf-chip__title`);
    assert(chip, "no task chip in the note");
    await chip.click();
    const after = await until(() => (ada.page.url().includes(taskId) ? ada.page.url() : null), 8000);
    assert(after, `host stayed at ${before}`);
    return after.replace(WEB, "");
  });

  // ── Word export ───────────────────────────────────────────────────────────
  await check("Word export from the export dialog downloads a .docx with the heading, a table and an image", async () => {
    await enterTab(ada);
    await openNote(ada, notes.plan);
    const dir = path.join(SHOTS ?? "/tmp", "downloads");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const cdp = await browser.target().createCDPSession();
    downloadEvents = [];
    cdp.on("Browser.downloadWillBegin", (e) => downloadEvents.push(`begin ${e.suggestedFilename} ${e.url.slice(0, 40)}`));
    cdp.on("Browser.downloadProgress", (e) => { if (e.state !== "inProgress") downloadEvents.push(`${e.state}`); });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true, ...(ada.context.id ? { browserContextId: ada.context.id } : {}) });
    await ada.frame.click(".note-actions .dropdown-toggle, .note-actions button");
    await clickMenuItem(ada, "Export note");
    await ada.frame.waitForSelector(".modal.export-dialog.show", { timeout: 5000 });
    await ada.frame.evaluate(() => [...document.querySelectorAll(".export-dialog .export-type-group button")].find((b) => /single|this note only|alleen/i.test(b.textContent))?.click());
    await sleep(300);
    const picked = await ada.frame.evaluate(() => {
      const card = [...document.querySelectorAll(".export-dialog button.selectable-card")].find((c) => /Word document/.test(c.textContent));
      card?.click();
      return !!card;
    });
    assert(picked, "no Word format in the export dialog");
    await shot(ada, "desktop-light-export-dialog");
    await ada.frame.evaluate(() => {
      window.__tfDl = [];
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { window.__tfDl.push(`a ${this.download} ${this.href.slice(0, 40)}`); return click.call(this); };
      new MutationObserver(() => { for (const t of document.querySelectorAll(".toast")) if (!window.__tfDl.includes(t.textContent.trim())) window.__tfDl.push(t.textContent.trim()); }).observe(document.body, { childList: true, subtree: true });
      window.__tfDl.push(`selected ${document.querySelector(".export-dialog button.selectable-card.selected")?.textContent?.slice(0, 20)}`);
    });
    await (await ada.frame.$(".export-dialog .export-button")).click();
    const file = await until(() => {
      const f = readdirSync(dir).find((n) => n.endsWith(".docx"));
      return f && statSync(path.join(dir, f)).size > 0 ? path.join(dir, f) : null;
    }, 20000, 400);
    if (!file) {
      const toasts = await ada.frame.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent.trim()).join(" | "));
      const direct = await ada.frame.evaluate(async (id) => { const r = await fetch(`api/tf/export/docx/${id}`); return `${r.status} ${r.headers.get("content-type")} ${(await r.blob()).size}`; }, notes.plan);
      const dialog = await ada.frame.evaluate(() => ({ open: !!document.querySelector(".modal.export-dialog.show"), checked: [...document.querySelectorAll(".export-dialog input:checked")].map((i) => i.value) }));
      throw new Error(`no .docx downloaded; folder ${JSON.stringify(readdirSync(dir))} events ${JSON.stringify(downloadEvents)}; direct GET ${direct}; dialog ${JSON.stringify(dialog)}; toasts "${toasts}" trail ${await ada.frame.evaluate(() => JSON.stringify(window.__tfDl))} ${await diag(ada)} errors ${JSON.stringify((ada.errors ?? []).slice(-3))}`);
    }
    const files = await unzip(readFileSync(file));
    const xml = files.get("word/document.xml")?.toString("utf8") ?? "";
    const rels = files.get("word/_rels/document.xml.rels")?.toString("utf8") ?? "";
    assert(xml.includes(">Launch plan<") && xml.includes("<w:tbl>") && /relationships\/image/.test(rels) && [...files.keys()].some((k) => k.startsWith("word/media/")), "document.xml lacks the heading, the table or the image");
    assert(xml.includes("☐ ") || xml.includes("☑ "), "no to-do boxes");
    const media = [...files.entries()].find(([k]) => k.startsWith("word/media/"))?.[1];
    const kind = media && (media.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? "png" : media[0] === 0xff && media[1] === 0xd8 ? "jpeg" : media.subarray(8, 12).toString() === "WEBP" ? "webp" : null);
    assert(kind, `the image in the file is not a picture (${media?.subarray(0, 12).toString("hex")})`);
    const shown = await ada.frame.evaluate(() => [...document.querySelectorAll(".ck-editor__editable img")].map((i) => i.naturalWidth));
    assert(shown.length && shown.every((w) => w > 0), `the picture does not load in the note (${JSON.stringify(shown)})`);
    if (SHOTS) writeFileSync(path.join(SHOTS, "export-launch-plan.docx"), readFileSync(file));
    return `${path.basename(file)} ${statSync(file).size} bytes: heading, table, ${kind} image (${media.length} bytes, shown in the note at ${shown[0]} px), to-do boxes`;
  });

  await check("Download as Word from the note menu, with no user gesture left, still downloads the file", async () => {
    const dir = path.join(SHOTS ?? "/tmp", "downloads");
    for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { force: true });
    await noModal(ada);
    await ada.frame.click(".note-actions .dropdown-toggle, .note-actions button");
    await clickMenuItem(ada, "Download as Word");
    const file = await until(() => {
      const f = readdirSync(dir).find((n) => n.endsWith(".docx"));
      return f && statSync(path.join(dir, f)).size > 0 ? path.join(dir, f) : null;
    }, 20000, 400);
    assert(file, `no .docx downloaded; folder ${JSON.stringify(readdirSync(dir))} events ${JSON.stringify(downloadEvents)}; frame still at ${ada.frame.url().slice(0, 60)}`);
    const xml = (await unzip(readFileSync(file))).get("word/document.xml")?.toString("utf8") ?? "";
    assert(xml.includes(">Launch plan<"), "the file lacks the heading");
    const alive = await ada.frame.evaluate(() => !!window.glob?.appContext).catch(() => false);
    assert(alive, "the notebook frame navigated away");
    return `${path.basename(file)} ${statSync(file).size} bytes, the notebook stayed open`;
  });

  // ── Phone ─────────────────────────────────────────────────────────────────
  await check("phone 390 x 844 (touch): the reminder sheet and the to-do view are usable, 44 px targets", async () => {
    await ada.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await enterTab(ada);
    await until(() => ada.frame.evaluate(() => document.documentElement.classList.contains("tf-touch")), 10000);
    await openNote(ada, notes.plan);
    const small = [];
    const measure = (sel) => ada.frame.$$eval(sel, (els) => els.filter((e) => e.offsetParent !== null).map((e) => {
      const r = e.getBoundingClientRect();
      return { sel: e.className.toString().slice(0, 40) || e.tagName, w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= 0 && r.right <= innerWidth + 1 };
    }));
    for (const m of await measure('[data-tf-work="bell"]')) if (m.w < 44 || m.h < 44 || !m.inside) small.push(m);
    await screen(ada, "tree");
    const launch = await until(() => ada.frame.evaluate(() => [...document.querySelectorAll('.tf-work-navigator-row [data-tf-work]')].filter((e) => e.offsetParent !== null).length), 8000);
    assert(launch === 2, `the navigator header has ${launch} work buttons`);
    for (const m of await measure('.tf-work-navigator-row [data-tf-work]')) if (m.w < 44 || m.h < 44 || !m.inside) small.push(m);
    const swipeable = await ada.frame.evaluate(() => document.querySelector("#launcher-pane")?.classList.contains("tab-swipe") ?? null);
    assert(swipeable !== false, "the phone launch bar no longer fits and lost its tab swipe");
    await shot(ada, "phone-light-navigator");
    await ada.frame.tap('.tf-work-navigator-row [data-tf-work="todos"]');
    await ada.frame.waitForSelector(".modal.tf-todos-dialog.show .tf-todo-row", { timeout: 10000 });
    for (const m of await measure(".tf-todos-dialog .tf-todo-check, .tf-todos-dialog .tf-todo-text, .tf-todos-dialog .tf-segment, .tf-todos-dialog .tf-todo-note")) if (m.w < 44 || m.h < 44 || !m.inside) small.push(m);
    await shot(ada, "phone-light-todos");
    await closeModals(ada);
    await screen(ada, "detail");
    await ada.frame.tap(".note-actions .dropdown-toggle, .note-actions button");
    await clickMenuItem(ada, "Remind me");
    await ada.frame.waitForSelector(".modal.tf-reminder-dialog.show", { timeout: 5000 });
    const native = await ada.frame.$eval(".tf-reminder-dialog input[type=date]", () => true).catch(() => false);
    for (const m of await measure(".tf-reminder-dialog .tf-reminder-quick-button, .tf-reminder-dialog input, .tf-reminder-dialog select, .tf-reminder-dialog .modal-footer .btn")) if (m.w < 44 || m.h < 44 || !m.inside) small.push(m);
    await shot(ada, "phone-light-reminder-sheet");
    await closeModals(ada);
    assert(native, "no native date input on touch");
    assert(small.length === 0, `targets under 44 px or off screen: ${JSON.stringify(small)}`);
    return "native date input; every new control ≥ 44 px and on screen";
  });

  // ── The surfaces, phone light and dark, desktop dark (desktop light comes from the checks) ──
  if (SHOTS) {
    const gallery = async (prefix) => {
      const p = ada;
      const tap = (sel) => (prefix.startsWith("phone") ? p.frame.tap(sel) : p.frame.click(sel));
      const phone = prefix.startsWith("phone");
      const open = async (sel, dialog, name) => {
        await noModal(p);
        if (phone) await screen(p, "tree");
        await tap(phone ? `.tf-work-navigator-row ${sel}` : sel);
        await p.frame.waitForSelector(dialog, { timeout: 10000 });
        await shot(p, `${prefix}-${name}`);
        await closeModals(p);
        if (phone) await screen(p, "detail");
      };
      await openNote(p, notes.plan);
      await noModal(p);
      await tap(".note-actions .dropdown-toggle, .note-actions button");
      await clickMenuItem(p, "Remind me");
      await p.frame.waitForSelector(".modal.tf-reminder-dialog.show", { timeout: 5000 });
      await shot(p, `${prefix}-reminder-sheet`);
      await closeModals(p);
      await open('[data-tf-work="reminders"]', ".modal.tf-reminders-dialog.show .tf-reminder-row", "reminders-list");
      await open('[data-tf-work="todos"]', ".modal.tf-todos-dialog.show .tf-todo-row", "todos");
      await noModal(p);
      await p.page.bringToFront();
      await caretInTodo(p, 1);
      for (let i = 0; !phone && i < 3; i++) {
        try {
          await (await todoLi(p, 1)).hover();
          break;
        } catch {
          await sleep(300);
        }
      }
      const action = await until(() => p.frame.$(".tf-todo-layer .tf-todo-action"), 5000);
      assert(action, `${prefix}: no Make task action`);
      await action.click();
      await p.frame.waitForSelector(".modal.tf-make-task-dialog.show", { timeout: 5000 });
      await shot(p, `${prefix}-make-task`);
      await closeModals(p);
      await openNote(p, notes.shop);
      await until(() => p.frame.evaluate(() => document.querySelectorAll(".ck-editor__editable .tf-chip.tf-chip--ok").length >= 3), 8000);
      await shot(p, `${prefix}-chips`);
      await noModal(p);
      await tap(".note-actions .dropdown-toggle, .note-actions button");
      await clickMenuItem(p, "Export note");
      await p.frame.waitForSelector(".modal.export-dialog.show", { timeout: 5000 });
      await p.frame.evaluate(() => [...document.querySelectorAll(".export-dialog button.selectable-card")].find((c) => /Word document/.test(c.textContent))?.click());
      await shot(p, `${prefix}-export-dialog`);
      await closeModals(p);
    };
    const theme = (mode) => until(() => ada.frame.evaluate((m) => document.body.getAttribute("data-theme-id") === `next-${m}`, mode), 10000);

    await check("screenshots: phone light and dark, desktop dark", async () => {
      await gallery("phone-light");
      await ada.page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
      assert(await theme("dark"), "the notebook did not follow the host into dark mode");
      await gallery("phone-dark");
      await ada.page.setViewport({ width: 1440, height: 900 });
      await enterTab(ada);
      await theme("dark");
      await gallery("desktop-dark");
      return SHOTS;
    });
  }
} catch (err) {
  failures++;
  console.log(`${stamp()} FAIL (crashed) ${err?.stack ?? err}`);
} finally {
  if (!KEEP) await teardown().catch(() => {});
  else console.log(`kept: notebook ${notebookId}, tab ${WEB}${tabUrl}, ada ${ada.email}, bea ${bea.email}`);
  await browser.close().catch(() => {});
  await sql.end({ timeout: 2 }).catch(() => {});
  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures ? 1 : 0);
}
