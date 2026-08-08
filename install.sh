#!/usr/bin/env bash
set -euo pipefail

# Deck-home bootstrap. Run once from a clone; use update.sh for later updates.
# Never copies secrets, starts resident services, or starts the review gate.

if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  FILE_INSTALL=true
else
  # piped curl | bash — preflight, clone, then re-exec from the clone
  REPO="${DECK_REPO:-$HOME/dev/deck}"
  FILE_INSTALL=false
fi
if [ "$FILE_INSTALL" != true ] && [ ! -d "$REPO/.git" ]; then
  if [ -z "${DECK_REPO_URL:-}" ] ||
    [[ "$DECK_REPO_URL" == *"<owner>"* || "$DECK_REPO_URL" == *"OWNER"* ]]; then
    printf 'error: set DECK_REPO_URL to your deck repository URL\n' >&2
    exit 1
  fi
fi

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

BIN_TARGET="${BIN_TARGET:-$HOME/.local/bin}"
PRIME_RUNTIME="$HOME/.deck/.prime/runtime"
PRIME_AGENT_TARGET="$PRIME_RUNTIME/bin/prime-agent"
PRIME_CONVERSATION_TARGET="$HOME/.deck/.prime/bin/prime-conversation"
for link_spec in \
  "$BIN_TARGET/prime-agent|$PRIME_AGENT_TARGET" \
  "$BIN_TARGET/prime-conversation|$PRIME_CONVERSATION_TARGET"; do
  link="${link_spec%%|*}"
  expected="${link_spec#*|}"
  if { [ -e "$link" ] || [ -L "$link" ]; } &&
    { [ ! -L "$link" ] || [ "$(readlink "$link")" != "$expected" ]; }; then
    printf 'error: %s already exists and is not Deck'\''s managed Prime command; no changes were made.\n' "$link" >&2
    printf 'Keep it and install Deck commands in a separate directory:\n' >&2
    if [ "$FILE_INSTALL" = true ] || [ -f "$REPO/install.sh" ]; then
      printf '  BIN_TARGET=%q bash %q\n' "$HOME/.local/deck-bin" "$REPO/install.sh" >&2
    else
      printf '  git clone %q %q && BIN_TARGET=%q bash %q\n' \
        "$DECK_REPO_URL" "$REPO" "$HOME/.local/deck-bin" "$REPO/install.sh" >&2
    fi
    exit 1
  fi
done

if [ "$FILE_INSTALL" != true ]; then
  if [ ! -d "$REPO/.git" ]; then
    command -v git >/dev/null || fail "git is required"
    git clone "$DECK_REPO_URL" "$REPO"
  fi
  git -C "$REPO" fetch origin main
  git -C "$REPO" checkout main
  git -C "$REPO" pull --ff-only origin main
  exec bash "$REPO/install.sh"
fi

UV_VERSION="0.11.8"
UV_BIN="$(command -v uv || true)"
UV_TMP=""
UV_STAGE=""
UV_PUBLISHED_UV=false
UV_PUBLISHED_UVX=false
cleanup_uv() {
  if [ -n "$UV_TMP" ]; then rm -rf "$UV_TMP"; fi
  if [ "$UV_PUBLISHED_UV" = true ] && [ -e "$UV_STAGE/uv" ] &&
    [ "$UV_STAGE/uv" -ef "$BIN_TARGET/uv" ]; then
    rm -f "$BIN_TARGET/uv"
  fi
  if [ "$UV_PUBLISHED_UVX" = true ] && [ -e "$UV_STAGE/uvx" ] &&
    [ "$UV_STAGE/uvx" -ef "$BIN_TARGET/uvx" ]; then
    rm -f "$BIN_TARGET/uvx"
  fi
  if [ -n "$UV_STAGE" ]; then rm -rf "$UV_STAGE"; fi
}
trap cleanup_uv EXIT INT TERM

