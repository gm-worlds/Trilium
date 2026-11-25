#!/usr/bin/env node
// One issue per upstream tag for the upstream watch: opened once, then updated, never duplicated.
//
//   node gate/issue.mjs --report <report.md> --build <build-next.json>
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, ONTO (upstream tag), KEY (`upstream=<tag> stack=<sha>`), OK,
// RELEASE_URL, BRANCH_SHA, RUN_URL, TAG (the prerelease tag).
import { existsSync, readFileSync } from "node:fs";

const arg = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];
const report = existsSync(arg("report")) ? readFileSync(arg("report"), "utf8") : "(no report)";
const build = existsSync(arg("build")) ? JSON.parse(readFileSync(arg("build"), "utf8")) : null;
const { GITHUB_REPOSITORY: REPO, ONTO, KEY, OK, RELEASE_URL, BRANCH_SHA, RUN_URL, TAG } = process.env;

async function gh(method, path, body) {
    const res = await fetch(`https://api.github.com/${path}`, {
        method,
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${process.env.GH_TOKEN}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "noteforce-tf-release",
            ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${method} ${path}: ${await res.text()}`);
    return res.json();
}

const passed = OK === "true";
const title = passed
    ? `Upstream ${ONTO}: stack rebased and gated, ready to switch`
    : build?.stage === "rebase"
      ? `Upstream ${ONTO}: the stack does not apply`
      : `Upstream ${ONTO}: the rebased stack fails a check`;

const body = passed
    ? [
          `Trilium ${ONTO} is out. The patch stack was rebased onto it, built and gated: ${RELEASE_URL} (prerelease \`${TAG}\`, candidate for a new upstream version).`,
          "",
          BRANCH_SHA
              ? `Branch: \`tf/next-${ONTO}\` at \`${BRANCH_SHA}\`.`
              : `The workflow could not push \`tf/next-${ONTO}\` (its token may not write workflow files, and upstream changed some); the commits are in \`tf-next-${ONTO}.bundle\` on the prerelease.`,
          "",
          "Taskforce does not install it by itself: upstream database migrations are one-way. To switch, see \"Switch to a new upstream version\" in the README of `tf/ci`: move `tf/stack` to the rebased commits, push, and the next run publishes it as a normal release that Taskforce tries for a day.",
          "",
          report,
          "",
          `Run: ${RUN_URL}`,
          "",
          KEY,
      ].join("\n")
    : [
          `Trilium ${ONTO} is out, and the patch stack does not pass on it yet. Nothing was published; Taskforce stays on its current build.`,
          "",
          report,
          "",
          `Run: ${RUN_URL}`,
          "",
          "Fix it on a local rebase (README of `tf/ci`, \"Switch to a new upstream version\"), push `tf/stack`, and the next daily run tries again. This issue is updated by each run for this tag, not duplicated.",
          "",
          KEY,
      ].join("\n");

const open = await gh("GET", `repos/${REPO}/issues?state=open&per_page=100`);
const existing = open.find((i) => !i.pull_request && i.title.startsWith(`Upstream ${ONTO}:`));
if (existing) {
    await gh("PATCH", `repos/${REPO}/issues/${existing.number}`, { title, body });
    console.log(`updated issue #${existing.number}: ${title}`);
} else {
    const made = await gh("POST", `repos/${REPO}/issues`, { title, body });
    console.log(`opened issue #${made.number}: ${title}`);
}
