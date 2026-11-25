#!/usr/bin/env node
// Markdown summary of one target's build and gate results (release notes, issues, run log).
//
//   node gate/report.mjs --dir <results> --name stack|next
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const arg = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];
const DIR = arg("dir");
const NAME = arg("name");
const read = (f) => (existsSync(path.join(DIR, f)) ? JSON.parse(readFileSync(path.join(DIR, f), "utf8")) : null);

const build = read(`build-${NAME}.json`);
const lines = [];
if (!build) lines.push("- Build: no result (the job did not run to its end).");
else if (build.stage === "rebase") {
    lines.push(`- The stack does not apply: patch \`${build.patch}\` conflicts in`);
    for (const f of build.conflicts ?? []) lines.push(`  - \`${f}\``);
} else if (!build.ok) lines.push(`- Build failed at step \`${build.stage ?? "unknown"}\` (install, typecheck, tf specs, upstream specs of touched files, server build, phone checks).`);
else lines.push("- Build: typecheck, tf specs (server, core on Node and on SQLite WASM, client), upstream specs of every upstream file the stack touches, server build, host page and phone checks when the stack has them: passed.");

for (const arch of ["x64", "arm64"]) {
    const gate = read(`gate-${NAME}-${arch}.json`);
    if (!gate) {
        lines.push(`- Gate linux-${arch}: did not run.`);
        continue;
    }
    const failed = gate.checks.filter((c) => !c.ok);
    if (gate.ok && failed.length === 0) {
        lines.push(`- Gate linux-${arch}: ${gate.checks.length} checks passed.`);
        for (const c of gate.checks) lines.push(`  - ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    } else {
        lines.push(`- Gate linux-${arch}: FAILED${failed.length ? "" : " (the job failed before its checks)"}.`);
        for (const c of failed) lines.push(`  - FAIL ${c.name}: ${String(c.detail ?? "").slice(0, 300)}`);
    }
}
console.log(lines.join("\n"));
