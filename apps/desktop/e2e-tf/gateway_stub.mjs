/**
 * A stand-in for the Taskforce notes gateway's desktop routes, for the end-to-end run of Taskforce
 * Notes against a stock (non-embedded) engine. It follows `infra/notes/DESKTOP.md` ("Gateway") in
 * the Taskforce repository: pair codes, device keys, `/__tf/desktop/update|redeem|replace|squirrel`,
 * the sync routes passed to the engine only with a live `x-tf-device`, 404 for anything else with
 * one, 403 for any request that carries `Origin`. It logs every request it sees.
 *
 * Test-only. `/__stub/*` (pair, revoke, log, config) is how the run drives it; `config` slows or
 * fails routes so the run can photograph the screens in between.
 */
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import fs from "fs";
import http from "http";
import path from "path";

const SYNC_ROUTES = [
    [ "POST", /^\/api\/login\/sync$/ ],
    [ "GET", /^\/api\/sync\/check$/ ],
    [ "GET", /^\/api\/sync\/changed$/ ],
    [ "PUT", /^\/api\/sync\/update$/ ],
    [ "POST", /^\/api\/sync\/finished$/ ],
    [ "POST", /^\/api\/sync\/check-entity-changes$/ ],
    [ "POST", /^\/api\/sync\/queue-sector\/[a-z_]+\/[0-9a-f]+$/ ]
];
const MAX_PART = 64 * 1024 * 1024;

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {{ url: string; dbPath: string; replaceDb: (file: string) => Promise<void> }} opts.engine
 * @param {string} [opts.buildsDir] folder of `<version>/meta.json` builds for the update feed
 */