install_uv() {
  local asset checksum platform extracted archive actual libc_probe staged_version tool
  case "$(uname -s)" in
    Darwin) platform="Darwin-$(uname -m)" ;;
    Linux)
      if command -v getconf >/dev/null 2>&1 &&
        getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
        platform="Linux-gnu-$(uname -m)"
      else
        libc_probe="$(ldd --version 2>&1 || true)"
        case "$libc_probe" in
          *musl*|*Musl*|*MUSL*) platform="Linux-musl-$(uname -m)" ;;
          *) platform="Linux-unknown-$(uname -m)" ;;
        esac
      fi
      ;;
    *) platform="$(uname -s)-$(uname -m)" ;;
  esac
  case "$platform" in
    Darwin-arm64)
      asset="uv-aarch64-apple-darwin.tar.gz"
      checksum="c729adb365114e844dd7f9316313a7ed6443b89bb5681d409eebac78b0bd06c8"
      ;;
    Darwin-x86_64)
      asset="uv-x86_64-apple-darwin.tar.gz"
      checksum="c59d73bf34b58bc8e33a11629f7a255c11789fd00f03cd3e68ab2d1603645de9"
      ;;
    Linux-gnu-aarch64|Linux-gnu-arm64)
      asset="uv-aarch64-unknown-linux-gnu.tar.gz"
      checksum="eee8dd658d20e5ac85fec9c2326b6cbc9d83a1eef09ef07433e58698ac849591"
      ;;
    Linux-gnu-x86_64)
      asset="uv-x86_64-unknown-linux-gnu.tar.gz"
      # This is the same published artifact checksum pinned in CI.
      checksum="56dd1b66701ecb62fe896abb919444e4b83c5e8645cca953e6ddd496ff8a0feb"
      ;;
    Linux-musl-aarch64|Linux-musl-arm64)
      asset="uv-aarch64-unknown-linux-musl.tar.gz"
      checksum="29418befb64f926a2dba3473e8e69acd00b36fb845d85344ef11321a993ad8f5"
      ;;
    Linux-musl-x86_64)
      asset="uv-x86_64-unknown-linux-musl.tar.gz"
      checksum="de82507d12e31cfc86c1c776238f7c248e48e40d996dedc812d64fdd31c6ed12"
      ;;
    *)
      printf 'error: automatic uv %s installation does not support %s.\n' "$UV_VERSION" "$platform" >&2
      printf 'Install the same pinned version, then re-run Deck:\n' >&2
      printf '  curl -LsSf https://astral.sh/uv/%s/install.sh | env UV_INSTALL_DIR=%q sh\n' \
        "$UV_VERSION" "$BIN_TARGET" >&2
      exit 1
      ;;
  esac

  if [ -e "$BIN_TARGET/uvx" ] || [ -L "$BIN_TARGET/uvx" ]; then
    fail "$BIN_TARGET/uvx already exists; refusing to overwrite it while installing uv"
  fi
  mkdir -p "$BIN_TARGET"
  UV_TMP="$(mktemp -d "${TMPDIR:-/tmp}/deck-uv.XXXXXX")" ||
    fail "could not create a temporary directory for uv"
  archive="$UV_TMP/$asset"
  printf 'installing pinned uv %s for %s...\n' "$UV_VERSION" "$platform"
  if ! curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$asset" -o "$archive"; then
    fail "could not download uv $UV_VERSION; check network access and re-run $REPO/install.sh"
  fi
  actual="$(python3 - "$archive" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as archive:
    for chunk in iter(lambda: archive.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
)"
  if [ "$actual" != "$checksum" ]; then
    fail "uv $UV_VERSION checksum mismatch for $asset (expected $checksum, got $actual)"
  fi
  if ! tar -xzf "$archive" -C "$UV_TMP"; then
    fail "could not extract verified uv archive $asset"
  fi
  extracted="$UV_TMP/${asset%.tar.gz}"
  UV_STAGE="$(mktemp -d "$BIN_TARGET/.deck-uv.XXXXXX")" ||
    fail "could not stage uv atomically in $BIN_TARGET"
  for tool in uv uvx; do
    [ -f "$extracted/$tool" ] || fail "verified uv archive is missing $tool"
    cp "$extracted/$tool" "$UV_STAGE/$tool"
    chmod 0755 "$UV_STAGE/$tool"
  done
  if ! staged_version="$("$UV_STAGE/uv" --version 2>&1)"; then
    fail "verified uv $UV_VERSION binary cannot run: $staged_version"
  fi
  set -- $staged_version
  if [ "${1:-}" != uv ] || [ "${2:-}" != "$UV_VERSION" ]; then
    fail "verified uv archive reported ${staged_version:-no version}, expected uv $UV_VERSION"
  fi

  UV_PUBLISHED_UVX=true
  ln "$UV_STAGE/uvx" "$BIN_TARGET/uvx"
  UV_PUBLISHED_UV=true
  ln "$UV_STAGE/uv" "$BIN_TARGET/uv"
  UV_PUBLISHED_UV=false
  UV_PUBLISHED_UVX=false
  rm -rf "$UV_STAGE"
  UV_STAGE=""
  UV_BIN="$BIN_TARGET/uv"
  rm -rf "$UV_TMP"
  UV_TMP=""
  printf 'installed uv and uvx %s at %s (published SHA-256 verified)\n' "$UV_VERSION" "$BIN_TARGET"
}

