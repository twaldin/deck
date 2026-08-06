#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATCH_DIR="$REPO_ROOT/patches/prime-agent"
MANIFEST="$PATCH_DIR/manifest.json"
MARKER_NAME=".deck-prime-patches.json"

usage() {
  cat <<'USAGE'
Usage: ops/prime-patches.sh <status|apply|verify>

Environment overrides:
  PRIME_AGENT_BIN            prime-agent executable for status/verify
  PRIME_AGENT_ROOT           installed prime-agent package root for status/verify
  PRIME_PATCH_NPM_PREFIX     npm prefix containing the target install (all commands)

status reports the installed patch fingerprint and checks upstream PR state with gh.
apply replaces a pristine 0.7.0 install with the reviewed patched tarball.
verify exits non-zero unless the installed package matches the manifest fingerprint.
USAGE
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

sha256_file() {
  shasum -a 256 "$1" | cut -d ' ' -f 1
}

verify_repository_inputs() {
  node - "$MANIFEST" "$PATCH_DIR" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const manifestPath = process.argv[2];
const patchDir = process.argv[3];
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`error: cannot read Prime patch manifest: ${error.message}`);
  process.exit(1);
}
function requireValue(condition, message) {
  if (!condition) {
    console.error(`error: invalid Prime patch manifest: ${message}`);
    process.exit(1);
  }
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
requireValue(manifest.schemaVersion === 1, "schemaVersion must be 1");
requireValue(typeof manifest.upstreamRepository === "string", "upstreamRepository is required");
requireValue(typeof manifest.base?.version === "string", "base.version is required");
requireValue(/^[0-9a-f]{40}$/.test(manifest.base?.commit), "base.commit must be a full commit SHA");
requireValue(Array.isArray(manifest.patches) && manifest.patches.length > 0, "patches must not be empty");
const names = new Set();
for (const patch of manifest.patches) {
  requireValue(typeof patch.name === "string" && patch.name.length > 0, "every patch needs a name");
  requireValue(!names.has(patch.name), `duplicate patch name ${patch.name}`);
  names.add(patch.name);
  requireValue(typeof patch.file === "string" && path.basename(patch.file) === patch.file, `${patch.name} has an unsafe file name`);
  requireValue(typeof patch.fixes === "string" && /[.!?]$/.test(patch.fixes), `${patch.name} needs a plain sentence in fixes`);
  requireValue(patch.baseVersion === manifest.base.version, `${patch.name} baseVersion does not match base.version`);
  requireValue(["upstream-open", "local-only"].includes(patch.status), `${patch.name} has an invalid status`);
  requireValue(/^[0-9a-f]{40}$/.test(patch.sourceCommit), `${patch.name} needs a full sourceCommit SHA`);
  requireValue(typeof patch.upstreamBranch === "string" && patch.upstreamBranch.length > 0, `${patch.name} needs upstreamBranch`);
  if (patch.status === "upstream-open") {
    requireValue(Number.isInteger(patch.upstreamPrNumber), `${patch.name} needs upstreamPrNumber`);
    requireValue(typeof patch.upstreamPrUrl === "string", `${patch.name} needs upstreamPrUrl`);
  } else {
    requireValue(patch.upstreamPrNumber === null && patch.upstreamPrUrl === null, `${patch.name} local-only PR fields must be null`);
  }
  const patchPath = path.join(patchDir, patch.file);
  requireValue(fs.existsSync(patchPath), `${patch.file} is missing`);
  requireValue(sha256(patchPath) === patch.sha256, `${patch.file} SHA-256 does not match`);
}
const artifact = manifest.patchedArtifact;
requireValue(typeof artifact?.file === "string" && path.basename(artifact.file) === artifact.file, "patchedArtifact.file is invalid");
for (const key of ["sha256", "packageTreeSha256", "cliSha256"]) {
  requireValue(/^[0-9a-f]{64}$/.test(artifact?.[key]), `patchedArtifact.${key} must be a SHA-256`);
}
const artifactPath = path.join(patchDir, artifact.file);
requireValue(fs.existsSync(artifactPath), `${artifact.file} is missing`);
requireValue(sha256(artifactPath) === artifact.sha256, `${artifact.file} SHA-256 does not match`);
NODE
}

