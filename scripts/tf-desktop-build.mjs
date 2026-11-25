#!/usr/bin/env node
/**
 * Builds Taskforce Notes (`TF_DESKTOP=1`) for macOS arm64: signed with a Developer ID (hardened
 * runtime), notarized and stapled, and writes `<out>/<version>/` with the `.dmg`, the `.zip` (the
 * signed app inside, for Squirrel.Mac) and `meta.json` as the notes gateway reads it
 * (`infra/notes/DESKTOP.md`, "Builds on disk", in the Taskforce repository).
 *
 * Nothing that names a person, a team or a domain is read from this repository. Environment:
 *
 *   TF_DESKTOP_BUILD     the integer build number (required, above every published build)
 *   TF_DESKTOP_VERSION   the version string (default `<upstream version>-tf.<build>`)
 *   TF_DESKTOP_BUNDLE_ID the bundle id (default `org.triliumtf.notes`)
 *   TF_SIGN_IDENTITY     the "Developer ID Application: …" identity in the keychain
 *   TF_NOTARY_PROFILE    the `xcrun notarytool store-credentials` keychain profile
 *
 * Usage: node scripts/tf-desktop-build.mjs [--out <dir>] [--unsigned]
 * `--unsigned` makes an unsigned, unnotarized build for local checks; it never writes meta.json.
 */
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(repo, "apps/desktop");
const args = process.argv.slice(2);
const unsigned = args.includes("--unsigned");
const outIndex = args.indexOf("--out");
const outRoot = path.resolve(outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : path.join(desktopDir, "out/tf-desktop"));

const fail = (message) => {
    console.error(`tf-desktop-build: ${message}`);
    process.exit(1);
};

if (process.platform !== "darwin") fail("builds for macOS run on a Mac.");
const build = Number.parseInt(process.env.TF_DESKTOP_BUILD ?? "", 10);
if (!Number.isInteger(build) || build <= 0) fail("TF_DESKTOP_BUILD must be a positive integer.");
const identity = process.env.TF_SIGN_IDENTITY?.trim();
const notaryProfile = process.env.TF_NOTARY_PROFILE?.trim();
if (!unsigned && (!identity || !notaryProfile)) fail("TF_SIGN_IDENTITY and TF_NOTARY_PROFILE are needed (or --unsigned).");

const upstreamVersion = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf-8")).version;
const version = process.env.TF_DESKTOP_VERSION?.trim() || `${upstreamVersion}-tf.${build}`;
if (!/^[0-9A-Za-z.+-]+$/.test(version)) fail(`the version "${version}" cannot name a folder.`);
const { syncVersion, dbVersion } = readProtocolVersions();

const env = {
    ...process.env,
    TF_DESKTOP: "1",
    TF_DESKTOP_BUILD: String(build),
    TF_DESKTOP_VERSION: version,
    ...(unsigned ? { TF_SIGN_IDENTITY: "", TF_NOTARY_PROFILE: "" } : {})
};
delete env.ELECTRON_RUN_AS_NODE;
// The packager notarizes with the keychain profile; an Apple ID in the environment would switch
// upstream's own notarization on next to it.
delete env.APPLE_ID;

console.log(`tf-desktop-build: Taskforce Notes ${version} (build ${build}, sync ${syncVersion}, db ${dbVersion}), ${unsigned ? "unsigned" : "signed and notarized"}`);

run("pnpm", [ "--filter", "desktop", "build" ], repo);
// Forge resolves `outDir` against the project folder it is given (`dist`).
const outCandidates = [ path.join(desktopDir, "dist", "out"), path.join(desktopDir, "out") ];
for (const candidate of outCandidates) {
    fs.rmSync(path.join(candidate, "make"), { recursive: true, force: true });
    fs.rmSync(path.join(candidate, "Taskforce Notes-darwin-arm64"), { recursive: true, force: true });
}
run("pnpm", [ "exec", "electron-forge", "make", "dist", "--platform=darwin", "--arch=arm64",
    "--targets=@electron-forge/maker-dmg,@electron-forge/maker-zip" ], desktopDir);

const makeOut = outCandidates.find((candidate) => fs.existsSync(path.join(candidate, "Taskforce Notes-darwin-arm64"))) ?? outCandidates[0];
const appPath = path.join(makeOut, "Taskforce Notes-darwin-arm64", "Taskforce Notes.app");
if (!fs.existsSync(appPath)) fail(`the packaged app is missing at ${appPath}.`);
const dmgSource = findArtifact(path.join(makeOut, "make"), ".dmg");
const zipSource = findArtifact(path.join(makeOut, "make"), ".zip");

checkInfoPlist(appPath);

const versionDir = path.join(outRoot, version);
fs.rmSync(versionDir, { recursive: true, force: true });
fs.mkdirSync(versionDir, { recursive: true });
const files = {
    dmg: `taskforce-notes-${version}-darwin-arm64.dmg`,
    zip: `taskforce-notes-${version}-darwin-arm64.zip`
};
const dmgPath = path.join(versionDir, files.dmg);
const zipPath = path.join(versionDir, files.zip);
fs.copyFileSync(dmgSource, dmgPath);
fs.copyFileSync(zipSource, zipPath);

