#!/usr/bin/env node
// Gate for one NoteForce engine build: start it exactly as the Taskforce notes gateway does and
// check the contract the gateway and Taskforce rely on.
//
//   node gate/smoke.mjs --engine <unpacked build> [--prev <previous released build>]
//                       [--platform linux-x64] [--json <result file>]
//
// One line per check; exit code 1 when any check fails. `--prev`: a database made by that build
// must open in this one (upstream migrations are one-way, so this is the check that matters when
// the upstream version moves).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Engine, eventReceiver, rssMbAsync, sleep } from "./engine.mjs";

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
};
const BUILD = path.resolve(arg("engine", ""));
const PREV = arg("prev", "") ? path.resolve(arg("prev")) : null;
const PLATFORM = arg("platform", `${process.platform}-${process.arch}`);
const JSON_OUT = arg("json", "");
const START_LIMIT_MS = Number(arg("start-limit-ms", "10000"));
const RSS_LIMIT_MB = Number(arg("rss-limit-mb", "400"));

const ALICE = { id: "alice", name: "Alice Gate", role: "edit" };
const BOB = { id: "bob", name: "Bob Gate", role: "edit" };
const VERA = { id: "vera", name: "Vera Gate", role: "view" };

const checks = [];
async function check(name, fn) {
    const t0 = Date.now();
    try {
        const detail = await fn();
        checks.push({ name, ok: true, ms: Date.now() - t0, ...(detail ? { detail: String(detail) } : {}) });
        console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
        return true;
    } catch (err) {
        checks.push({ name, ok: false, ms: Date.now() - t0, detail: err.message });
        console.log(`FAIL  ${name}  (${err.message.split("\n").join(" | ").slice(0, 600)})`);
        return false;
    }
}
function expect(cond, message) {
    if (!cond) throw new Error(message);
}

const temps = [];
async function temp(prefix) {
    const d = await mkdtemp(path.join(os.tmpdir(), prefix));
    temps.push(d);
    return d;
}