for prerequisite in bun curl git grep python3 tar; do
  command -v "$prerequisite" >/dev/null || fail "$prerequisite is required"
done

if [ -z "$UV_BIN" ] && [ -x "$BIN_TARGET/uv" ]; then
  UV_BIN="$BIN_TARGET/uv"
fi
if [ -z "$UV_BIN" ]; then
  if [ -e "$BIN_TARGET/uv" ] || [ -L "$BIN_TARGET/uv" ]; then
    fail "$BIN_TARGET/uv exists but is not executable; refusing to overwrite it"
  fi
  install_uv
fi
if [ "$UV_BIN" = "$BIN_TARGET/uv" ] && [ ! -x "$BIN_TARGET/uvx" ]; then
  partial_stamp="$(date +%Y%m%d%H%M%S)"
  printf 'error: partial Deck uv install: %s exists without executable %s.\n' \
    "$UV_BIN" "$BIN_TARGET/uvx" >&2
  printf 'Move the partial entries aside and re-run:\n  mv %q %q\n' \
    "$UV_BIN" "$BIN_TARGET/uv.partial-$partial_stamp" >&2
  if [ -e "$BIN_TARGET/uvx" ] || [ -L "$BIN_TARGET/uvx" ]; then
    printf '  mv %q %q\n' "$BIN_TARGET/uvx" "$BIN_TARGET/uvx.partial-$partial_stamp" >&2
  fi
  printf '  bash %q\n' "$REPO/install.sh" >&2
  exit 1
fi
if ! UV_DESCRIPTION="$("$UV_BIN" --version 2>&1)"; then
  fail "uv at $UV_BIN cannot run: $UV_DESCRIPTION"
fi
printf 'using %s at %s\n' "$UV_DESCRIPTION" "$UV_BIN"
export PATH="$BIN_TARGET:$PATH"

printf 'verifying isolated IPython kernel execution...\n'
if ! "$UV_BIN" run --isolated --no-project --python 3.11 --with ipykernel python -I - <<'PY'
import sys

from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpec

kernel = KernelManager(kernel_name="")
kernel._kernel_spec = KernelSpec(
    argv=[
        sys.executable,
        "-I",
        "-m",
        "ipykernel_launcher",
        "-f",
        "{connection_file}",
    ],
    display_name="Deck install verification",
    language="python",
    env={},
)
client = None
try:
    kernel.start_kernel()
    client = kernel.client()
    client.start_channels()
    client.wait_for_ready(timeout=30)
    message_id = client.execute("import sys; print(sys.executable)")
    observed = False
    while True:
        message = client.get_iopub_msg(timeout=30)
        if message.get("parent_header", {}).get("msg_id") != message_id:
            continue
        message_type = message["header"]["msg_type"]
        if (
            message_type == "stream"
            and message["content"].get("text", "").strip() == sys.executable
        ):
            observed = True
        if message_type == "status" and message["content"].get("execution_state") == "idle":
            break
    if not observed:
        raise RuntimeError("kernel did not execute with the uv-managed Python")
