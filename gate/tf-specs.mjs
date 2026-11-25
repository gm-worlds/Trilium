#!/usr/bin/env node
// Which upstream specs a stack touches, for the build job.
//
//   node gate/tf-specs.mjs --src <tf/stack checkout> --base <upstream tag> [--github-output <file>]
//
// The list of upstream files the stack hooks into comes from `tf-touched.json` at the root of
// `tf/stack` when it is there ({ "files": ["path", ...] } or [{ "path": ... }, ...]), otherwise
// from the "Upstream files touched" table of TF-PATCHES.md (the backtick paths in its first
// column). Both are checked against git: every upstream file the stack modifies is in the list
// that is run, whether or not the document names it (a hook nobody listed is reported as a
// warning, and its specs still run).
//
// For each touched file the spec beside it (`x.ts` -> `x.spec.ts` / `x.spec.tsx`) is selected.
// Core specs run twice (server on Node, standalone on SQLite WASM), as upstream's CI does.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
};
const SRC = path.resolve(arg("src", "."));
const BASE = arg("base", "");
const OUT = arg("github-output", "");
if (!BASE) throw new Error("--base <upstream tag> is required");

const git = (...args) => execFileSync("git", ["-C", SRC, ...args], { encoding: "utf8" }).trim();

function fromJson(file) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.files;
    if (!Array.isArray(list)) throw new Error("tf-touched.json: expected an array or { files: [...] }");
    return list.map((e) => (typeof e === "string" ? e : e?.path)).filter((p) => typeof p === "string" && p);
}

function fromMarkdown(file) {
    const md = readFileSync(file, "utf8");
    const start = md.search(/^##\s+Upstream files touched\s*$/m);
    if (start < 0) throw new Error("TF-PATCHES.md has no \"## Upstream files touched\" section");
    const rest = md.slice(start).split("\n").slice(1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    const files = [];
    for (const line of end < 0 ? rest : rest.slice(0, end)) {
        if (!line.startsWith("|")) continue;
        const first = line.split("|")[1] ?? "";
        for (const m of first.matchAll(/`([^`]+)`/g)) if (/\.[cm]?[jt]sx?$/.test(m[1]) || m[1].includes("/")) files.push(m[1]);
    }
    if (files.length === 0) throw new Error("TF-PATCHES.md: the \"Upstream files touched\" table lists no file");
    return files;
}

let source;
let listed;
if (existsSync(path.join(SRC, "tf-touched.json"))) {
    source = "tf-touched.json";
    listed = fromJson(path.join(SRC, "tf-touched.json"));
} else {
    source = "TF-PATCHES.md (parsed; tf-touched.json not on the stack yet)";
    listed = fromMarkdown(path.join(SRC, "TF-PATCHES.md"));
}

const base = git("merge-base", "HEAD", BASE);
const modified = git("diff", "--name-only", "--diff-filter=MR", base, "HEAD").split("\n").filter(Boolean);
const warnings = [];
for (const f of modified) if (!listed.includes(f)) warnings.push(`${f} is modified by the stack but not listed in ${source.split(" ")[0]}`);
for (const f of listed) if (!modified.includes(f)) warnings.push(`${f} is listed but the stack does not modify it`);
const touched = [...new Set([...listed.filter((f) => modified.includes(f)), ...modified])].sort();

const specs = [];
for (const f of touched) {
    const stem = f.replace(/\.[cm]?[jt]sx?$/, "");
    for (const ext of [".spec.ts", ".spec.tsx"]) if (existsSync(path.join(SRC, stem + ext))) specs.push(stem + ext);
}
const under = (prefix) => specs.filter((s) => s.startsWith(prefix));
const core = under("packages/trilium-core/");
const server = under("apps/server/").map((s) => s.slice("apps/server/".length));
const client = under("apps/client/").map((s) => s.slice("apps/client/".length));
const other = specs.filter((s) => !s.startsWith("packages/trilium-core/") && !s.startsWith("apps/server/") && !s.startsWith("apps/client/"));

const result = {
    source,
    base: BASE,
    touched,
    specs: { server, core, client, other },
    // Arguments for `vitest run` in each package (substring filters over the spec paths).
    args: {
        server: ["src/tf/", "../../packages/trilium-core/src/tf/", ...server, ...core.map((s) => `../../${s}`)].join(" "),
        standalone: ["tf/tf_core", ...core.map((s) => s.replace(/^packages\//, ""))].join(" "),
        client: ["src/tf/", ...client].join(" "),
    },
    warnings,
};
console.log(JSON.stringify(result, null, 2));
for (const w of warnings) console.log(`::warning title=tf/stack hook list::${w}`);
if (other.length) console.log(`::warning title=tf/stack specs::specs outside server, core and client are not run: ${other.join(", ")}`);
if (OUT) {
    appendFileSync(OUT, `server_args=${result.args.server}\nstandalone_args=${result.args.standalone}\nclient_args=${result.args.client}\nlist_source=${source}\n`);
}