load_manifest() {
  local values
  values="$(node - "$MANIFEST" <<'NODE'
const fs = require("node:fs");
const m = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write([
  m.upstreamRepository,
  m.base.version,
  m.base.commit,
  m.base.pristinePackageTreeSha256,
  m.patchedArtifact.file,
  m.patchedArtifact.sha256,
  m.patchedArtifact.packageTreeSha256,
  m.patchedArtifact.cliSha256,
].join("\t"));
NODE
)"
  IFS=$'\t' read -r UPSTREAM_REPOSITORY BASE_VERSION BASE_COMMIT PRISTINE_TREE_SHA \
    PATCHED_ARTIFACT_FILE PATCHED_ARTIFACT_SHA PATCHED_TREE_SHA PATCHED_CLI_SHA <<<"$values"
  PATCHED_ARTIFACT="$PATCH_DIR/$PATCHED_ARTIFACT_FILE"
}

resolve_install_root() {
  if [[ -n "${PRIME_PATCH_NPM_PREFIX:-}" ]]; then
    local npm_root
    npm_root="$(npm root --global --prefix "$PRIME_PATCH_NPM_PREFIX")"
    printf '%s/prime-agent\n' "$npm_root"
    return
  fi
  if [[ -n "${PRIME_AGENT_ROOT:-}" ]]; then
    (cd "$PRIME_AGENT_ROOT" 2>/dev/null && pwd -P) || return 1
    return
  fi
  local binary="${PRIME_AGENT_BIN:-}"
  if [[ -z "$binary" ]]; then
    binary="$(command -v prime-agent || true)"
  fi
  [[ -n "$binary" ]] || return 1
  node - "$binary" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const entry = fs.realpathSync(process.argv[2]);
process.stdout.write(path.resolve(path.dirname(entry), "..", ".."));
NODE
}

installed_version() {
  node -p 'require(process.argv[1]).version' "$1/package.json" 2>/dev/null
}

package_tree_sha() {
  node - "$1" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const roots = ["dist", "docs", "examples", "skills"];
const files = ["postinstall.cjs", "CHANGELOG.md", "package.json"];
const entries = [];
function walk(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative.includes("/__pycache__/") || relative.endsWith(".pyc")) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) walk(absolute);
    else if (stat.isFile() || stat.isSymbolicLink()) entries.push(relative);
  }
}
try {
  for (const name of roots.sort()) walk(path.join(root, name));
  for (const name of files.sort()) entries.push(name);
  const hash = crypto.createHash("sha256");
  for (const relative of entries.sort()) {
    const absolute = path.join(root, relative);
    const symbolic = fs.lstatSync(absolute).isSymbolicLink();
    const data = symbolic ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
    hash.update(symbolic ? "L" : "F");
    hash.update(relative);
    hash.update("\0");
    hash.update(String(data.length));
    hash.update("\0");
    hash.update(data);
  }
  process.stdout.write(hash.digest("hex"));
} catch (error) {
  console.error(`error: cannot fingerprint Prime package tree: ${error.message}`);
  process.exit(1);
}
NODE
}