finally:
    try:
        if client is not None:
            client.stop_channels()
    finally:
        if kernel.has_kernel:
            kernel.shutdown_kernel(now=True)
PY
then
  printf 'error: uv is present, but Deck could not bootstrap and execute an isolated IPython kernel.\n' >&2
  printf 'Prime seats would start without working tools; Deck home setup did not start.\n' >&2
  printf 'Fix the reported Python or network error, then re-run:\n  bash %q\n' "$REPO/install.sh" >&2
  exit 1
fi
printf 'verified isolated IPython kernel execution with %s\n' "$UV_DESCRIPTION"

bun install --frozen-lockfile --cwd "$REPO/v2"
bun install --frozen-lockfile --cwd "$REPO/broker"
bun install --frozen-lockfile --cwd "$REPO/cli"
for prerequisite in node npm shasum tar; do
  command -v "$prerequisite" >/dev/null 2>&1 || fail "$prerequisite is required"
done
NODE_BIN_DIR="$(dirname "$(command -v node)")"
PRIME_DAEMON_SOCKET="$(node - "$REPO/ops/prime-deck-profile.json" "$HOME/.deck" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [profilePath, deckHome] = process.argv.slice(2);
const relative = JSON.parse(fs.readFileSync(profilePath, "utf8")).daemonSocketRelative;
if (
  typeof relative !== "string" ||
  relative.length === 0 ||
  path.isAbsolute(relative) ||
  relative.split(/[\\/]/).includes("..")
) process.exit(1);
process.stdout.write(path.join(deckHome, relative));
NODE
)" || fail "invalid Deck Prime daemon socket contract"
# Directories holding the tools a seat needs: uv for the kernel, plus the CLIs
# the agent is prompted to use. Resolved here so both the daemon below and the
# conversation wrapper start from the same set.
SEAT_TOOL_DIRS="$HOME/.local/bin:/usr/local/bin"
if SEAT_UV_BIN="$(command -v uv)"; then
  SEAT_TOOL_DIRS="$(dirname "$SEAT_UV_BIN"):$SEAT_TOOL_DIRS"
fi
if SEAT_BREW_PREFIX="$(brew --prefix 2>/dev/null)"; then
  SEAT_TOOL_DIRS="$SEAT_BREW_PREFIX/bin:$SEAT_BREW_PREFIX/sbin:$SEAT_TOOL_DIRS"
fi
SEAT_TOOL_DIRS="$(printf '%s' "$SEAT_TOOL_DIRS" | awk -v RS=: '!seen[$0]++ && $0 != "" { printf "%s%s", sep, $0; sep=":" }')"

# The daemon spawns every seat's IPython kernel, so its PATH - not the
# wrapper's - is what the kernel actually inherits. This list omitted the uv
# directory, so seats reported "uv is required to set up the Python kernel"
# and had no code execution, no matter what the launcher exported. Measured on
# a live orchestrator after the wrapper was already correct.
PRIME_DAEMON_ENV=(
  "HOME=$HOME"
  # Managed dirs first so the kernel always finds uv and the deck CLIs, then
  # the caller's own PATH: a hand-written list kept losing tools, and each
  # hole cost total capability (no uv meant no code execution at all).
  "PATH=$NODE_BIN_DIR:$PRIME_RUNTIME/bin:$SEAT_TOOL_DIRS:$PATH"
  "PRIME_AGENT_CODING_AGENT_DIR=$HOME/.deck/.prime/agent"
  "PRIME_AGENT_SESSION_DIR=$HOME/.deck/.prime/sessions"
  # The kernel is spawned by the daemon, so the code surface reaches the agent
  # only if it is here too. Exporting it from the launcher is not enough:
  # observed as `ModuleNotFoundError: No module named 'deck'` in a live seat
  # that had otherwise started cleanly, leaving the orchestrator with no
  # factory access at all.
  "PYTHONPATH=$HOME/.deck/.prime/python"
  "IPYTHONDIR=$HOME/.deck/.prime/ipython"
  "DECK_V2_HOME=$HOME/.deck"
)
for allowed_name in TMPDIR TMP TEMP DECK_GATEWAY_ORIGIN DECK_PRIME_MAX_TOKENS; do
  if [ -n "${!allowed_name+x}" ]; then
    PRIME_DAEMON_ENV+=("$allowed_name=${!allowed_name}")
  fi
