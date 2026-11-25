#!/usr/bin/env bash
# Build and install the engine while holding a lock, so two people working in
# this checkout never build into apps/server/dist at the same time. Keeps only
# the builds the manifest names (current, previous, candidate).
set -euo pipefail
cd "$(dirname "$0")/.."
ENGINES="${NOTES_ENGINE_DIR:-$HOME/apps/office-forks/trilium-engines}"
LOCK="$ENGINES/.build.lock"
mkdir -p "$ENGINES"
for i in $(seq 1 180); do
  if mkdir "$LOCK" 2>/dev/null; then break; fi
  # A lock older than 10 minutes belongs to a build that died.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null || true; continue; fi
  [ "$i" = 180 ] && { echo "tf-locked-install: lock held for 6 minutes, giving up" >&2; exit 75; }
  sleep 2
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
bash scripts/tf-install-local.sh "$@"
node -e '
const fs=require("fs"),path=require("path");const dir=process.argv[1];
const m=JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8"));
const keep=new Set(["current","previous","candidate"].map(k=>m[k]&&m[k].dir).filter(Boolean));
for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(e.isDirectory()&&/^\d+\.\d+\.\d+_tf\./.test(e.name)&&!keep.has(e.name)){fs.rmSync(path.join(dir,e.name),{recursive:true,force:true});console.log("pruned",e.name);}
}' "$ENGINES"
