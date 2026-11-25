# NoteForce: Trilium for Taskforce, release pipeline

This repository is a fork of [TriliumNext/Trilium](https://github.com/TriliumNext/Trilium)
(AGPL-3.0). Taskforce runs it as its notes engine: one Trilium process per notebook behind the
Taskforce notes gateway, with a small patch stack that adds the embed mode (gateway key, identity
from headers, per-person options, read-only role, save guard, change events, the host bridge).

- `tf/stack`: the patch stack, one upstream release tag plus our commits. What the patches do and
  which upstream files they hook into: `TF-PATCHES.md` on that branch. The contract with Taskforce
  (manifest, engine environment, gateway): `infra/notes/README.md` in the Taskforce repository.
- `tf/ci` (this branch, the default branch): no Trilium source, only the pipeline that builds,
  gates and publishes the stack.
- Releases `v<upstream>-tf.<n>`: what Taskforce installs. Each one carries
  `noteforce-engine-<upstream>+tf.<n>-linux-x64.tar.gz`, the same for `linux-arm64`, and
  `SHA256SUMS`, and its notes link the exact commit it was built from.

Upstream's own workflows (nightly builds, Docker images, desktop releases, website, and the
rest) are disabled in this fork; only `tf-release` runs.

## What the pipeline does (`.github/workflows/tf-release.yml`)

`gate/plan.mjs` decides what a run builds:

| When | What |
|---|---|
| a push to `tf/stack` (through `tf-stack-push.yml` on that branch), every hour, or by hand | `tf/stack` as it is, if its commit has no release yet (`force` builds anyway) |
| every day at 04:41 UTC, or by hand with `watch` | also: `tf/stack` rebased onto upstream's newest stable tag, if that is newer than the stack's base |

For each build:

1. `pnpm install --frozen-lockfile` (Node from `.nvmrc`, pnpm from `packageManager`), `pnpm typecheck`.
2. Specs: the tf specs (server, core on Node and again on SQLite WASM in standalone, client) and
   the upstream spec beside every upstream file the stack modifies (`gate/tf-specs.mjs`; the list
   comes from `tf-touched.json` on the stack, or from the "Upstream files touched" table of
   `TF-PATCHES.md` until that file exists, and is checked against `git diff`).
3. `pnpm server:build`, then `gate/write-version.mjs` writes `tf-version.json` at the root of the
   build: `{ version, upstream, commit, builtAt, dbVersion, syncVersion }`, the last two read
   from the built engine itself. The engine reports `version` as `engineVersion`.
4. The stack's own host page and phone checks (`scripts/tf-dev-host.mjs`, `scripts/tf-phone-check.mjs`)
   when they are on the branch; then they must pass.
5. Two packages: linux-x64 as built, linux-arm64 with the arm64 SQLite binding instead.
6. Gate, on an x64 and an arm64 runner (`gate/smoke.mjs`): the package is started exactly as the
   gateway starts it, and must refuse requests without the gateway key (403), make a new empty
   document, answer the bootstrap with the person and its own version, keep two people's open
   tabs apart, refuse a viewer's write, answer a stale save with 409, deliver change events with
   its key, have the platform's `node_modules/better-sqlite3/prebuilds/linux-<arch>.node`, start
   in under 10 s and stay under 400 MB idle; and a database made by the previous released build
   must open and migrate in it. On x64 `gate/client.mjs` also opens the embedded client in
   headless Chromium through a minimal host page: hello, port, `ready` with the build's version,
   `init`, `goto`, the note on screen, the host's dark mode, no page errors.
7. Only when all of that passed: the release (tag on the exact source commit), with the checks
   in its notes. The newest 10 releases are kept.

For a newer upstream version the result is a **prerelease** ("candidate for a new upstream
version"), a branch `tf/next-<tag>` and an issue "Upstream <tag>: stack rebased and gated, ready
to switch". When the stack does not apply or a check fails, the issue says which files or which
check instead; there is one issue per upstream tag, updated by later runs. Taskforce never installs
a newer upstream version by itself (it only takes releases for the version it runs): upstream
database migrations are one-way, so a person switches.

The default token may not create or change files under `.github/workflows`, and upstream changes
its workflows between releases, so the workflow's push of `tf/next-<tag>` can be refused. The
prerelease then carries `tf-next-<tag>.bundle` with the exact commits.

## Cut a release by hand

Actions, `tf-release`, "Run workflow" on `tf/ci` (or `gh workflow run tf-release.yml --ref tf/ci`).
A stack commit that already has a release is not rebuilt unless `force` is ticked; the new build
then gets the next number. The gate scripts run locally too:

```sh
cd gate && npm ci && cd ..
node gate/smoke.mjs --engine <unpacked build> [--prev <unpacked previous build>] [--platform linux-x64]
CHROME_PATH=<chrome> node gate/client.mjs --engine <unpacked build>
```

## Switch to a new upstream version

Usually the daily run has done the rebase already (branch `tf/next-<tag>`, or the bundle on the
prerelease). By hand, in a checkout of this fork:

```sh
git remote add upstream https://github.com/TriliumNext/Trilium.git   # once
git fetch upstream tag v0.108.0 --no-tags
git switch -c tf/next-v0.108.0 tf/stack
git rebase --onto v0.108.0 v0.107.0      # resolve, keep the hooks one line each, update TF-PATCHES.md
export PATH=~/apps/office-forks/tools/pnpm12/node_modules/.bin:$PATH
pnpm install && pnpm typecheck && pnpm server:build
# the tf specs and the specs beside touched files, as in TF-PATCHES.md "Tests"
git push --force-with-lease origin tf/next-v0.108.0:tf/stack
```

The push starts the pipeline; its release is a normal one for the new version. In Taskforce, a
build for a newer upstream version is never installed by the worker job by itself: set
`NOTES_ENGINE_PIN=<version>` on the worker for the switch (Taskforce `infra/notes/README.md`,
"Engine releases"), and read upstream's release notes for database migrations first. The
gateway keeps `pre-<version>.db` of every notebook before the new engine opens it.

## Roll back

- A bad release: delete it (`gh release delete v0.107.0-tf.4 --cleanup-tag`). Taskforce does not
  take it if it is still on trial; one that is in use is replaced by editing Taskforce's engine
  `manifest.json` (`current` back to `previous`), see "Engine releases" in Taskforce's notes README.
- A bad stack commit: revert it on `tf/stack` and push; the next build gets the next number and
  replaces the bad one through the normal trial.
- A switch to a new upstream version that went wrong: the engine manifest's `previous` still
  names the old build, and every notebook has `pre-<version>.db` from before the migration.