let version = null;
const engines = [];
try {
    await check("build has main.mjs, tf-version.json and the platform's SQLite binding", () => {
        expect(existsSync(path.join(BUILD, "main.mjs")), `no main.mjs in ${BUILD}`);
        const file = path.join(BUILD, "tf-version.json");
        expect(existsSync(file), "no tf-version.json");
        version = JSON.parse(readFileSync(file, "utf8"));
        for (const k of ["version", "upstream", "commit", "builtAt"]) expect(typeof version[k] === "string" && version[k], `tf-version.json has no ${k}`);
        for (const k of ["dbVersion", "syncVersion"]) expect(Number.isInteger(version[k]), `tf-version.json has no integer ${k}`);
        expect(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\+tf\.[\w.]+$/.test(version.version), `version ${version.version} is not <upstream>+tf.<n>`);
        expect(version.version.startsWith(`${version.upstream}+`), "version and upstream disagree");
        const binding = path.join(BUILD, "node_modules/better-sqlite3/prebuilds", `${PLATFORM}.node`);
        expect(existsSync(binding), `missing ${path.relative(BUILD, binding)}`);
        return `${version.version}, db ${version.dbVersion}, sync ${version.syncVersion}, ${PLATFORM}`;
    });
    if (!version) throw new Error("not a build; nothing else to check");

    const receiver = await eventReceiver();
    const notebookId = "gatesmokegatesmoke23";
    const engine = new Engine({ build: BUILD, dataDir: await temp("tf-gate-new-"), notebookId, eventsUrl: receiver.url(notebookId), parentOrigins: ["http://127.0.0.1:9"] });
    engines.push(engine);

    let startMs = null;
    await check(`starts and answers its health check within ${START_LIMIT_MS / 1000} s`, async () => {
        startMs = await engine.start(60_000);
        expect(startMs < START_LIMIT_MS, `took ${startMs} ms`);
        return `${startMs} ms`;
    });
    if (startMs === null) throw new Error("the engine did not start");

    await check("refuses requests without the gateway key (403), health check open on loopback", async () => {
        const none = await engine.request("GET", "/api/tf/bootstrap", { key: null });
        expect(none.status === 403, `no key: ${none.status}`);
        const wrong = await engine.request("GET", "/api/tf/bootstrap", { key: "wrong" });
        expect(wrong.status === 403, `wrong key: ${wrong.status}`);
        const page = await engine.request("GET", "/", { key: null });
        expect(page.status === 403, `page without key: ${page.status}`);
        const health = await engine.request("GET", "/api/health-check", { key: null });
        expect(health.status === 200, `health check without key: ${health.status}`);
    });

    await check("makes a new empty document, as the gateway does on first start", async () => {
        const made = await engine.newDocument();
        expect(made, "the folder already had a document");
        const tree = await engine.request("GET", "/api/tree", { who: ALICE });
        expect(tree.status === 200, `tree: ${tree.status}`);
        const own = tree.json.branches.filter((b) => b.parentNoteId === "root" && !b.noteId.startsWith("_"));
        expect(own.length === 0, `${own.length} demo notes under root`);
    });

    await check("bootstrap names the person, the notebook and this build", async () => {
        const res = await engine.request("GET", "/api/tf/bootstrap", { who: ALICE });
        expect(res.status === 200, `bootstrap: ${res.status}`);
        const b = res.json;
        expect(b.embed === true, "embed is not true");
        expect(b.notebookId === notebookId, `notebookId ${b.notebookId}`);
        expect(b.user?.id === ALICE.id && b.user?.name === ALICE.name && b.user?.role === "edit", `user ${JSON.stringify(b.user)}`);
        expect(b.engineVersion === version.version, `engineVersion ${b.engineVersion}, tf-version.json says ${version.version}`);
        expect(b.upstreamVersion === version.upstream, `upstreamVersion ${b.upstreamVersion}`);
        expect(/^https:\/\/github\.com\/gm-worlds\/trilium$/i.test(b.sourceUrl), `sourceUrl ${b.sourceUrl}`);
        const info = await engine.request("GET", "/api/app-info", { who: ALICE });
        expect(info.json?.dbVersion === version.dbVersion, `app-info dbVersion ${info.json?.dbVersion}, tf-version.json ${version.dbVersion}`);
        expect(info.json?.syncVersion === version.syncVersion, `app-info syncVersion ${info.json?.syncVersion}`);
        return b.engineVersion;
    });

    await check("two people keep separate open tabs", async () => {
        const aliceTabs = JSON.stringify([{ notePath: "root", active: true }]);
        const bobTabs = JSON.stringify([{ notePath: "root/_hidden", active: true }]);
        for (const [who, tabs] of [[ALICE, aliceTabs], [BOB, bobTabs]]) {
            const res = await engine.request("PUT", "/api/options", { who, body: { openNoteContexts: tabs } });
            expect(res.status < 300, `${who.id} saving tabs: ${res.status}`);
        }
        const a = await engine.request("GET", "/api/options", { who: ALICE });
        const b = await engine.request("GET", "/api/options", { who: BOB });
        expect(a.json.openNoteContexts === aliceTabs, "Alice does not get her own tabs back");
        expect(b.json.openNoteContexts === bobTabs, "Bob does not get his own tabs back");
        for (const o of [a.json, b.json]) expect(!Object.keys(o).some((k) => k.startsWith("tfu.")), "a tfu.* row leaked into /api/options");
    });

    await check("view role is refused a write (403 tfReadOnly)", async () => {
        const res = await engine.request("POST", "/api/notes/root/children?target=into", { who: VERA, body: { title: "Nope", type: "text", content: "" } });
        expect(res.status === 403 && res.json?.tfReadOnly === true, `${res.status} ${res.text.slice(0, 120)}`);
    });

    let note = null;
    await check("stale save by someone else answers 409, the same tab of the same writer passes", async () => {
        note = await engine.createNote(ALICE, "Gate draft", "<p>start</p>");
        const first = await engine.saveNote(ALICE, note.noteId, "<p>alice 1</p>", note.blobId, "gate-tab-1");
        expect(first.status === 200 && first.json?.blobId && first.json.blobId !== note.blobId, `Alice's save: ${first.status} ${first.text.slice(0, 120)}`);
        const stale = await engine.saveNote(BOB, note.noteId, "<p>bob from an old copy</p>", note.blobId);
        expect(stale.status === 409, `Bob's stale save: ${stale.status}`);
        expect(stale.json?.conflict === true && stale.json?.blobId === first.json.blobId && stale.json?.editedBy?.id === ALICE.id, `409 body ${stale.text.slice(0, 200)}`);
        // Alice's own second device, still on the old copy, is told too (her newer text is not overwritten silently).
        const phone = await engine.saveNote(ALICE, note.noteId, "<p>alice on her phone</p>", note.blobId, "gate-tab-2");
        expect(phone.status === 409, `Alice's other device with a stale copy: ${phone.status}`);
        // The tab that wrote last may save again from the copy its own save replaced.
        const again = await engine.saveNote(ALICE, note.noteId, "<p>alice 2</p>", note.blobId, "gate-tab-1");
        expect(again.status === 200, `Alice from the tab that wrote last: ${again.status}`);
        const blob = await engine.request("GET", `/api/notes/${note.noteId}/blob`, { who: BOB });
        expect(String(blob.json?.content).includes("alice 2"), `stored content ${blob.text.slice(0, 120)}`);
    });

    await check("change events reach the gateway with the engine's key", async () => {
        const deadline = Date.now() + 10_000;
        let created;
        while (Date.now() < deadline) {
            created = receiver.batches.flatMap((b) => b.events).find((e) => e.kind === "note.created" && e.noteId === note?.noteId);
            if (created) break;
            await sleep(100);
        }
        expect(created, `no note.created event in ${receiver.batches.length} batches`);
        expect(created.userId === ALICE.id, `event userId ${created.userId}`);
        expect(receiver.batches.every((b) => b.key === engine.key), "a batch came without the engine's key");
        expect(receiver.batches.every((b) => b.path === `/internal/engine-events/${notebookId}`), "a batch went to another path");
        return `${receiver.batches.length} batches`;
    });

    await check(`idle memory under ${RSS_LIMIT_MB} MB`, async () => {
        await sleep(3000);
        const mb = await rssMbAsync(engine.proc.pid);
        expect(mb !== null, "could not read the engine's memory");
        expect(mb < RSS_LIMIT_MB, `${mb} MB`);
        return `${mb} MB`;
    });

    await engine.stop();
    await receiver.close();

    if (PREV) {
        await check("a database made by the previous released build opens and migrates", async () => {
            const prevVersion = JSON.parse(readFileSync(path.join(PREV, "tf-version.json"), "utf8"));
            const data = await temp("tf-gate-prev-");
            const old = new Engine({ build: PREV, dataDir: data });
            engines.push(old);
            await old.start(60_000);
            await old.newDocument();
            const made = [];
            for (let i = 1; i <= 3; i++) made.push({ ...(await old.createNote(ALICE, `Made by ${prevVersion.version} #${i}`, `<p>kept ${i}</p>`)), i });
            await old.request("PUT", "/api/options", { who: ALICE, body: { openNoteContexts: JSON.stringify([{ notePath: `root/${made[0].noteId}`, active: true }]) } });
            await old.stop();

            const next = new Engine({ build: BUILD, dataDir: data });
            engines.push(next);
            const ms = await next.start(120_000);
            const info = await next.request("GET", "/api/app-info", { who: ALICE });
            expect(info.json?.dbVersion === version.dbVersion, `after opening: dbVersion ${info.json?.dbVersion}`);
            for (const m of made) {
                const blob = await next.request("GET", `/api/notes/${m.noteId}/blob`, { who: ALICE });
                expect(blob.status === 200 && String(blob.json?.content).includes(`kept ${m.i}`), `note ${m.i}: ${blob.status} ${blob.text.slice(0, 120)}`);
            }
            const opts = await next.request("GET", "/api/options", { who: ALICE });
            expect(String(opts.json?.openNoteContexts).includes(made[0].noteId), "Alice's tabs did not survive");
            const write = await next.saveNote(BOB, made[1].noteId, "<p>after the upgrade</p>");
            expect(write.status === 200, `write after the upgrade: ${write.status}`);
            await next.stop();
            return `${prevVersion.version} (db ${prevVersion.dbVersion}) -> ${version.version} (db ${version.dbVersion}), opened in ${ms} ms`;
        });
    } else {
        console.log("SKIP  a database made by the previous released build opens and migrates  (no previous release)");
    }
} catch (err) {
    checks.push({ name: "gate", ok: false, ms: 0, detail: err.message });
    console.log(`FAIL  gate  (${err.message})`);
} finally {
    for (const e of engines) await e.stop().catch(() => {});
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) for (const e of engines) if (e.output.length) console.log(`--- engine output (${e.build}) ---\n${e.tail(40)}`);
    for (const d of temps) await rm(d, { recursive: true, force: true }).catch(() => {});
    const result = { ok: failed.length === 0 && checks.length > 0, version: version?.version ?? null, platform: PLATFORM, checks };
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    console.log(`${result.ok ? "GATE PASSED" : "GATE FAILED"}: ${checks.length - failed.length}/${checks.length} checks`);
    process.exitCode = result.ok ? 0 : 1;
}
