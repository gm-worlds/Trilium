// Starting an engine build the way the Taskforce notes gateway does, and talking to it.
//
// The gateway (Taskforce `apps/notes-gateway/src/supervisor.ts`) spawns `node <build>/main.mjs`
// with an environment built from nothing; the list below is the contract's "Engine env". Every
// request carries the per-process gateway key and the person's identity headers.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** The environment the gateway gives an engine (contract "Engine env"). */
export function engineEnv({ dataDir, port, key, notebookId, parentOrigins = [], eventsUrl = "", allowScripts = false }) {
    const env = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? dataDir,
        NODE_ENV: "production",
        TRILIUM_DATA_DIR: dataDir,
        TRILIUM_PORT: String(port),
        TRILIUM_NETWORK_HOST: "127.0.0.1",
        TRILIUM_GENERAL_NOAUTHENTICATION: "true",
        TRILIUM_GENERAL_NOBACKUP: "true",
        TRILIUM_NETWORK_TRUSTEDREVERSEPROXY: "loopback",
        TF_EMBED: "1",
        TF_GATEWAY_KEY: key,
        TF_NOTEBOOK_ID: notebookId,
        TF_PARENT_ORIGINS: parentOrigins.join(","),
        TF_EVENTS_URL: eventsUrl,
    };
    if (process.env.TZ) env.TZ = process.env.TZ;
    if (process.env.LANG) env.LANG = process.env.LANG;
    if (!allowScripts) env.TRILIUM_SAFE_MODE = "1";
    return env;
}

/** Resident memory of a process in MB: /proc on Linux, ps elsewhere. */
export function rssMb(pid) {
    try {
        if (process.platform === "linux") {
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]);
            return Math.round(kb / 1024);
        }
    } catch {
        return null;
    }
    return null;
}

export async function rssMbAsync(pid) {
    const direct = rssMb(pid);
    if (direct !== null) return direct;
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
        execFile("ps", ["-o", "rss=", "-p", String(pid)], (err, out) => resolve(err ? null : Math.round(Number(out.trim()) / 1024)));
    });
}

/**
 * One engine process on `dataDir`. `start()` resolves when `/api/health-check` answers 200 and
 * reports how long that took. Output goes to `<dataDir>/engine-gate.log`.
 */
export class Engine {
    constructor({ build, dataDir, notebookId = "gategategategategate", parentOrigins = [], eventsUrl = "", nodeBin = process.execPath }) {
        this.build = build;
        this.dataDir = dataDir;
        this.notebookId = notebookId;
        this.parentOrigins = parentOrigins;
        this.eventsUrl = eventsUrl;
        this.nodeBin = nodeBin;
        this.key = randomBytes(24).toString("base64url");
        this.port = 0;
        this.proc = null;
        this.output = [];
        this.cookies = "";
        this.csrf = "";
    }

    get url() {
        return `http://127.0.0.1:${this.port}`;
    }

    async start(timeoutMs = 60_000) {
        await mkdir(this.dataDir, { recursive: true });
        this.port = await freePort();
        const t0 = Date.now();
        this.proc = spawn(this.nodeBin, [path.join(this.build, "main.mjs")], {
            cwd: this.build,
            env: engineEnv({
                dataDir: this.dataDir,
                port: this.port,
                key: this.key,
                notebookId: this.notebookId,
                parentOrigins: this.parentOrigins,
                eventsUrl: this.eventsUrl,
            }),
            stdio: ["ignore", "pipe", "pipe"],
        });
        const keep = (c) => {
            this.output.push(String(c));
            if (this.output.length > 400) this.output.shift();
        };
        this.proc.stdout.on("data", keep);
        this.proc.stderr.on("data", keep);
        this.exited = new Promise((resolve) => this.proc.once("exit", (code, signal) => resolve({ code, signal })));
        let gone = null;
        void this.exited.then((r) => (gone = r));
        const deadline = t0 + timeoutMs;
        while (Date.now() < deadline) {
            if (gone) throw new Error(`engine exited during start (${gone.code ?? gone.signal}): ${this.tail()}`);
            try {
                const res = await fetch(`${this.url}/api/health-check`, { headers: { "x-tf-gateway-key": this.key }, signal: AbortSignal.timeout(1000) });
                await res.arrayBuffer();
                if (res.ok) return Date.now() - t0;
            } catch {
                // not listening yet
            }
            await sleep(50);
        }
        throw new Error(`engine did not answer its health check within ${timeoutMs} ms: ${this.tail()}`);
    }