done

prime_daemon_is_live() {
  node - "$PRIME_DAEMON_SOCKET" <<'NODE'
const net = require("node:net");
const socket = net.createConnection(process.argv[2]);
const timer = setTimeout(() => { socket.destroy(); process.exit(1); }, 250);
socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(0); });
socket.once("error", () => { clearTimeout(timer); process.exit(1); });
NODE
}
prime_daemon_request() {
  local request_type="$1"
  local daemon_module_root="$PRIME_RUNTIME/lib/node_modules/prime-agent/dist/modes/daemon"
  local client_module="$daemon_module_root/daemon-client.js"
  local ownership_module="$daemon_module_root/daemon-supervisor-ownership.js"
  [ -f "$client_module" ] ||
    fail "managed Prime runtime cannot control its daemon: missing $client_module"
  [ -f "$ownership_module" ] ||
    fail "managed Prime runtime cannot fence its daemon restart: missing $ownership_module"
  env -i "${PRIME_DAEMON_ENV[@]}" "$NODE_BIN_DIR/node" --input-type=module - \
    "$client_module" "$ownership_module" "$PRIME_DAEMON_SOCKET" "$request_type" <<'NODE'
import { pathToFileURL } from "node:url";
const [clientModule, ownershipModule, socketPath, requestType] = process.argv.slice(2);
const { DaemonClient } = await import(pathToFileURL(clientModule).href);
const client = new DaemonClient(socketPath);
try {
  await client.connect();
  const hello = await client.waitForHello();
  if (requestType !== "drain") throw new Error(`unsupported daemon request: ${requestType}`);
  const prepared = await client.request({ type: "prepare_update_restart" }, 120_000);
  if (prepared.success !== true) {
    throw new Error(prepared.error ?? "prepare_update_restart failed");
  }
  const { persistDaemonStartupFenceFromOwner } =
    await import(pathToFileURL(ownershipModule).href);
  await persistDaemonStartupFenceFromOwner(socketPath, hello);
  const stopped = await client.request({ type: "shutdown", force: false }, 10_000);
  if (stopped.success !== true) throw new Error(stopped.error ?? "shutdown failed");
  process.stdout.write(JSON.stringify(prepared.data ?? {}));
} finally {
  client.close();
}
NODE
}


wait_for_prime_daemon() {
  local expected="$1"
  node - "$PRIME_DAEMON_SOCKET" "$expected" <<'NODE'
const net = require("node:net");
const [socketPath, expected] = process.argv.slice(2);
const deadline = Date.now() + 15_000;
function probe() {
  const socket = net.createConnection(socketPath);
  const timer = setTimeout(() => {
    socket.destroy();
    retry();
  }, 200);
  socket.once("connect", () => {
    clearTimeout(timer);
    socket.destroy();
    if (expected === "up") process.exit(0);
    retry();
  });
  socket.once("error", () => {
    clearTimeout(timer);
    if (expected === "down") process.exit(0);
    retry();
  });
}
function retry() {
  if (Date.now() >= deadline) process.exit(1);
  setTimeout(probe, 100);
}
probe();
NODE
}

PRIME_DAEMON_WAS_LIVE=false
if prime_daemon_is_live; then
  PRIME_DAEMON_WAS_LIVE=true
  [ -x "$PRIME_AGENT_TARGET" ] ||
    fail "a Deck Prime daemon is live but its managed executable is missing"
  PRIME_AGENT_BIN="$PRIME_AGENT_TARGET" "$REPO/ops/prime-patches.sh" verify >/dev/null ||
    fail "the existing Deck Prime runtime failed integrity verification; no daemon command was sent"
  printf 'draining Deck Prime daemon at %s; in-flight work will finish its checkpoint first...\n' \
    "$PRIME_DAEMON_SOCKET"
  prime_daemon_request drain >/dev/null ||
    fail "could not safely prepare and drain the existing Deck Prime daemon"
  wait_for_prime_daemon down ||
    fail "existing Deck Prime daemon did not finish its graceful shutdown"