export function startGatewayStub({ port, engine, buildsDir }) {
    const origin = `http://127.0.0.1:${port}`;
    const pairs = new Map();
    const devices = new Map();
    const log = [];
    let upload = null;
    const config = { updateDelayMs: 0, replaceDelayMs: 0, syncDelayMs: 0, failSync: false, syncVersionOffset: 0 };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", origin);
        const pathname = url.pathname;
        const entry = {
            at: new Date().toISOString(), method: req.method, path: pathname + url.search,
            device: req.headers["x-tf-device"] ?? null, pairCode: req.headers["x-tf-pair-code"] ?? null,
            origin: req.headers.origin ?? null, status: 0
        };
        const send = (status, body, headers = {}) => {
            entry.status = status;
            if (!pathname.startsWith("/__stub/")) log.push(entry);
            res.writeHead(status, { "content-type": "application/json", ...headers });
            res.end(body === undefined ? "" : JSON.stringify(body));
        };

        try {
            if (pathname.startsWith("/__stub/")) {
                return await stubRoute(req, pathname, send);
            }
            if (req.headers.origin) {
                return send(403, { error: "origin_refused" });
            }
            if (pathname.startsWith("/__tf/desktop/")) {
                return await desktopRoute(req, url, send, entry);
            }
            const token = req.headers["x-tf-device"];
            if (!token) {
                return send(404, { error: "not_found" });
            }
            const device = devices.get(token);
            if (!device || device.revoked) {
                return send(401, { error: "device_revoked" });
            }
            if (!SYNC_ROUTES.some(([ method, pattern ]) => method === req.method && pattern.test(pathname))) {
                return send(404, { error: "not_found" });
            }
            if (config.failSync) {
                await readBody(req);
                return send(500, { message: "stub failure" });
            }
            if (config.syncDelayMs) await sleep(config.syncDelayMs);
            entry.status = "proxied";
            log.push(entry);
            return forward(req, res, entry);
        } catch (e) {
            send(500, { error: "stub_error", message: e instanceof Error ? e.message : String(e) });
        }
    });

    async function stubRoute(req, pathname, send) {
        if (pathname === "/__stub/pair" && req.method === "POST") {
            const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
            const code = base32(20);
            pairs.set(code, { replace: !!body.replace, used: false });
            return send(200, { code, link: `taskforce-notes://connect?server=${encodeURIComponent(origin)}&code=${code}` });
        }
        if (pathname === "/__stub/revoke" && req.method === "POST") {
            for (const device of devices.values()) device.revoked = true;
            return send(200, { ok: true, revoked: devices.size });
        }
        if (pathname === "/__stub/config" && req.method === "POST") {
            Object.assign(config, JSON.parse((await readBody(req)).toString("utf-8") || "{}"));
            return send(200, config);
        }
        if (pathname === "/__stub/log") {
            return send(200, { log, devices: [ ...devices.values() ].map(({ id, name, appVersion, appBuild, revoked }) => ({ id, name, appVersion, appBuild, revoked })) });
        }
        return send(404, { error: "not_found" });
    }

    async function desktopRoute(req, url, send, entry) {
        const route = url.pathname.slice("/__tf/desktop/".length);
        const pairCode = req.headers["x-tf-pair-code"];
        const token = req.headers["x-tf-device"];
        const pair = typeof pairCode === "string" ? pairs.get(pairCode) : undefined;
        const device = typeof token === "string" ? devices.get(token) : undefined;

        if (route === "update" && req.method === "GET") {
            if (!(pair && !pair.used) && !(device && !device.revoked)) {
                return send(401, { error: pair ? "code_used" : "device_revoked" });
            }
            if (config.updateDelayMs) await sleep(config.updateDelayMs);
            const syncVersion = await engineSyncVersion();
            return send(200, {
                engine: { version: "stub", syncVersion: syncVersion + config.syncVersionOffset }, app: newestBuild(syncVersion + config.syncVersionOffset, 0), replace: !!pair?.replace && !pair.used,
                ...(pair ? { notebookName: "Example notebook", userName: "Example Person" } : {})
            });
        }
        if (route === "redeem" && req.method === "POST") {
            const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
            const redeemPair = pairs.get(body.code);
            if (!redeemPair || redeemPair.used) {
                return send(401, { error: "code_refused" });
            }
            redeemPair.used = true;
            const deviceToken = `tfd_${randomBytes(24).toString("hex")}`;
            const deviceId = `dev_${randomBytes(4).toString("hex")}`;
            devices.set(deviceToken, { id: deviceId, name: body.deviceName, appVersion: body.appVersion, appBuild: body.appBuild, revoked: false });
            const db = new Database(engine.dbPath, { readonly: true, fileMustExist: true });
            const seed = db.prepare("SELECT name, value, isSynced FROM options WHERE name IN ('documentId', 'documentSecret')").all()
                .map((row) => ({ ...row, isSynced: !!row.isSynced }));
            db.close();
            return send(200, {
                deviceId, deviceToken, notebookId: "nb_example", notebookName: "Example notebook", userName: "Example Person",
                syncServerHost: origin, seed, syncVersion: await engineSyncVersion()
            });
        }
        if (route === "replace" && req.method === "POST") {
            if (!pair || pair.used || !pair.replace) {
                return send(401, { error: "replace_not_allowed" });
            }
            const part = Number(url.searchParams.get("part"));
            const parts = Number(url.searchParams.get("parts"));
            const bytes = await readBody(req);
            entry.bytes = bytes.length;
            if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 1 || part > parts || bytes.length > MAX_PART
                || (part === 1 ? false : upload?.next !== part) || req.headers["content-type"] !== "application/octet-stream") {
                upload = null;
                return send(400, { error: "bad_part", message: "Start again from part 1." });
            }
            if (part === 1) {
                upload = { file: path.join(path.dirname(engine.dbPath), `upload-${Date.now()}.db`), next: 1 };
                fs.writeFileSync(upload.file, "");
            }
            fs.appendFileSync(upload.file, bytes);
            upload.next = part + 1;
            if (part < parts) {
                return send(200, { ok: true, received: part });
            }
            const file = upload.file;
            upload = null;
            if (config.replaceDelayMs) await sleep(config.replaceDelayMs);
            const check = new Database(file, { readonly: true, fileMustExist: true });
            const notes = check.prepare("SELECT COUNT(*) AS n FROM notes WHERE isDeleted = 0").get().n;
            check.close();
            await engine.replaceDb(file);
            return send(200, { ok: true, notes });
        }
        if (route === "squirrel" && req.method === "GET") {
            if (!device || device.revoked) {
                return send(401, { error: "device_revoked" });
            }
            const build = newestBuild(await engineSyncVersion(), Number(url.searchParams.get("build")) || 0);
            if (!build) {
                return send(204);
            }
            return send(200, { url: build.zipUrl, name: build.version, notes: "", pub_date: build.builtAt });
        }
        return send(404, { error: "not_found" });
    }

    async function engineSyncVersion() {
        const response = await fetch(`${engine.url}/api/setup/status`);
        return (await response.json()).syncVersion;
    }

    /** The newest build in `buildsDir` with the engine's sync version and a build number above `above`. */
    function newestBuild(syncVersion, above) {
        if (!buildsDir || !fs.existsSync(buildsDir)) return null;
        let best = null;
        for (const version of fs.readdirSync(buildsDir)) {
            const metaPath = path.join(buildsDir, version, "meta.json");
            if (!fs.existsSync(metaPath)) continue;
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            if (meta.syncVersion !== syncVersion || meta.build <= above || (best && best.build >= meta.build)) continue;
            best = {
                version: meta.version, build: meta.build, syncVersion: meta.syncVersion, dbVersion: meta.dbVersion, builtAt: meta.builtAt,
                url: `${origin}/__tf/desktop/download/${meta.version}/${meta.files.dmg}`, sha256: meta.sha256.dmg, size: meta.size.dmg,
                zipUrl: `${origin}/__tf/desktop/download/${meta.version}/${meta.files.zip}`
            };
        }
        return best;
    }

    function forward(req, res, entry) {
        const target = new URL(req.url ?? "/", engine.url);
        const headers = { ...req.headers, host: target.host };
        delete headers["x-tf-device"];
        delete headers["x-tf-pair-code"];
        const upstream = http.request(target, { method: req.method, headers }, (response) => {
            entry.status = response.statusCode;
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
        });
        upstream.on("error", (e) => {
            entry.status = 502;
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ message: `Bad Gateway: ${e.message}` }));
        });
        req.pipe(upstream);
    }

    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve({
            origin,
            log,
            close: () => new Promise((done) => server.close(() => done()))
        }));
    });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function base32(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of randomBytes(bytes)) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    return out.slice(0, 32);
}

export const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
