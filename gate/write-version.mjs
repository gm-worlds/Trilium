#!/usr/bin/env node
// Writes `tf-version.json` at the root of a server build.
//
//   node gate/write-version.mjs --dist apps/server/dist --version 0.107.0+tf.3 --commit <sha>
//
// The engine's `/api/tf/bootstrap` reports `engineVersion` from this file (fork
// `apps/server/src/tf/env.ts`, `getTfEngineVersion()`), and the Taskforce worker and gateway read
// it to know what they installed. The database and sync versions are not guessed from the
// source: the build itself is started on an empty folder and asked (`/api/app-info`).
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Engine } from "./engine.mjs";

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) throw new Error(`--${name} is required`);
    return process.argv[i + 1];
};
const DIST = path.resolve(arg("dist"));
const VERSION = arg("version");
const COMMIT = arg("commit");

const m = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\+tf\.(\d+)$/.exec(VERSION);
if (!m) throw new Error(`version ${VERSION} is not <upstream>+tf.<n>`);

const data = await mkdtemp(path.join(os.tmpdir(), "tf-version-"));
const engine = new Engine({ build: DIST, dataDir: data });
try {
    await engine.start(120_000);
    const info = await engine.request("GET", "/api/app-info");
    if (info.status !== 200) throw new Error(`/api/app-info answered ${info.status}`);
    const { appVersion, dbVersion, syncVersion } = info.json;
    if (appVersion !== m[1]) throw new Error(`the build is upstream ${appVersion}, not ${m[1]}`);
    if (!Number.isInteger(dbVersion) || !Number.isInteger(syncVersion)) throw new Error(`app-info has no dbVersion/syncVersion: ${info.text}`);
    const out = { version: VERSION, upstream: appVersion, commit: COMMIT, builtAt: new Date().toISOString(), dbVersion, syncVersion };
    writeFileSync(path.join(DIST, "tf-version.json"), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify(out));
} finally {
    await engine.stop();
    await rm(data, { recursive: true, force: true });
}