fi


IFS=$'\t' read -r PRIME_VERSION PRIME_ARTIFACT_URL PRIME_ARTIFACT_SHA256 <<EOF
$(node - "$REPO/patches/prime-agent/manifest.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write([
  manifest.base.version,
  manifest.base.artifactUrl,
  manifest.base.artifactSha256,
].join("\t"));
NODE
)
EOF
PRIME_CACHE_DIR="$HOME/.deck/.prime/cache"
PRIME_ARTIFACT="$PRIME_CACHE_DIR/prime-agent-$PRIME_VERSION.tgz"
mkdir -p "$PRIME_CACHE_DIR" "$PRIME_RUNTIME"
chmod 700 "$HOME/.deck/.prime" "$PRIME_CACHE_DIR" "$PRIME_RUNTIME"
if ! PRIME_AGENT_BIN="$PRIME_AGENT_TARGET" "$REPO/ops/prime-patches.sh" verify >/dev/null 2>&1; then
  artifact_tmp="$PRIME_ARTIFACT.tmp.$$"
  curl -fsSL "$PRIME_ARTIFACT_URL" -o "$artifact_tmp"
  [ "$(shasum -a 256 "$artifact_tmp" | cut -d ' ' -f 1)" = "$PRIME_ARTIFACT_SHA256" ] ||
    fail "downloaded Prime Agent $PRIME_VERSION failed its SHA-256 check"
  mv -f "$artifact_tmp" "$PRIME_ARTIFACT"
  rm -rf "$PRIME_RUNTIME/lib/node_modules/prime-agent" "$PRIME_RUNTIME/bin/prime-agent"
  npm install --global --prefix "$PRIME_RUNTIME" "$PRIME_ARTIFACT"
  # The manifest expects the patched tree, so a freshly unpacked pristine
  # install must be brought up to it through the reviewed artifact. `apply`
  # checks the tarball hashes, overlays it, writes the marker, and verifies.
  PRIME_PATCH_NPM_PREFIX="$PRIME_RUNTIME" "$REPO/ops/prime-patches.sh" apply ||
    fail "could not apply the reviewed Prime patch artifact"
fi
PRIME_AGENT_BIN="$PRIME_AGENT_TARGET" "$REPO/ops/prime-patches.sh" verify
npm install --global --prefix "$PRIME_RUNTIME" "@aliou/pi-processes@0.10.4"
PROCESS_PACKAGE_SOURCE="$PRIME_RUNTIME/lib/node_modules/@aliou/pi-processes"
process_identity="$(node -e 'const p=require(process.argv[1]); process.stdout.write(`${p.name}@${p.version}`)' "$PROCESS_PACKAGE_SOURCE/package.json")"
[ "$process_identity" = "@aliou/pi-processes@0.10.4" ] ||
  fail "conversation process package mismatch: $process_identity"
mkdir -p "$BIN_TARGET"
ln -sfn "$PRIME_AGENT_TARGET" "$BIN_TARGET/prime-agent"


bun "$REPO/v2/bin/deck-v2" bootstrap
bash "$REPO/v2/install.sh"


PRIME_CONVERSATION_HOME="$HOME/.deck" \
PRIME_CONVERSATION_PRIME_BIN="$PRIME_AGENT_TARGET" \
PRIME_CONVERSATION_PROCESS_PACKAGE_SOURCE="$PROCESS_PACKAGE_SOURCE" \
  bash "$REPO/ops/install-prime-conversation.sh" --apply
ln -sfn "$PRIME_CONVERSATION_TARGET" "$BIN_TARGET/prime-conversation"

if [ "$PRIME_DAEMON_WAS_LIVE" = true ]; then
  daemon_log="$HOME/.deck/.prime/agent/logs/install-restart.log"
  mkdir -p "$(dirname "$daemon_log")" "$(dirname "$PRIME_DAEMON_SOCKET")" "$HOME/.deck/.prime/sessions"
  env -i "${PRIME_DAEMON_ENV[@]}" \
    "$PRIME_AGENT_TARGET" --mode daemon --daemon-socket "$PRIME_DAEMON_SOCKET" \
    </dev/null >>"$daemon_log" 2>&1 &
  wait_for_prime_daemon up ||
    fail "converged Deck Prime daemon did not restart; inspect $daemon_log"