marker_is_valid() {
  local root="$1"
  local tree_sha="$2"
  node - "$MANIFEST" "$root/$MARKER_NAME" "$tree_sha" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const manifestPath = process.argv[2];
const markerPath = process.argv[3];
const treeSha = process.argv[4];
if (!fs.existsSync(markerPath)) process.exit(1);
try {
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const expectedPatches = manifest.patches.map(({ name, sha256 }) => ({ name, sha256 }));
  const valid = marker.schemaVersion === 1
    && marker.baseVersion === manifest.base.version
    && marker.baseCommit === manifest.base.commit
    && marker.manifestSha256 === crypto.createHash("sha256").update(manifestBytes).digest("hex")
    && marker.artifactSha256 === manifest.patchedArtifact.sha256
    && marker.packageTreeSha256 === treeSha
    && JSON.stringify(marker.patches) === JSON.stringify(expectedPatches);
  process.exit(valid ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

write_marker() {
  local root="$1"
  local tree_sha="$2"
  node - "$MANIFEST" "$root/$MARKER_NAME" "$tree_sha" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const manifestPath = process.argv[2];
const markerPath = process.argv[3];
const treeSha = process.argv[4];
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const marker = {
  schemaVersion: 1,
  baseVersion: manifest.base.version,
  baseCommit: manifest.base.commit,
  manifestSha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"),
  artifactSha256: manifest.patchedArtifact.sha256,
  packageTreeSha256: treeSha,
  patches: manifest.patches.map(({ name, sha256 }) => ({ name, sha256 })),
};
const temporary = `${markerPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
fs.renameSync(temporary, markerPath);
NODE
}

print_patch_rows() {
  node - "$MANIFEST" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const patch of manifest.patches) {
  console.log([
    patch.name,
    patch.fixes,
    patch.upstreamPrNumber ?? "-",
    patch.upstreamPrUrl ?? "-",
  ].join("\t"));
}
NODE
}

report_upstream() {
  local number="$1"
  local url="$2"
  if [[ "$number" == "-" ]]; then
    printf '    upstream: local-only (no PR)\n'
    return
  fi
  if ! command -v gh >/dev/null 2>&1; then
    printf '    upstream: unavailable (gh is not installed; %s)\n' "$url"
    return
  fi
  local result state merge_sha comparison
  if ! result="$(gh pr view "$number" --repo "$UPSTREAM_REPOSITORY" --json state,mergeCommit --jq '[.state,(.mergeCommit.oid // "-")] | @tsv' 2>/dev/null)"; then
    printf '    upstream: unavailable (gh query failed; %s)\n' "$url"
    return
  fi
  IFS=$'\t' read -r state merge_sha <<<"$result"
  if [[ "$state" != "MERGED" ]]; then
    printf '    upstream: %s (%s)\n' "$state" "$url"
    return
  fi
  comparison="$(gh api "repos/$UPSTREAM_REPOSITORY/compare/$merge_sha...$BASE_COMMIT" --jq .status 2>/dev/null || true)"
  if [[ "$comparison" == "ahead" || "$comparison" == "identical" ]]; then
    printf '    upstream: MERGED and included in pinned %s — REMOVABLE (%s)\n' "$BASE_VERSION" "$url"
  else
    printf '    upstream: MERGED but not included in pinned %s; keep until the pin advances (%s)\n' "$BASE_VERSION" "$url"
  fi
}

status_command() {
  local root version tree_sha install_state marker_state presence
  if ! root="$(resolve_install_root)" || [[ ! -f "$root/package.json" ]]; then
    fail "prime-agent install not found"
  fi
  version="$(installed_version "$root" || true)"
  tree_sha="$(package_tree_sha "$root")"
  if [[ "$version" != "$BASE_VERSION" ]]; then
    install_state="version-mismatch"
    presence="unknown"
  elif [[ "$tree_sha" == "$PATCHED_TREE_SHA" ]]; then
    install_state="patched"
    presence="present"
  elif [[ "$tree_sha" == "$PRISTINE_TREE_SHA" ]]; then
    install_state="pristine"
    presence="missing"
  else
    install_state="unknown/dirty"
    presence="unknown"
  fi
  if [[ -f "$root/$MARKER_NAME" ]]; then
    if marker_is_valid "$root" "$tree_sha"; then marker_state="matches manifest"; else marker_state="INVALID"; fi
  else
    marker_state="absent"
  fi
  printf 'prime-agent %s: %s\n' "${version:-<unknown>}" "$root"
  printf 'fingerprint: %s (%s)\n' "$install_state" "$tree_sha"
  printf 'marker: %s\n' "$marker_state"
  printf 'patches:\n'
  while IFS=$'\t' read -r name fixes number url; do
    printf '  %-8s %s — %s\n' "$presence" "$name" "$fixes"
    report_upstream "$number" "$url"
  done < <(print_patch_rows)
}

verify_command() {
  local root version tree_sha cli_sha
  if ! root="$(resolve_install_root)" || [[ ! -f "$root/package.json" ]]; then
    fail "prime-agent install not found"
  fi
  version="$(installed_version "$root" || true)"
  [[ "$version" == "$BASE_VERSION" ]] || fail "expected prime-agent $BASE_VERSION, got ${version:-<unknown>}"
  tree_sha="$(package_tree_sha "$root")"
  if [[ "$tree_sha" != "$PATCHED_TREE_SHA" ]]; then
    if [[ "$tree_sha" == "$PRISTINE_TREE_SHA" ]]; then
      fail "prime-agent $BASE_VERSION is pristine; the Deck patch set is missing"
    fi
    fail "prime-agent package tree is dirty or unknown (got $tree_sha, expected $PATCHED_TREE_SHA)"
  fi
  cli_sha="$(sha256_file "$root/dist/bundle/cli.js")"
  [[ "$cli_sha" == "$PATCHED_CLI_SHA" ]] || fail "patched CLI fingerprint mismatch"
  if [[ -f "$root/$MARKER_NAME" ]] && ! marker_is_valid "$root" "$tree_sha"; then
    fail "Prime patch marker does not match the manifest; run apply to refresh it"
  fi
  printf 'prime-agent %s patch set verified (%s)\n' "$BASE_VERSION" "$tree_sha"
}

apply_command() {
  local root version tree_sha npm_root installed_root
  if [[ -n "${PRIME_AGENT_BIN:-}" || -n "${PRIME_AGENT_ROOT:-}" ]]; then
    fail "apply does not accept PRIME_AGENT_BIN or PRIME_AGENT_ROOT; use PRIME_PATCH_NPM_PREFIX for a non-default install"
  fi
  if ! root="$(resolve_install_root)" || [[ ! -f "$root/package.json" ]]; then
    fail "prime-agent install not found; install the pinned pristine artifact before applying patches"
  fi
  version="$(installed_version "$root" || true)"
  [[ "$version" == "$BASE_VERSION" ]] || fail "refusing to patch prime-agent ${version:-<unknown>}; expected $BASE_VERSION"
  tree_sha="$(package_tree_sha "$root")"
  if [[ "$tree_sha" == "$PATCHED_TREE_SHA" ]]; then
    write_marker "$root" "$tree_sha"
    verify_command
    printf 'Prime patch set already applied; refreshed %s\n' "$root/$MARKER_NAME"
    return
  fi
  [[ "$tree_sha" == "$PRISTINE_TREE_SHA" ]] || fail "refusing to patch dirty or unknown Prime install (tree $tree_sha)"
  [[ "$(sha256_file "$PATCHED_ARTIFACT")" == "$PATCHED_ARTIFACT_SHA" ]] || fail "patched artifact SHA-256 mismatch"

  if [[ -n "${PRIME_PATCH_NPM_PREFIX:-}" ]]; then
    npm install --global --prefix "$PRIME_PATCH_NPM_PREFIX" "$PATCHED_ARTIFACT"
    npm_root="$(npm root --global --prefix "$PRIME_PATCH_NPM_PREFIX")"
  else
    npm_root="$(npm root --global)"
    installed_root="$npm_root/prime-agent"
    [[ "$installed_root" == "$root" ]] || fail "active npm prefix targets $installed_root, not installed Prime at $root"
    npm install --global "$PATCHED_ARTIFACT"
  fi
  root="$npm_root/prime-agent"
  [[ -f "$root/package.json" ]] || fail "npm did not produce $root"
  version="$(installed_version "$root" || true)"
  [[ "$version" == "$BASE_VERSION" ]] || fail "patched artifact installed unexpected version ${version:-<unknown>}"
  tree_sha="$(package_tree_sha "$root")"
  [[ "$tree_sha" == "$PATCHED_TREE_SHA" ]] || fail "installed patched artifact has unexpected tree $tree_sha"
  [[ "$(sha256_file "$root/dist/bundle/cli.js")" == "$PATCHED_CLI_SHA" ]] || fail "installed patched artifact has unexpected CLI fingerprint"
  write_marker "$root" "$tree_sha"
  verify_command
}

main() {
  [[ $# -eq 1 ]] || { usage >&2; exit 2; }
  require_command node
  require_command shasum
  verify_repository_inputs
  load_manifest
  case "$1" in
    status) status_command ;;
    apply)
      require_command npm
      apply_command
      ;;
    verify) verify_command ;;
    -h|--help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
