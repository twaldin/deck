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
requireValue(["pristine", "patched"].includes(manifest.expectedInstallState), "expectedInstallState must be pristine or patched");
requireValue(typeof manifest.base?.version === "string", "base.version is required");
requireValue(/^[0-9a-f]{40}$/.test(manifest.base?.commit), "base.commit must be a full commit SHA");
for (const key of ["artifactSha256", "pristinePackageTreeSha256", "cliSha256"]) {
  requireValue(/^[0-9a-f]{64}$/.test(manifest.base?.[key]), `base.${key} must be a SHA-256`);
}
requireValue(Array.isArray(manifest.patches) && manifest.patches.length > 0, "patches must not be empty");
const names = new Set();
for (const patch of manifest.patches) {
  requireValue(typeof patch.name === "string" && patch.name.length > 0, "every patch needs a name");
  requireValue(!names.has(patch.name), `duplicate patch name ${patch.name}`);
  names.add(patch.name);
  requireValue(typeof patch.file === "string" && path.basename(patch.file) === patch.file, `${patch.name} has an unsafe file name`);
  requireValue(typeof patch.fixes === "string" && /[.!?]$/.test(patch.fixes), `${patch.name} needs a plain sentence in fixes`);
  requireValue(patch.baseVersion === manifest.base.version, `${patch.name} baseVersion does not match base.version`);
  requireValue(patch.application === "not-applied", `${patch.name} application must be not-applied`);
  const detection = patch.installedDetection;
  requireValue(
    typeof detection?.file === "string"
      && !path.isAbsolute(detection.file)
      && !detection.file.split(/[\\/]/).includes(".."),
    `${patch.name} installedDetection.file is unsafe`,
  );
  requireValue(/^[0-9a-f]{64}$/.test(detection?.pristineSha256), `${patch.name} needs installedDetection.pristineSha256`);
  requireValue(/^[0-9a-f]{64}$/.test(detection?.patchedSha256), `${patch.name} needs installedDetection.patchedSha256`);
  requireValue(typeof detection?.bundleNeedle === "string" && detection.bundleNeedle.length > 0, `${patch.name} needs installedDetection.bundleNeedle`);
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
  m.expectedInstallState,
  m.base.version,
  m.base.commit,
  m.base.pristinePackageTreeSha256,
  m.base.cliSha256,
  m.patchedArtifact.file,
  m.patchedArtifact.sha256,
  m.patchedArtifact.packageTreeSha256,
  m.patchedArtifact.cliSha256,
].join("\t"));
NODE
)"
  IFS=$'\t' read -r UPSTREAM_REPOSITORY EXPECTED_INSTALL_STATE BASE_VERSION BASE_COMMIT PRISTINE_TREE_SHA \
    PRISTINE_CLI_SHA PATCHED_ARTIFACT_FILE PATCHED_ARTIFACT_SHA PATCHED_TREE_SHA PATCHED_CLI_SHA <<<"$values"
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
  if [[ "$binary" != */* ]]; then
    binary="$(command -v "$binary" || true)"
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
  node - "$1" "$MARKER_NAME" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const markerName = process.argv[3];
const roots = ["dist", "docs", "examples", "skills"];
const files = ["postinstall.cjs", "CHANGELOG.md", "README.md", "package.json"];
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
  const allowedRootEntries = new Set([...roots, ...files, "node_modules", markerName]);
  for (const name of fs.readdirSync(root)) {
    if (!allowedRootEntries.has(name)) throw new Error(`unexpected package-root entry: ${name}`);
  }
  for (const name of roots.sort()) {
    const absolute = path.join(root, name);
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${name} is not a real directory`);
    walk(absolute);
  }
  for (const name of files.sort()) {
    const stat = fs.lstatSync(path.join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
    entries.push(name);
  }
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
  local root="$1"
  node - "$MANIFEST" "$root" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = process.argv[3];
const bundleDir = path.join(root, "dist", "bundle");
let bundleText = "";
try {
  bundleText = fs.readdirSync(bundleDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => fs.readFileSync(path.join(bundleDir, name), "utf8"))
    .join("\\n");
} catch {}
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const patch of manifest.patches) {
  const detection = patch.installedDetection;
  let fileSha = "";
  try {
    fileSha = sha256(path.join(root, detection.file));
  } catch {}
  const bundlePresent = bundleText.includes(detection.bundleNeedle);
  let presence = "unknown";
  if (fileSha === detection.patchedSha256 && bundlePresent) presence = "present";
  else if (fileSha === detection.pristineSha256 && !bundlePresent) presence = "missing";
  console.log([
    presence,
    patch.application,
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
  if ! comparison="$(gh api "repos/$UPSTREAM_REPOSITORY/compare/$merge_sha...$BASE_COMMIT" --jq .status 2>/dev/null)"; then
    printf '    upstream: MERGED; inclusion in pinned %s unavailable (gh comparison failed; %s)\n' "$BASE_VERSION" "$url"
  elif [[ "$comparison" == "ahead" || "$comparison" == "identical" ]]; then
    printf '    upstream: MERGED and included in pinned %s — REMOVABLE (%s)\n' "$BASE_VERSION" "$url"
  else
    printf '    upstream: MERGED but not included in pinned %s; keep until the pin advances (%s)\n' "$BASE_VERSION" "$url"
  fi
}

status_command() {
  local root version tree_sha install_state marker_state row_presence application name fixes number url
  if ! root="$(resolve_install_root)" || [[ ! -f "$root/package.json" ]]; then
    fail "prime-agent install not found"
  fi
  version="$(installed_version "$root" || true)"
  tree_sha="$(package_tree_sha "$root")"
  if [[ "$version" != "$BASE_VERSION" ]]; then
    install_state="version-mismatch"
  elif [[ "$tree_sha" == "$PATCHED_TREE_SHA" ]]; then
    install_state="patched"
  elif [[ "$tree_sha" == "$PRISTINE_TREE_SHA" ]]; then
    install_state="pristine"
  else
    install_state="unknown/dirty"
  fi
  if [[ -f "$root/$MARKER_NAME" ]]; then
    if marker_is_valid "$root" "$tree_sha"; then marker_state="matches manifest"; else marker_state="INVALID"; fi
  else
    marker_state="absent"
  fi
  printf 'prime-agent %s: %s\n' "${version:-<unknown>}" "$root"
  printf 'fingerprint: %s (%s)\n' "$install_state" "$tree_sha"
  printf 'expected: %s\n' "$EXPECTED_INSTALL_STATE"
  printf 'marker: %s\n' "$marker_state"
  printf 'patches:\n'
  while IFS=$'\t' read -r row_presence application name fixes number url; do
    if [[ "$version" != "$BASE_VERSION" ]]; then row_presence="unknown"; fi
    printf '  %-8s %s (expected %s) — %s\n' "$row_presence" "$name" "$application" "$fixes"
    report_upstream "$number" "$url"
  done < <(print_patch_rows "$root")
}

verify_command() {
  local root version tree_sha cli_sha expected_tree expected_cli
  if ! root="$(resolve_install_root)" || [[ ! -f "$root/package.json" ]]; then
    fail "prime-agent install not found"
  fi
  version="$(installed_version "$root" || true)"
  [[ "$version" == "$BASE_VERSION" ]] || fail "expected prime-agent $BASE_VERSION, got ${version:-<unknown>}"
  [[ -x "$root/dist/bundle/cli.js" ]] || fail "prime-agent CLI is missing or not executable"
  if [[ "$EXPECTED_INSTALL_STATE" == "pristine" ]]; then
    expected_tree="$PRISTINE_TREE_SHA"
    expected_cli="$PRISTINE_CLI_SHA"
  else
    expected_tree="$PATCHED_TREE_SHA"
    expected_cli="$PATCHED_CLI_SHA"
  fi
  tree_sha="$(package_tree_sha "$root")"
  [[ "$tree_sha" == "$expected_tree" ]] || fail "manifest expects $EXPECTED_INSTALL_STATE prime-agent, got package tree $tree_sha"
  cli_sha="$(sha256_file "$root/dist/bundle/cli.js")"
  [[ "$cli_sha" == "$expected_cli" ]] || fail "$EXPECTED_INSTALL_STATE CLI fingerprint mismatch"
  if [[ -f "$root/$MARKER_NAME" ]] && ! marker_is_valid "$root" "$tree_sha"; then
    fail "Prime patch marker does not match the manifest; run apply to refresh it"
  fi
  printf 'prime-agent %s %s install verified (%s)\n' "$BASE_VERSION" "$EXPECTED_INSTALL_STATE" "$tree_sha"
}

apply_command() {
  local root version tree_sha npm_root installed_root unpack_root unpacked_root entry
  [[ "$EXPECTED_INSTALL_STATE" == "patched" ]] || fail "manifest expects a pristine install; refusing to apply patches until expectedInstallState is changed to patched"
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
    npm_root="$(npm root --global --prefix "$PRIME_PATCH_NPM_PREFIX")"
  else
    npm_root="$(npm root --global)"
    installed_root="$npm_root/prime-agent"
    [[ "$installed_root" == "$root" ]] || fail "active npm prefix targets $installed_root, not installed Prime at $root"
  fi
  root="$npm_root/prime-agent"
  [[ -f "$root/package.json" ]] || fail "npm prefix does not contain $root"

  unpack_root="$(mktemp -d "${TMPDIR:-/tmp}/deck-prime-patches.XXXXXX")"
  if ! tar -xzf "$PATCHED_ARTIFACT" -C "$unpack_root"; then
    rm -rf "$unpack_root"
    fail "could not unpack patched artifact"
  fi
  unpacked_root="$unpack_root/package"
  [[ -f "$unpacked_root/package.json" ]] || { rm -rf "$unpack_root"; fail "patched artifact has no package root"; }
  [[ "$(package_tree_sha "$unpacked_root")" == "$PATCHED_TREE_SHA" ]] || { rm -rf "$unpack_root"; fail "unpacked artifact tree fingerprint mismatch"; }
  [[ -x "$unpacked_root/dist/bundle/cli.js" ]] || { rm -rf "$unpack_root"; fail "unpacked artifact CLI is not executable"; }
  [[ "$(sha256_file "$unpacked_root/dist/bundle/cli.js")" == "$PATCHED_CLI_SHA" ]] || { rm -rf "$unpack_root"; fail "unpacked artifact CLI fingerprint mismatch"; }

  for entry in dist docs examples skills postinstall.cjs CHANGELOG.md README.md package.json; do
    rm -rf "${root:?}/$entry"
  done
  if ! tar -xzf "$PATCHED_ARTIFACT" --strip-components=1 -C "$root"; then
    rm -rf "$unpack_root"
    fail "could not overlay patched artifact"
  fi
  rm -rf "$unpack_root"
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
      require_command tar
      apply_command
      ;;
    verify) verify_command ;;
    -h|--help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