    tail(lines = 15) {
        return this.output.join("").split("\n").slice(-lines).join("\n");
    }

    async stop() {
        if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null) return;
        this.proc.kill("SIGTERM");
        const r = await Promise.race([this.exited, sleep(10_000).then(() => null)]);
        if (!r) {
            this.proc.kill("SIGKILL");
            await this.exited;
        }
    }

    /** A request as `who` ({ id, name, role }) or as nobody. Never throws on a status. */
    async request(method, p, { who = null, body, headers = {}, key = this.key, csrf = true } = {}) {
        const h = new Headers(headers);
        if (key !== null) h.set("x-tf-gateway-key", key);
        if (who) {
            h.set("x-tf-user-id", who.id);
            h.set("x-tf-user-name", encodeURIComponent(who.name));
            h.set("x-tf-role", who.role);
        }
        if (method !== "GET" && method !== "HEAD" && csrf) {
            if (!this.csrf) await this.refreshCsrf();
            h.set("x-csrf-token", this.csrf);
            if (this.cookies) h.set("cookie", this.cookies);
        }
        let payload;
        if (body !== undefined) {
            h.set("content-type", "application/json");
            payload = JSON.stringify(body);
        }
        const res = await fetch(`${this.url}${p}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(60_000) });
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            // not JSON
        }
        return { status: res.status, json, text, headers: res.headers };
    }

    /** Trilium's double-submit CSRF token, as the gateway takes it for its own calls. */
    async refreshCsrf() {
        const res = await fetch(`${this.url}/bootstrap`, { headers: { "x-tf-gateway-key": this.key }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`/bootstrap answered ${res.status}`);
        this.cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
        this.csrf = (await res.json()).csrfToken ?? "";
        if (!this.csrf) throw new Error("/bootstrap gave no CSRF token");
    }

    /** First start of an empty folder: an empty document without the demo notes (as the gateway). */
    async newDocument() {
        const status = await this.request("GET", "/api/setup/status");
        if (status.json?.isInitialized) return false;
        const res = await this.request("POST", "/api/setup/new-document?skipDemoDb", { body: { locale: "en" }, csrf: false });
        if (res.status >= 300) throw new Error(`new-document answered ${res.status}: ${res.text.slice(0, 200)}`);
        const deadline = Date.now() + 60_000;
        for (;;) {
            const s = await this.request("GET", "/api/setup/status");
            if (s.json?.isInitialized) return true;
            if (Date.now() > deadline) throw new Error("the document did not initialise within 60 s");
            await sleep(100);
        }
    }

    async createNote(who, title, content) {
        const res = await this.request("POST", "/api/notes/root/children?target=into", { who, body: { title, type: "text", content } });
        if (res.status !== 200) throw new Error(`creating a note answered ${res.status}: ${res.text.slice(0, 200)}`);
        return { noteId: res.json.note.noteId, blobId: res.json.note.blobId, branchId: res.json.branch.branchId };
    }

    /**
     * Save with the save guard's base blob. The header was `x-tf-base-blob` first and is
     * `tf-base-blob` now (the gateway strips every incoming `x-tf-*`); both are sent so the check
     * holds for builds on either side of that change.
     */
    saveNote(who, noteId, content, baseBlob) {
        return this.request("PUT", `/api/notes/${noteId}/data`, {
            who,
            body: { content },
            headers: baseBlob ? { "tf-base-blob": baseBlob, "x-tf-base-blob": baseBlob } : {},
        });
    }
}

/** Collects the engine's event batches the way the gateway's `/internal/engine-events/:id` does. */
export async function eventReceiver() {
    const { createServer: createHttp } = await import("node:http");
    const batches = [];
    const server = createHttp((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            try {
                batches.push({ key: String(req.headers["x-tf-gateway-key"] ?? ""), path: req.url, events: JSON.parse(Buffer.concat(chunks).toString("utf8")).events ?? [] });
            } catch {
                batches.push({ key: "", path: req.url, events: [], bad: true });
            }
            res.writeHead(202, { "content-type": "application/json" }).end('{"accepted":1}');
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return {
        batches,
        url: (id) => `http://127.0.0.1:${server.address().port}/internal/engine-events/${id}`,
        close: () => new Promise((r) => server.close(() => r())),
    };
}
