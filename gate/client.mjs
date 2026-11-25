#!/usr/bin/env node
// The embedded client of one engine build in headless Chromium, through a minimal host page.
//
//   CHROME_PATH=/path/to/chrome node gate/client.mjs --engine <unpacked build> [--json <file>]
//
// Three local servers: the engine (gateway env), a stand-in for the gateway on its own origin
// that adds the key and identity headers to every request and WebSocket upgrade (and takes the
// frame-blocking headers off, as the real gateway does), and a host page on a second origin that
// frames the notebook and speaks the host side of the bridge (contract "Bridge", protocol 1).
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import puppeteer from "puppeteer-core";

import { Engine, freePort } from "./engine.mjs";

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
};
const BUILD = path.resolve(arg("engine", ""));
const JSON_OUT = arg("json", "");
const CHROME = process.env.CHROME_PATH;
const PERSON = { id: "alice", name: "Alice Gate", role: "edit" };
const NOTEBOOK = "gateclientgateclient";

const checks = [];
function record(name, ok, detail = "") {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 400)})` : ""}`);
}

const version = JSON.parse(readFileSync(path.join(BUILD, "tf-version.json"), "utf8"));
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tf-gate-client-"));
const framePort = await freePort();
const hostPort = await freePort();
const FRAME = `http://127.0.0.1:${framePort}`;
// Same site as the frame (as nb-<id>.geshido.now and taskforce.geshido.now are): the engine's
// own cookies, CSRF among them, are first-party there.
const HOST = `http://127.0.0.1:${hostPort}`;

const engine = new Engine({ build: BUILD, dataDir, notebookId: NOTEBOOK, parentOrigins: [HOST] });
const servers = [];
let browser = null;

function identity() {
    return {
        "x-tf-gateway-key": engine.key,
        "x-tf-user-id": PERSON.id,
        "x-tf-user-name": encodeURIComponent(PERSON.name),
        "x-tf-role": PERSON.role,
    };
}

