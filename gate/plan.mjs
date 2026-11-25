#!/usr/bin/env node
// What one tf-release run builds. Writes `targets`, `gates`, `prev_tag`, `node` and `any` to
// $GITHUB_OUTPUT (and prints them).
//
// Targets:
// - "stack": tf/stack as it is, when its commit has no release yet (or FORCE=true). Version
//   `<upstream>+tf.<n>`, n = one above the highest published for that upstream version.
// - "next": tf/stack rebased onto a newer STABLE upstream tag (WATCH=true: the daily run), unless a
//   prerelease for that pair exists or an open issue already reports this exact stack failing on
//   it. Published only as a prerelease; a person switches tf/stack over (upstream migrations are
//   one-way). WATCH_TAG names the tag by hand (any tag, also a release candidate: for testing the
//   watch itself).
//
// Env: GITHUB_REPOSITORY, GH_TOKEN, UPSTREAM, STACK_BRANCH, FORCE, WATCH, WATCH_TAG, GITHUB_OUTPUT.
import { appendFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY;
const UPSTREAM = process.env.UPSTREAM ?? "TriliumNext/Trilium";
const STACK_BRANCH = process.env.STACK_BRANCH ?? "tf/stack";
const FORCE = process.env.FORCE === "true";
const WATCH = process.env.WATCH === "true";
const WATCH_TAG = (process.env.WATCH_TAG ?? "").trim();
const ARCHES = [
    { arch: "x64", runner: "ubuntu-latest" },
    { arch: "arm64", runner: "ubuntu-24.04-arm" },
];

async function gh(path, { allow404 = false } = {}) {
    const res = await fetch(`https://api.github.com/${path}`, {
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${process.env.GH_TOKEN}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "noteforce-tf-release",
        },
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${await res.text()}`);
    return res.json();
}

async function all(path, pages = 5) {
    const out = [];
    for (let page = 1; page <= pages; page++) {
        const batch = await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
}

/** `0.107.0` vs `0.108.0-rc.1`: numeric parts, a pre-release before its release. */
export function compareVersions(a, b) {
    const parse = (v) => {
        const [core, pre] = v.replace(/^v/, "").split("+")[0].split(/-(.*)/s);
        return { nums: core.split(".").map((n) => Number(n) || 0), pre: pre || "" };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0) ? 1 : -1;
    if (x.pre && !y.pre) return -1;
    if (!x.pre && y.pre) return 1;
    return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

const TF_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)-tf\.(\d+)$/;

const stack = (await gh(`repos/${REPO}/branches/${encodeURIComponent(STACK_BRANCH)}`)).commit.sha;
const file = async (p) => Buffer.from((await gh(`repos/${REPO}/contents/${p}?ref=${stack}`)).content, "base64").toString("utf8");
const base = JSON.parse(await file("apps/server/package.json")).version;
const node = (await file(".nvmrc")).trim();
const releases = (await all(`repos/${REPO}/releases`)).filter((r) => !r.draft);
const tagRefs = ((await gh(`repos/${REPO}/git/matching-refs/tags/v`, { allow404: true })) ?? []).map((r) => r.ref.replace("refs/tags/", ""));

function nextNumber(upstream) {
    let max = 0;
    for (const t of [...releases.map((r) => r.tag_name), ...tagRefs]) {
        const m = TF_TAG.exec(t);
        if (m && m[1] === upstream) max = Math.max(max, Number(m[2]));
    }
    return max + 1;
}
const released = (key) => releases.some((r) => (r.body ?? "").includes(key));

const targets = [];
const notes = [];
const stackKey = `upstream=v${base} stack=${stack}`;
if (!released(stackKey) || FORCE) {
    const n = nextNumber(base);
    targets.push({ name: "stack", onto: "", base: `v${base}`, upstream: base, version: `${base}+tf.${n}`, tag: `v${base}-tf.${n}`, prerelease: false, key: stackKey });
} else {
    notes.push(`tf/stack ${stack.slice(0, 10)} on v${base} is released already`);
}

if (WATCH || WATCH_TAG) {
    let tag = WATCH_TAG;
    if (!tag) {
        const stable = (await all(`repos/${UPSTREAM}/releases`, 1))
            .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
            .map((r) => r.tag_name)
            .sort((a, b) => compareVersions(b, a));
        tag = stable[0] ?? "";
    }
    if (!tag) {
        notes.push("upstream has no stable release");
    } else if (compareVersions(tag, `v${base}`) <= 0) {
        notes.push(`upstream's newest stable tag ${tag} is not newer than the stack's v${base}`);
    } else {
        const upstream = tag.replace(/^v/, "");
        const key = `upstream=${tag} stack=${stack}`;
        const issues = await all(`repos/${REPO}/issues?state=open`, 2).catch(() => []);
        const reported = issues.some((i) => !i.pull_request && i.title.startsWith(`Upstream ${tag}:`) && (i.body ?? "").includes(key) && !i.title.includes("ready to switch"));
        if (released(key)) notes.push(`${tag} with this stack is published as a candidate already`);
        else if (reported && !FORCE) notes.push(`${tag} with this stack failed before and has an open issue; push a fix to tf/stack or run with force`);
        else {
            const n = nextNumber(upstream);
            targets.push({ name: "next", onto: tag, base: `v${base}`, upstream, version: `${upstream}+tf.${n}`, tag: `v${upstream}-tf.${n}`, prerelease: true, key });
        }
    }
}

// The build whose databases the new one must open: the newest one people can have.
const prev = releases
    .filter((r) => !r.prerelease && TF_TAG.test(r.tag_name))
    .sort((a, b) => {
        const [, va, na] = TF_TAG.exec(a.tag_name);
        const [, vb, nb] = TF_TAG.exec(b.tag_name);
        return compareVersions(vb, va) || Number(nb) - Number(na);
    })[0];

const gates = targets.flatMap((t) => ARCHES.map((a) => ({ target: t.name, ...a })));
const out = { stack, base: `v${base}`, node, targets, gates, prev_tag: prev?.tag_name ?? "", any: targets.length > 0, notes };
console.log(JSON.stringify(out, null, 2));
if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        `targets=${JSON.stringify(targets)}\ngates=${JSON.stringify(gates)}\nprev_tag=${out.prev_tag}\nnode=${node}\nstack=${stack}\nany=${out.any}\n`,
    );
}
