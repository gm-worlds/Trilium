#!/usr/bin/env node
/**
 * Development host for the NoteForce embed mode: one engine from the local build, a gateway
 * stand-in in front of it and a host page that frames it and speaks the host side of the bridge
 * (Taskforce `infra/notes/README.md`, "Bridge").
 *
 *   node scripts/tf-dev-host.mjs [--engine-port 9781] [--frame-port 9782] [--host-port 9783]
 *                                [--data ~/apps/office-forks/trilium-dev-data/n4-host] [--fresh]
 *
 * Then open http://127.0.0.1:<host-port>/?as=alice&layout=phone (layout: phone | tablet | desktop,
 * mode: light | dark, chrome=0 hides the dev strip). Users: alice and bob (edit), vera (view).
 *
 * - The engine runs `apps/server/dist/main.mjs` with the env the gateway sets (`TF_EMBED=1`, its own
 *   data dir, a random gateway key). A new data dir gets the demo document.
 * - The frame port adds `x-tf-gateway-key`, `x-tf-user-id`, `x-tf-user-name` and `x-tf-role` to
 *   every HTTP request and WebSocket upgrade; the user comes from `?as=` (kept in a cookie).
 *   `X-Frame-Options`, `Cross-Origin-Opener-Policy` and a `frame-ancestors` CSP are removed.
 *   `/__tf/api/*` and, as in the gateway, `/api/script/*` other than the widget and startup lists
 *   answer 404 JSON, `/__tf/rt` accepts sockets and only answers `ping`,
 *   `/__tf/refresh` answers 200, `/__tf/events` takes the engine's change events.
 * - The host page logs every bridge message on the page and in `window.__tfLog`, and exposes
 *   `window.__tfHost` (`setMode()`, `setKeyboard(px, "shrink" | "overlay")`, `sendViewport()`,
 *   `request(method, params)`) for scripted checks.
 *
 * A development tool only: it binds 127.0.0.1 and trusts whoever reaches it.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "apps/server/package.json"));
const { WebSocketServer } = require("ws");

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
};
const ENGINE_PORT = Number(arg("engine-port", "9781"));
const FRAME_PORT = Number(arg("frame-port", "9782"));
const HOST_PORT = Number(arg("host-port", "9783"));
const DATA_DIR = path.resolve(arg("data", path.join(os.homedir(), "apps/office-forks/trilium-dev-data/n4-host")).replace(/^~/, os.homedir()));
const FRESH = process.argv.includes("--fresh");

const FRAME_ORIGIN = `http://127.0.0.1:${FRAME_PORT}`;
const HOST_ORIGIN = `http://127.0.0.1:${HOST_PORT}`;
const GATEWAY_KEY = randomBytes(24).toString("hex");
const NOTEBOOK_ID = "devn4devn4devn4devn4";

const USERS = {
    alice: { id: "alice", name: "Alice Martin", role: "edit" },
    bob: { id: "bob", name: "Bob Okafor", role: "edit" },
    vera: { id: "vera", name: "Vera Lind", role: "view" }
};

const events = [];

if (FRESH) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const engine = startEngine();
await waitForEngine();
await ensureDocument();

const frameServer = http.createServer(handleFrameRequest);
const rtServer = new WebSocketServer({ noServer: true });
rtServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
        try {
            const frame = JSON.parse(String(raw));
            if (frame.event === "ping") {
                socket.send(JSON.stringify({ event: "pong", data: {} }));
            }
        } catch {
            // Not JSON: ignored, as the gateway does.
        }
    });
});
frameServer.on("upgrade", handleFrameUpgrade);
frameServer.listen(FRAME_PORT, "127.0.0.1");

const hostServer = http.createServer(handleHostRequest);
hostServer.listen(HOST_PORT, "127.0.0.1");

console.log(`engine  http://127.0.0.1:${ENGINE_PORT}  (data ${DATA_DIR})`);
console.log(`frame   ${FRAME_ORIGIN}`);
console.log(`host    ${HOST_ORIGIN}/?as=alice&layout=phone`);

for (const signal of [ "SIGINT", "SIGTERM" ]) {
    process.on(signal, () => {
        engine.kill("SIGTERM");
        process.exit(0);
    });
}

function startEngine() {
    const main = path.join(repoRoot, "apps/server/dist/main.mjs");
    if (!fs.existsSync(main)) {
        console.error(`No build at ${main}; run pnpm server:build first.`);
        process.exit(1);
    }
    const child = spawn(process.execPath, [ main ], {
        cwd: path.dirname(main),
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TZ: process.env.TZ ?? "Europe/Brussels",
            LANG: process.env.LANG ?? "en_US.UTF-8",
            TRILIUM_DATA_DIR: DATA_DIR,
            TRILIUM_PORT: String(ENGINE_PORT),
            TRILIUM_NETWORK_HOST: "127.0.0.1",
            TRILIUM_GENERAL_NOAUTHENTICATION: "true",
            TRILIUM_GENERAL_NOBACKUP: "true",
            TRILIUM_NETWORK_TRUSTEDREVERSEPROXY: "loopback",
            TF_SCRIPTS: process.env.TF_SCRIPTS === "on" ? "on" : "off",
            TF_EMBED: "1",
            TF_GATEWAY_KEY: GATEWAY_KEY,
            TF_NOTEBOOK_ID: NOTEBOOK_ID,
            TF_PARENT_ORIGINS: HOST_ORIGIN,
            TF_EVENTS_URL: `${FRAME_ORIGIN}/__tf/events`
        },
        stdio: [ "ignore", "pipe", "pipe" ]
    });
    const log = fs.createWriteStream(path.join(DATA_DIR, "engine-stdout.log"), { flags: "a" });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on("exit", (code) => {
        console.error(`engine exited (${code})`);
        process.exit(1);
    });
    return child;
}

async function waitForEngine() {
    for (let i = 0; i < 120; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/api/health-check`);
            if (res.status < 500) {
                return;
            }
        } catch {
            // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("engine did not start");
}

async function engineCall(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}${url}`, {
        method,
        headers: {
            "content-type": "application/json",
            ...identityHeaders(USERS.alice)
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function ensureDocument() {
    const status = await engineCall("GET", "/api/setup/status");
    if (status?.isInitialized) {
        return;
    }
    console.log("creating the demo document…");
    await engineCall("POST", "/api/setup/new-document", { locale: "en" });
    for (let i = 0; i < 240; i++) {
        const next = await engineCall("GET", "/api/setup/status");
        if (next?.isInitialized) {
            return;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("document was not created");
}

function identityHeaders(user) {
    return {
        "x-tf-gateway-key": GATEWAY_KEY,
        "x-tf-user-id": user.id,
        "x-tf-user-name": encodeURIComponent(user.name),
        "x-tf-role": user.role
    };
}

function parseCookies(header = "") {
    const out = {};
    for (const part of header.split(";")) {
        const [ k, ...v ] = part.trim().split("=");
        if (k) {
            out[k] = v.join("=");
        }
    }
    return out;
}

function userFor(req, url) {
    const asParam = url.searchParams.get("as");
    if (asParam && USERS[asParam]) {
        return USERS[asParam];
    }
    const cookie = parseCookies(req.headers.cookie).tfdev_as;
    return USERS[cookie] ?? USERS.alice;
}

function sendJson(res, status, body, extraHeaders = {}) {
    res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
    res.end(JSON.stringify(body));
}

function handleFrameRequest(req, res) {
    const url = new URL(req.url, FRAME_ORIGIN);
    const user = userFor(req, url);

    if (url.pathname === "/__tf/enter") {
        const layout = url.searchParams.get("layout") ?? "phone";
        const device = layout === "desktop" ? "desktop" : "mobile";
        const next = url.searchParams.get("next") ?? "/";
        res.writeHead(303, {
            location: next.startsWith("/") && !next.startsWith("//") ? next : "/",
            "set-cookie": [ `tfdev_as=${user.id}; Path=/; SameSite=Lax`, `trilium-device=${device}; Path=/; SameSite=Lax` ]
        });
        res.end();
        return;
    }
    if (url.pathname === "/__tf/events") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                events.push(...(JSON.parse(body).events ?? []));
            } catch {
                // Kept out of the list.
            }
            sendJson(res, 202, { ok: true });
        });
        return;
    }
    if (url.pathname === "/__tf/dev/events") {
        sendJson(res, 200, { events });
        return;
    }
    if (url.pathname === "/__tf/refresh") {
        sendJson(res, 200, { expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(), role: user.role });
        return;
    }
    if (url.pathname.startsWith("/__tf/api/")) {
        sendJson(res, 404, { error: "not_found", message: "The dev host has no Taskforce API." });
        return;
    }
    // Like the gateway: of the script routes only the two lists pass.
    if (url.pathname.startsWith("/api/script/") && ![ "/api/script/widgets", "/api/script/startup" ].includes(url.pathname)) {
        sendJson(res, 404, { error: "not_found" });
        return;
    }

    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
        if (name.startsWith("x-tf-")) {
            delete headers[name];
        }
    }
    Object.assign(headers, identityHeaders(user), { host: `127.0.0.1:${ENGINE_PORT}`, "x-forwarded-for": "127.0.0.1" });

    const upstream = http.request({ host: "127.0.0.1", port: ENGINE_PORT, method: req.method, path: req.url, headers }, (engineRes) => {
        const out = { ...engineRes.headers };
        delete out["x-frame-options"];
        delete out["cross-origin-opener-policy"];
        const csp = out["content-security-policy"];
        if (typeof csp === "string") {
            out["content-security-policy"] = csp.split(";").filter((p) => !p.trim().startsWith("frame-ancestors")).join(";");
        }
        out["content-security-policy"] = [ out["content-security-policy"], `frame-ancestors ${HOST_ORIGIN}` ].filter(Boolean).join("; ");
        if (url.searchParams.get("as") && USERS[url.searchParams.get("as")]) {
            const cookies = [].concat(out["set-cookie"] ?? []);
            cookies.push(`tfdev_as=${user.id}; Path=/; SameSite=Lax`);
            out["set-cookie"] = cookies;
        }
        res.writeHead(engineRes.statusCode ?? 502, out);
        engineRes.pipe(res);
    });
    upstream.on("error", (e) => {
        if (!res.headersSent) {
            sendJson(res, 502, { error: "engine", message: e.message });
        } else {
            res.destroy();
        }
    });
    req.pipe(upstream);
}

function handleFrameUpgrade(req, socket, head) {
    const url = new URL(req.url, FRAME_ORIGIN);
    if (url.pathname === "/__tf/rt") {
        rtServer.handleUpgrade(req, socket, head, (ws) => rtServer.emit("connection", ws, req));
        return;
    }

    const user = userFor(req, url);
    const engineSocket = net.connect(ENGINE_PORT, "127.0.0.1", () => {
        const lines = [ `${req.method} ${req.url} HTTP/1.1` ];
        const headers = { ...req.headers };
        for (const name of Object.keys(headers)) {
            if (name.startsWith("x-tf-")) {
                delete headers[name];
            }
        }
        Object.assign(headers, identityHeaders(user), { host: `127.0.0.1:${ENGINE_PORT}` });
        for (const [ name, value ] of Object.entries(headers)) {
            for (const v of [].concat(value)) {
                lines.push(`${name}: ${v}`);
            }
        }
        engineSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head?.length) {
            engineSocket.write(head);
        }
        engineSocket.pipe(socket);
        socket.pipe(engineSocket);
    });
    const close = () => {
        engineSocket.destroy();
        socket.destroy();
    };
    engineSocket.on("error", close);
    socket.on("error", close);
}

function handleHostRequest(req, res) {
    const url = new URL(req.url, HOST_ORIGIN);
    if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(hostPage());
}

function hostPage() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-visual">
<title>NoteForce dev host</title>
<style>
  html, body { margin: 0; height: 100%; font: 13px system-ui, sans-serif; overscroll-behavior: none; }
  body { display: flex; flex-direction: column; background: Canvas; color: CanvasText; }
  #strip { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-bottom: 1px solid #8884; }
  #strip button { font: inherit; padding: 4px 8px; }
  #strip.hidden { display: none; }
  #wrap { position: relative; flex: 1; min-height: 0; }
  #frame { position: absolute; inset: 0 0 auto 0; width: 100%; height: 100%; border: 0; display: block; }
  #kb { position: absolute; left: 0; right: 0; bottom: 0; height: 0; background: #8889; display: none;
        align-items: center; justify-content: center; color: #fff; pointer-events: none; }
  #log { position: fixed; right: 0; bottom: 0; width: min(420px, 100vw); max-height: 40vh; overflow: auto; margin: 0;
         background: Canvas; border: 1px solid #8886; font: 11px ui-monospace, monospace; list-style: none; padding: 4px; display: none; }
  #log.open { display: block; }
</style>
</head>
<body>
<div id="strip">
  <button data-act="mode">light / dark</button>
  <button data-act="kb-shrink">keyboard (shrink)</button>
  <button data-act="kb-overlay">keyboard (overlay)</button>
  <button data-act="kb-off">no keyboard</button>
  <button data-act="layout" data-layout="phone">phone</button>
  <button data-act="layout" data-layout="tablet">tablet</button>
  <button data-act="layout" data-layout="desktop">desktop</button>
  <button data-act="log">log</button>
  <span id="who"></span>
</div>
<div id="wrap"><iframe id="frame" allow="clipboard-read; clipboard-write; fullscreen"></iframe><div id="kb">keyboard</div></div>
<ul id="log"></ul>
<script>
(() => {
  const FRAME_ORIGIN = ${JSON.stringify(FRAME_ORIGIN)};
  const USERS = ${JSON.stringify(USERS)};
  const params = new URLSearchParams(location.search);
  const as = USERS[params.get("as")] ? params.get("as") : "alice";
  const layout = params.get("layout") ?? "phone";
  let mode = params.get("mode") === "dark" ? "dark" : "light";
  if (params.get("chrome") === "0") document.getElementById("strip").classList.add("hidden");
  document.getElementById("who").textContent = USERS[as].name + " · " + layout + " · " + mode;

  const frame = document.getElementById("frame");
  const kbEl = document.getElementById("kb");
  const logEl = document.getElementById("log");
  const log = window.__tfLog = [];
  let port = null;
  let nextId = 1;
  const pending = new Map();
  const keyboard = { px: 0, how: "shrink" };

  function record(dir, message) {
    const entry = { at: Date.now(), dir, method: message.method ?? null, id: message.id ?? null, params: message.params, result: message.result, error: message.error };
    log.push(entry);
    const li = document.createElement("li");
    li.textContent = dir + " " + (message.method ?? ("answer " + message.id)) + " " + JSON.stringify(message.params ?? message.result ?? message.error ?? {}).slice(0, 160);
    logEl.prepend(li);
  }

  function theme() {
    // What Taskforce sends: its --primary and --primary-solid per mode and its body font stack.
    return mode === "dark"
        ? { mode, accent: "hsl(205 100% 72%)", accentSolid: "hsl(205 100% 72%)", radius: 6, fontSans: '"Source Sans 3", "Source Sans 3 Fallback", system-ui, sans-serif' }
        : { mode, accent: "hsl(205 100% 65%)", accentSolid: "hsl(224 73% 12%)", radius: 6, fontSans: '"Source Sans 3", "Source Sans 3 Fallback", system-ui, sans-serif' };
  }

  function viewport() {
    const rect = frame.getBoundingClientRect();
    return {
      width: Math.round(rect.width), height: Math.round(rect.height),
      keyboardInset: keyboard.how === "overlay" ? keyboard.px : 0,
      safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0,
      coarse: matchMedia("(pointer: coarse)").matches
    };
  }

  function send(message) {
    if (!port) return;
    record("host→frame", message);
    port.postMessage(message);
  }

  function request(method, params = {}) {
    const id = "h" + nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }

  function applyKeyboard() {
    frame.style.height = keyboard.how === "shrink" && keyboard.px ? "calc(100% - " + keyboard.px + "px)" : "100%";
    kbEl.style.display = keyboard.px ? "flex" : "none";
    kbEl.style.height = keyboard.px + "px";
    requestAnimationFrame(() => send({ method: "viewport", params: viewport() }));
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== FRAME_ORIGIN || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== "tf-notes:hello" || port) return;
    record("frame→host", { method: "tf-notes:hello", params: data });
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (e) => onFrameMessage(e.data);
    port.start();
    frame.contentWindow.postMessage({ type: "tf-notes:port" }, FRAME_ORIGIN, [ channel.port2 ]);
  });

  function onFrameMessage(message) {
    record("frame→host", message);
    if (!message.method && message.id && pending.has(message.id)) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      message.error ? p.reject(message.error) : p.resolve(message.result);
      return;
    }
    if (message.method === "ready") {
      request("init", {
        user: { id: USERS[as].id, name: USERS[as].name },
        theme: theme(), viewport: viewport(),
        shortcuts: [ { key: "k", meta: true }, { key: "k", ctrl: true } ],
        tabName: "Notes", projectName: "Dev project", locale: "en", canCreateTasks: false
      }).catch(() => {});
    } else if (message.id) {
      send({ id: message.id, error: { code: "unsupported", message: "dev host" } });
    }
  }

  frame.addEventListener("load", () => { port = null; });

  let vvTimer = 0;
  const onResize = () => { cancelAnimationFrame(vvTimer); vvTimer = requestAnimationFrame(() => send({ method: "viewport", params: viewport() })); };
  window.visualViewport?.addEventListener("resize", onResize);
  window.addEventListener("resize", onResize);

  document.getElementById("strip").addEventListener("click", (e) => {
    const act = e.target.dataset?.act;
    if (act === "mode") window.__tfHost.setMode(mode === "dark" ? "light" : "dark");
    if (act === "kb-shrink") window.__tfHost.setKeyboard(300, "shrink");
    if (act === "kb-overlay") window.__tfHost.setKeyboard(300, "overlay");
    if (act === "kb-off") window.__tfHost.setKeyboard(0);
    if (act === "log") logEl.classList.toggle("open");
    if (act === "layout") {
      params.set("layout", e.target.dataset.layout);
      location.search = params.toString();
    }
  });

  window.__tfHost = {
    get connected() { return !!port; },
    setMode(next) { mode = next; send({ method: "theme", params: theme() }); document.getElementById("who").textContent = USERS[as].name + " · " + layout + " · " + mode; },
    setKeyboard(px, how = "shrink") { keyboard.px = px; keyboard.how = how; applyKeyboard(); },
    sendViewport(extra = {}) { send({ method: "viewport", params: { ...viewport(), ...extra } }); },
    request, send
  };

  frame.src = FRAME_ORIGIN + "/__tf/enter?as=" + as + "&layout=" + layout + "&next=" + encodeURIComponent(params.get("next") ?? "/");
})();
</script>
</body>
</html>`;
}