if (!unsigned) {
    run("codesign", [ "--verify", "--deep", "--strict", "--verbose=2", appPath ]);
    run("xcrun", [ "stapler", "validate", appPath ]);
    run("spctl", [ "--assess", "--type", "execute", "--verbose=2", appPath ]);

    // The image itself: signed, notarized and stapled, so Gatekeeper accepts it as downloaded.
    run("codesign", [ "--force", "--sign", identity, "--timestamp", dmgPath ]);
    run("xcrun", [ "notarytool", "submit", dmgPath, "--keychain-profile", notaryProfile, "--wait" ]);
    run("xcrun", [ "stapler", "staple", dmgPath ]);
    run("xcrun", [ "stapler", "validate", dmgPath ]);
    run("spctl", [ "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmgPath ]);

    // The zip Squirrel.Mac installs from must hold the signed, stapled app.
    const unzipDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-desktop-zip-"));
    try {
        run("ditto", [ "-x", "-k", zipPath, unzipDir ]);
        const zippedApp = path.join(unzipDir, "Taskforce Notes.app");
        run("codesign", [ "--verify", "--deep", "--strict", zippedApp ]);
        run("xcrun", [ "stapler", "validate", zippedApp ]);
    } finally {
        fs.rmSync(unzipDir, { recursive: true, force: true });
    }
}

const meta = {
    version,
    build,
    syncVersion,
    dbVersion,
    builtAt: new Date().toISOString(),
    files,
    sha256: { dmg: sha256(dmgPath), zip: sha256(zipPath) },
    size: { dmg: fs.statSync(dmgPath).size, zip: fs.statSync(zipPath).size }
};
if (unsigned) {
    console.log("tf-desktop-build: unsigned build, no meta.json written:", JSON.stringify(meta, null, 2));
} else {
    fs.writeFileSync(path.join(versionDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`tf-desktop-build: done, ${versionDir}`);
    console.log(JSON.stringify(meta, null, 2));
}

function run(command, commandArgs, cwd = repo) {
    console.log(`$ ${command} ${commandArgs.join(" ")}`);
    const result = spawnSync(command, commandArgs, { cwd, env, stdio: "inherit" });
    if (result.status !== 0) fail(`${command} ${commandArgs[0] ?? ""} failed (${result.status ?? result.signal}).`);
}

function findArtifact(dir, extension) {
    const found = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory() && !entry.name.endsWith(".app")) walk(full);
            else if (entry.isFile() && entry.name.endsWith(extension) && entry.name.includes("arm64")) found.push(full);
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    if (found.length !== 1) fail(`expected one ${extension} in ${dir}, found ${found.length}.`);
    return found[0];
}

/** The app must carry the scheme, the bundle id and the build number it was built with. */
function checkInfoPlist(app) {
    const plist = path.join(app, "Contents", "Info.plist");
    const read = (key) => execFileSync("/usr/libexec/PlistBuddy", [ "-c", `Print :${key}`, plist ], { encoding: "utf-8" }).trim();
    const bundleVersion = read("CFBundleVersion");
    const scheme = read("CFBundleURLTypes:0:CFBundleURLSchemes:0");
    const bundleId = read("CFBundleIdentifier");
    const expectedId = process.env.TF_DESKTOP_BUNDLE_ID?.trim() || "org.triliumtf.notes";
    if (bundleVersion !== String(build) || scheme !== "taskforce-notes" || bundleId !== expectedId) {
        fail(`Info.plist has build ${bundleVersion}, scheme ${scheme}, id ${bundleId}.`);
    }
    console.log(`tf-desktop-build: Info.plist ok (${bundleId}, build ${bundleVersion}, ${scheme}:)`);
}

/** The sync version (`SYNC_VERSION` in core's app_info) and the database version (newest migration). */
function readProtocolVersions() {
    const appInfo = fs.readFileSync(path.join(repo, "packages/trilium-core/src/services/app_info.ts"), "utf-8");
    const sync = /const SYNC_VERSION = (\d+);/.exec(appInfo);
    const migrations = fs.readFileSync(path.join(repo, "packages/trilium-core/src/migrations/migrations.ts"), "utf-8");
    const list = migrations.slice(migrations.indexOf("export const MIGRATIONS"));
    const versions = [ ...list.matchAll(/^\s*version:\s*(\d+),/gm) ].map((match) => Number(match[1]));
    if (!sync || versions.length === 0) fail("could not read SYNC_VERSION or the migrations.");
    const db = Math.max(...versions);
    if (versions[0] !== db) fail("the newest migration is not first in MIGRATIONS.");
    return { syncVersion: Number(sync[1]), dbVersion: db };
}

function sha256(file) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
