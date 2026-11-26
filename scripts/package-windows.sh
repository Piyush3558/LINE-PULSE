#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
root="$PWD"
profile="${1:-}"
if [[ -z "$profile" || ! -s "$profile/.env" || ! -s "$profile/line-pulse-db-ca.pem" ]]; then
    printf 'Usage: %s SHARED_DATABASE_PROFILE_DIRECTORY\n' "$0" >&2
    exit 2
fi

umask 077
release="$root/data/windows-release"
cache="$release/cache"
install -d -m 700 "$cache"
version=24.22.3
filename="node-v$version-win-x64.zip"
manifest="SHASUMS256-v$version.txt"
origin="https://nodejs.org/dist/v$version"
if [[ ! -s "$cache/$manifest" ]]; then
    curl -fsSL --retry 2 "$origin/SHASUMS256.txt" -o "$cache/$manifest"
fi
if [[ ! -s "$cache/$filename" ]]; then
    curl -fsSL --retry 2 "$origin/$filename" -o "$cache/$filename"
fi
(cd "$cache"; awk -v name="$filename" '$2==name {print}' "$manifest" | sha256sum -c -)

work="$(mktemp -d "$release/package-XXXXXX")"
trap 'node -e "require(\"node:fs\").rmSync(process.argv[1], { recursive: true, force: true })" "$work"' EXIT
stage="$work/LinePulse"
mkdir -p "$stage" "$stage/scripts"
rsync -a --exclude=node_modules --exclude=dist --exclude=.env backend frontend database docs "$stage/"
cp package.json package-lock.json tsconfig.json README.md PART_TRACEABILITY_PLAN.md "$stage/"
cp scripts/{dev,vite}.mjs "$stage/scripts/"
cp "$profile/.env" "$profile/line-pulse-db-ca.pem" "$stage/"
unzip -q "$cache/$filename" -d "$work" "node-v$version-win-x64/node.exe" "node-v$version-win-x64/LICENSE" "node-v$version-win-x64/node_modules/npm/*"
mv "$work/node-v$version-win-x64" "$stage/runtime"

write_cmd() {
    awk '{ sub(/\r$/, ""); printf "%s\r\n", $0 }' "$1" > "$stage/$2"
}
write_cmd scripts/portable-npm.cmd npm.cmd
write_cmd scripts/Start-Line-Pulse.cmd Start-Line-Pulse.cmd
write_cmd scripts/Open-Line-Pulse-Terminal.cmd Open-Line-Pulse-Terminal.cmd
printf '%s\r\n' \
    'Line Pulse for 64-bit Windows' \
    'Extract everything into a folder you can write to, such as Downloads or Documents.' \
    'Double-click Start-Line-Pulse.cmd, or double-click Open-Line-Pulse-Terminal.cmd and type npm run dev.' \
    'Open http://127.0.0.1:5173 and sign in with your existing Line Pulse account.' \
    'Keep the Linux database host reachable at the address in this profile.' \
    'Keep this ZIP private. It contains the shared database connection credentials.' \
    > "$stage/START-HERE.txt"

(
    cd "$stage"
    npm ci --os=win32 --cpu=x64 --include=optional --ignore-scripts --no-bin-links --no-audit --no-fund
    for workspace in node_modules/@line-pulse/backend node_modules/@line-pulse/frontend; do
        if [[ -L "$workspace" ]]; then unlink "$workspace"; fi
    done
    test -f node_modules/@esbuild/win32-x64/esbuild.exe
    test -n "$(find node_modules/@rolldown/binding-win32-x64-msvc -name '*.node' -type f -print -quit)"
    test -n "$(find node_modules/lightningcss-win32-x64-msvc -name '*.node' -type f -print -quit)"
    node --input-type=module <<'NODE'
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = process.cwd();
const names = new Set();
for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const name = relative(root, join(entry.parentPath, entry.name));
    const folded = name.toLowerCase();
    if (!(entry.isFile() || entry.isDirectory()) || names.has(folded) || name.length > 180 ||
        /[<>:"\\|?*\x00-\x1f]|[ .]$/.test(entry.name) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(entry.name)) {
        throw new Error(`The portable Windows archive contains an unsupported path: ${name}`);
    }
    names.add(folded);
}
NODE
)
(cd "$work"; zip -X -q -r Line-Pulse-Windows-x64.zip LinePulse)
unzip -tq "$work/Line-Pulse-Windows-x64.zip"
mv "$work/Line-Pulse-Windows-x64.zip" "$release/"
printf 'Created %s/Line-Pulse-Windows-x64.zip\n' "$release"