/** The gateway's rules that matter in a browser: identity in, frame blockers out. */
function frameServer() {
    const server = createServer((req, res) => {
        const headers = { ...req.headers, ...identity(), host: `127.0.0.1:${engine.port}` };
        for (const k of Object.keys(headers)) if (k.startsWith("x-tf-") && !(k in identity())) delete headers[k];
        const up = httpRequest({ host: "127.0.0.1", port: engine.port, method: req.method, path: req.url, headers }, (r) => {
            const out = { ...r.headers };
            delete out["x-frame-options"];
            delete out["cross-origin-opener-policy"];
            if (out["content-security-policy"]) {
                out["content-security-policy"] = String(out["content-security-policy"]).split(";").filter((d) => !/^\s*frame-ancestors/.test(d)).concat(` frame-ancestors ${HOST}`).join(";");
            }
            res.writeHead(r.statusCode ?? 502, out);
            r.pipe(res);
        });
        up.on("error", (err) => {
            res.writeHead(502).end(err.message);
        });
        req.pipe(up);
    });
    server.on("upgrade", (req, socket, head) => {
        const up = connect(engine.port, "127.0.0.1", () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            const add = identity();
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const name = req.rawHeaders[i];
                if (name.toLowerCase().startsWith("x-tf-") || name.toLowerCase() === "host") continue;
                lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
            }
            lines.push(`Host: 127.0.0.1:${engine.port}`);
            for (const [k, v] of Object.entries(add)) lines.push(`${k}: ${v}`);
            up.write(lines.join("\r\n") + "\r\n\r\n");
            if (head?.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        up.on("error", () => socket.destroy());
        socket.on("error", () => up.destroy());
    });
    return server;
}

const HOST_PAGE = `<!doctype html><meta charset="utf-8"><title>gate host</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe id="nb" src="${FRAME}/"></iframe>
<script>
const FRAME = ${JSON.stringify(FRAME)};
const iframe = document.getElementById("nb");
window.__tf = { hellos: [], messages: [], answers: {}, port: null };
let nextId = 1;
window.__tfRequest = (method, params) => new Promise((resolve) => {
  const id = "h" + nextId++;
  window.__tf.answers[id] = resolve;
  window.__tf.port.postMessage({ id, method, params });
});
window.addEventListener("message", (event) => {
  if (event.origin !== FRAME || event.source !== iframe.contentWindow) return;
  const data = event.data || {};
  if (data.type !== "tf-notes:hello") return;
  window.__tf.hellos.push(data);
  if (window.__tf.port) return;
  const channel = new MessageChannel();
  window.__tf.port = channel.port1;
  channel.port1.onmessage = (e) => {
    const m = e.data || {};
    if (!m.method && m.id && window.__tf.answers[m.id]) { window.__tf.answers[m.id](m); delete window.__tf.answers[m.id]; return; }
    window.__tf.messages.push(m);
  };
  iframe.contentWindow.postMessage({ type: "tf-notes:port" }, FRAME, [channel.port2]);
});
</script>`;

try {
    if (!CHROME) throw new Error("CHROME_PATH is not set");
    await engine.start(60_000);
    await engine.newDocument();
    const target = await engine.createNote(PERSON, "Gate target", "<p>opened by the host</p>");

    const fs_ = frameServer();
    await new Promise((r) => fs_.listen(framePort, "127.0.0.1", r));
    servers.push(fs_);
    const hs = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HOST_PAGE));
    await new Promise((r) => hs.listen(hostPort, "127.0.0.1", r));
    servers.push(hs);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--no-first-run", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.setViewport({ width: 1280, height: 860 });
    const t0 = Date.now();
    await page.goto(`${HOST}/`, { waitUntil: "load", timeout: 60_000 });

    const waitIn = async (fn, timeoutMs, ...args) => {
        try {
            return await page.waitForFunction(fn, { timeout: timeoutMs, polling: 100 }, ...args).then((h) => h.jsonValue());
        } catch {
            return null;
        }
    };

    const hello = await waitIn(() => window.__tf.hellos[0] ?? null, 60_000);
    record("the frame says hello to its host (protocol 1, this notebook)", !!hello && hello.protocol === 1 && hello.notebookId === NOTEBOOK, hello ? `${JSON.stringify(hello)} after ${Date.now() - t0} ms` : "no hello within 60 s");

    const ready = await waitIn(() => window.__tf.messages.find((m) => m.method === "ready") ?? null, 30_000);
    record(
        "ready over the port with this build's version and capabilities",
        !!ready && ready.params?.engineVersion === version.version && Array.isArray(ready.params?.capabilities) && ready.params.capabilities.includes("tf-bridge-1"),
        ready ? JSON.stringify(ready.params) : "no ready",
    );

    const init = ready
        ? await page.evaluate(() =>
              window.__tfRequest("init", {
                  user: { id: "alice", name: "Alice Gate" },
                  theme: { mode: "dark", accent: "#3a7bd5", accentSolid: "#3a7bd5", radius: 8, fontSans: "system-ui" },
                  viewport: { width: 1280, height: 860, keyboardInset: 0, safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0, coarse: false },
                  shortcuts: [{ id: "palette", key: "k", meta: true, ctrl: false, shift: false, alt: false }],
                  tabName: "Notes",
                  projectName: "Gate",
                  locale: "en",
                  canCreateTasks: false,
              }),
          )
        : null;
    record("init is answered {}", !!init && init.result && Object.keys(init.result).length === 0 && !init.error, JSON.stringify(init));

    const unknown = ready ? await page.evaluate(() => window.__tfRequest("no.such.method", {})) : null;
    record("an unknown method is answered unsupported", unknown?.error?.code === "unsupported", JSON.stringify(unknown));

    const gone = ready ? await page.evaluate((noteId) => window.__tfRequest("goto", { noteId }), target.noteId) : null;
    const noted = await waitIn((noteId) => window.__tf.messages.find((m) => m.method === "note" && m.params?.noteId === noteId) ?? null, 30_000, target.noteId);
    record("goto opens a note and the frame reports it", !!gone?.result && !!noted && noted.params.title === "Gate target", noted ? JSON.stringify(noted.params) : `goto answered ${JSON.stringify(gone)}`);

    const frameIn = async (fn, timeoutMs, ...args) => {
        const frame = page.frames().find((f) => f.url().startsWith(FRAME));
        if (!frame) return null;
        try {
            return await frame.waitForFunction(fn, { timeout: timeoutMs, polling: 100 }, ...args).then((h) => h.jsonValue());
        } catch {
            return frame.evaluate(() => null).catch(() => null);
        }
    };
    const shown = await frameIn(() => (document.body.innerText.includes("opened by the host") ? true : null), 30_000);
    record("the note's text is on screen in the frame", shown === true, shown ? "" : "the editor did not show the note within 30 s");

    const theme = await frameIn(() => (/dark/.test(document.body.className) ? document.body.className : null), 30_000);
    record("the host's dark mode reached the frame", !!theme, theme ? String(theme).slice(0, 160) : "body has no dark theme class after init");

    record("no uncaught errors in the page", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
    record("client gate", false, err.message);
    if (engine.output.length) console.log(`--- engine output ---\n${engine.tail(40)}`);
} finally {
    await browser?.close().catch(() => {});
    for (const s of servers) await new Promise((r) => s.close(() => r()));
    await engine.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    const failed = checks.filter((c) => !c.ok);
    const result = { ok: failed.length === 0 && checks.length > 0, version: version.version, checks };
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    console.log(`${result.ok ? "CLIENT GATE PASSED" : "CLIENT GATE FAILED"}: ${checks.length - failed.length}/${checks.length} checks`);
    process.exit(result.ok ? 0 : 1);
}
