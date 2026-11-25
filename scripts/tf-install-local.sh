#!/usr/bin/env bash
#
# Builds the engine (server + client) and installs it as a NoteForce engine build:
#   ${NOTES_ENGINE_DIR:-~/apps/office-forks/trilium-engines}/<upstream>_tf.<suffix>/
# then points manifest.json at it (current -> previous, the new build -> current).
#
# Usage: scripts/tf-install-local.sh [suffix]
#   suffix  defaults to the next free devN (dev1, dev2, ...).
#
# Set TF_SKIP_BUILD=1 to install the existing apps/server/dist without rebuilding.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
engine_root="${NOTES_ENGINE_DIR:-$HOME/apps/office-forks/trilium-engines}"
dist_dir="$repo_root/apps/server/dist"

upstream_version="$(node -p "require('$repo_root/apps/server/package.json').version")"

suffix="${1:-}"
if [[ -z "$suffix" ]]; then
    n=1
    while [[ -e "$engine_root/${upstream_version}_tf.dev$n" ]]; do
        n=$((n + 1))
    done
    suffix="dev$n"
fi

if [[ ! "$suffix" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "Suffix must contain only letters, digits, dots and dashes: '$suffix'" >&2
    exit 1
fi

version="${upstream_version}+tf.${suffix}"
dir_name="${upstream_version}_tf.${suffix}"
target="$engine_root/$dir_name"

if [[ -e "$target" ]]; then
    echo "$target already exists; pick another suffix." >&2
    exit 1
fi

if [[ "${TF_SKIP_BUILD:-}" != "1" ]]; then
    (cd "$repo_root" && pnpm server:build)
fi

if [[ ! -f "$dist_dir/main.mjs" ]]; then
    echo "No build at $dist_dir (main.mjs missing)." >&2
    exit 1
fi

mkdir -p "$engine_root"
tmp_target="$engine_root/.${dir_name}.partial"
rm -rf "$tmp_target"
cp -R "$dist_dir" "$tmp_target"
printf '{ "version": "%s", "upstreamVersion": "%s", "builtFrom": "%s" }\n' \
    "$version" "$upstream_version" "$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    > "$tmp_target/tf-version.json"
mv "$tmp_target" "$target"

manifest="$engine_root/manifest.json"
MANIFEST="$manifest" VERSION="$version" DIR="$dir_name" node <<'EOF'
const fs = require("fs");
const file = process.env.MANIFEST;
let manifest = { current: null, previous: null, candidate: null };
if (fs.existsSync(file)) {
    manifest = { ...manifest, ...JSON.parse(fs.readFileSync(file, "utf-8")) };
}
const next = {
    current: {
        version: process.env.VERSION,
        dir: process.env.DIR,
        source: "tf-install-local",
        installedAt: new Date().toISOString()
    },
    previous: manifest.current ?? manifest.previous ?? null,
    candidate: manifest.candidate ?? null
};
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
fs.renameSync(tmp, file);
EOF

echo "Installed $version at $target"
echo "manifest: $manifest"