fi
if [ -n "${DECK_HOME_PROFILE:-}" ]; then
  case "$DECK_HOME_PROFILE" in
    full|personal) printf '%s\n' "$DECK_HOME_PROFILE" > "$HOME/.deck/.deck-profile"; chmod 600 "$HOME/.deck/.deck-profile" ;;
    *) echo "error: DECK_HOME_PROFILE must be full or personal" >&2; exit 1 ;;
  esac
else
  echo "Home sync is disabled until DECK_HOME_PROFILE is set to full or personal."
fi

# Prime conversation entrypoint and inbox.
mkdir -p "$HOME/.deck/data/inbox"
ENTER="$HOME/.deck/enter.sh"
# The IPython kernel bootstraps through `uv`, and `prime-conversation` forwards
# only the caller's PATH. A pane whose shell lacks the uv directory therefore
# produces a seat with NO code execution at all: no memo wake, no deck import,
# no file reads - it can only report that it is broken. Observed on a real
# orchestrator start. Pin the resolved uv directory so the seat never depends
# on how its terminal happened to be launched.
UV_BIN_DIR="$(dirname "$(command -v uv)")"
printf '#!/usr/bin/env bash\nexport PATH=%q%q"$HOME/.bun/bin:$PATH"\n' "$BIN_TARGET:" "$UV_BIN_DIR:" > "$ENTER"
cat >> "$ENTER" <<'EOF'
# Home secrets (LINEAR_API_KEY, …). chmod 600. Never commit.
if [ -f "$HOME/.deck/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.deck/.env"
  set +a
fi
cd "$HOME/.deck" || exit 1
echo "deck home=$(pwd) prime=$(command -v prime-conversation)"
EOF
chmod +x "$ENTER"

# Put Deck's generated command shims on PATH in interactive Bash shells.
DECK_BASHRC="$HOME/.bashrc" DECK_BIN_TARGET="$BIN_TARGET" python3 - <<'PY'
from pathlib import Path
import os
import shlex
import tempfile

path = Path(os.environ["DECK_BASHRC"])
destination = path.resolve() if path.is_symlink() else path
lines = destination.read_text().splitlines() if destination.exists() else []
kept = []
index = 0
while index < len(lines):
    if lines[index] == "# deck local bin":
        while kept and kept[-1] == "":
            kept.pop()
        index += 1
        if index < len(lines) and lines[index].startswith("export PATH="):
            index += 1
        if index < len(lines) and lines[index] == "# /deck local bin":
            index += 1
        continue
    kept.append(lines[index])
    index += 1

target = shlex.quote(os.environ["DECK_BIN_TARGET"] + ":")
prefix = "\n".join(kept).rstrip()
block = f'# deck local bin\nexport PATH={target}"$PATH"\n# /deck local bin\n'
content = f"{prefix}\n\n{block}" if prefix else block
mode = destination.stat().st_mode & 0o777 if destination.exists() else 0o644
with tempfile.NamedTemporaryFile(
    mode="w",
    dir=destination.parent,
    prefix=f".{destination.name}.deck-",
    delete=False,
) as staged:
    staged.write(content)
    staged.flush()
    os.fsync(staged.fileno())
staged_path = Path(staged.name)
try:
    staged_path.chmod(mode)
    os.replace(staged_path, destination)
finally:
    staged_path.unlink(missing_ok=True)
PY

chmod +x "$REPO/update.sh" 2>/dev/null || true

# Activate the wake drainer. Without this the whole wake system is dead code:
# conditions are recorded and nothing ever evaluates them, which is exactly the
# failure that left a merged PR unverified for a day. Both units run
# `wake-drain --once` on a timer; the exclusive Deck-home lease, not the
# scheduler, is what prevents overlap.
install_wake_drainer() {
  local bun_bin deck_home log_dir
  bun_bin="$(command -v bun)" || { printf 'bun not found; skipping wake drainer activation\n'; return 0; }
  deck_home="$HOME/.deck"
  log_dir="$deck_home/logs"
  mkdir -p "$log_dir"

  render() {
    sed -e "s#@BUN_BIN@#$bun_bin#g" -e "s#@DECK_ROOT@#$REPO#g" \
        -e "s#@DECK_HOME@#$deck_home#g" -e "s#@LOG_DIR@#$log_dir#g" "$1"
  }

  case "$(uname -s)" in
    Darwin)
      local plist="$HOME/Library/LaunchAgents/ai.deck.wake-drain.plist"
      mkdir -p "$(dirname "$plist")"
      render "$REPO/ops/deck-wake-drain.plist.template" > "$plist"
      plutil -lint "$plist" >/dev/null || fail "rendered wake-drain plist is malformed"
      # A sandboxed install (HOME overridden, as in the verify scripts) must
      # not boot out the real user's drainer and replace it with a job whose
      # repo is about to be deleted. launchd only reads the real home anyway.
      local real_home
      real_home="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
      if [ -n "$real_home" ] && [ "$HOME" != "$real_home" ]; then
        printf 'WARNING: sandboxed HOME (%s); wake-drain plist written but NOT loaded into launchd.
' "$HOME"
        return 0
      fi
      # Reload rather than bootstrap: a stale job from a previous install would
      # otherwise keep running the old path silently.
      launchctl bootout "gui/$(id -u)/ai.deck.wake-drain" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$plist" ||
        fail "could not load the wake drainer; the orchestrator would never be woken"
      printf 'wake drainer loaded (launchd, every 30s)\n'
      ;;
    Linux)
      local unit_dir="$HOME/.config/systemd/user"
      mkdir -p "$unit_dir"
      render "$REPO/ops/deck-wake-drain.service.template" > "$unit_dir/deck-wake-drain.service"
      render "$REPO/ops/deck-wake-drain.timer.template" > "$unit_dir/deck-wake-drain.timer"
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        systemctl --user daemon-reload
        # A sandboxed install (HOME overridden, as in CI) writes units under a
        # HOME the running user manager never reads, so the unit is invisible
        # to it. That is a skip, not a failure: the real-install path below
        # still fails hard when the manager can see the unit and enable breaks.
        if ! systemctl --user cat deck-wake-drain.timer >/dev/null 2>&1; then
          printf 'WARNING: systemd user instance does not see %s (sandboxed HOME?); units written but NOT enabled.\n' "$unit_dir"
          printf 'WARNING: run `systemctl --user daemon-reload && systemctl --user enable --now deck-wake-drain.timer` from a real session.\n'
        else
          systemctl --user enable --now deck-wake-drain.timer ||
            fail "could not enable the wake drainer timer"
          printf 'wake drainer enabled (systemd user timer, every 30s)\n'
        fi
      else
        # A headless box with no user session bus. Say so loudly: a silent skip
        # here reads exactly like a working install with a quiet factory.
        printf 'WARNING: systemd user instance unavailable; units written to %s but NOT enabled.\n' "$unit_dir"
        printf 'WARNING: run `systemctl --user enable --now deck-wake-drain.timer` once a session bus exists.\n'
      fi
      ;;
    *)
      printf 'unknown platform; wake drainer units not installed\n'
      ;;
  esac
}
install_wake_drainer


cat <<EOF

Done. Code: $REPO
Home: $HOME/.deck
Durable: ${DECK_DURABLE_HOME:-$HOME/.deck-durable} (host-local; never sync)

Start the broker and a Prime conversation:

  bun $REPO/broker/src/cli.ts login anthropic
  bun --cwd $REPO/broker src/main.ts

In another terminal:

  source $HOME/.deck/enter.sh
  prime-conversation

No review-gate poller was started. An already-running shared Prime daemon was
drained, rewired, and restarted; otherwise the daemon starts on demand. See
$REPO/ops/README.md for optional services. Keep updated with $REPO/update.sh.

Never put work credentials, production tokens, or restricted checkouts on this host.
EOF
