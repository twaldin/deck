#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'verify-upgrade-install: ERROR: %s\n' "$*" >&2
  exit 1
}

for prerequisite in bash bun cmp curl git grep node npm python3 sed shasum tar tr wc; do
  command -v "$prerequisite" >/dev/null 2>&1 || fail "$prerequisite is required"
done

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
VERIFY_REF="${DECK_VERIFY_REF:-HEAD}"
SOURCE_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse "$VERIFY_REF^{commit}")" ||
  fail "cannot resolve DECK_VERIFY_REF=$VERIFY_REF"
SANDBOX_ROOT="/tmp/deck-upgrade-$$"
CLONE_DIR="$SANDBOX_ROOT/repo"
SANDBOX_HOME="$SANDBOX_ROOT/home"
MOCK_GATEWAY_PID=""
PRIME_BIN=""
DAEMON_SOCKET=""
shutdown_fixture_daemon() {
  local module_root="${PRIME_BIN%/bin/prime-agent}/lib/node_modules/prime-agent/dist"
  local client_module="$module_root/modes/daemon/daemon-client.js"
  local lease_module="$module_root/core/session-lease.js"
  [ -f "$client_module" ] && [ -f "$lease_module" ] || return 1
  node --input-type=module - "$client_module" "$lease_module" "$DAEMON_SOCKET" <<'NODE'
import net from "node:net";
import { pathToFileURL } from "node:url";
const [clientModule, leaseModule, socketPath] = process.argv.slice(2);
const { DaemonClient } = await import(pathToFileURL(clientModule).href);
const { getProcessStartId } = await import(pathToFileURL(leaseModule).href);
const client = new DaemonClient(socketPath);
let hello;
try {
  await client.connect();
  hello = await client.waitForHello();
  const response = await client.request({ type: "shutdown", force: false }, 10_000);
  if (response.success !== true) throw new Error(response.error ?? "shutdown failed");
} finally {
  client.close();
}
const pid = hello?.supervisorPid;
const processStartId = hello?.supervisorProcessStartId;
const exactOwnerIsAlive = () =>
  Number.isInteger(pid) && typeof processStartId === "string" &&
  getProcessStartId(pid) === processStartId;
const socketIsLive = () => new Promise((resolve) => {
  const socket = net.createConnection(socketPath);
  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 200);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  socket.once("error", () => { clearTimeout(timer); resolve(false); });
});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let deadline = Date.now() + 15_000;
while ((exactOwnerIsAlive() || await socketIsLive()) && Date.now() < deadline) await delay(50);
if (exactOwnerIsAlive()) {
  process.kill(pid, "SIGTERM");
  deadline = Date.now() + 2_000;
  while (exactOwnerIsAlive() && Date.now() < deadline) await delay(50);
}
if (exactOwnerIsAlive()) {
  process.kill(pid, "SIGKILL");
  deadline = Date.now() + 2_000;
  while (exactOwnerIsAlive() && Date.now() < deadline) await delay(50);
}
if (exactOwnerIsAlive() || await socketIsLive()) {
  throw new Error("fixture daemon did not exit after bounded cleanup");
}
NODE
}


cleanup() {
  local daemon_cleanup_failed=false
  if [ -n "$PRIME_BIN" ] && [ -x "$PRIME_BIN" ] && [ -n "$DAEMON_SOCKET" ]; then
    shutdown_fixture_daemon >/dev/null 2>&1 || daemon_cleanup_failed=true
  fi
  if [ -n "$MOCK_GATEWAY_PID" ]; then
    kill "$MOCK_GATEWAY_PID" >/dev/null 2>&1 || true
    wait "$MOCK_GATEWAY_PID" >/dev/null 2>&1 || true
  fi
  if [ "$daemon_cleanup_failed" = true ]; then
    printf 'verify-upgrade-install: ERROR: fixture daemon cleanup failed; preserving %s\n' \
      "$SANDBOX_ROOT" >&2
    return 1
  fi
  chmod -R u+w "$SANDBOX_ROOT" 2>/dev/null || true
  rm -rf "$SANDBOX_ROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

[ ! -e "$SANDBOX_ROOT" ] || fail "temporary fixture already exists: $SANDBOX_ROOT"
mkdir -p "$SANDBOX_ROOT"
printf 'verify-upgrade-install: cloning %s at %s\n' "$SOURCE_ROOT" "$SOURCE_COMMIT"
git clone --no-checkout "$SOURCE_ROOT" "$CLONE_DIR"
git -C "$CLONE_DIR" checkout --detach "$SOURCE_COMMIT"
CLONE_DIR="$(cd "$CLONE_DIR" && pwd -P)"
mkdir -p "$SANDBOX_HOME"

TOOLS_DIR="$SANDBOX_ROOT/verify-path"
mkdir -p "$TOOLS_DIR"
for tool in bash bun curl git node npm python3 tar; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$tool_path" ]; then ln -s "$tool_path" "$TOOLS_DIR/$tool"; fi
done
INSTALL_PATH="$TOOLS_DIR:/usr/bin:/bin"
DECK_HOME="$SANDBOX_HOME/.deck"
PRIME_HOME="$DECK_HOME/.prime"
PRIME_RUNTIME="$PRIME_HOME/runtime"
DECK_BIN="$SANDBOX_HOME/.local/deck-bin"
LEGACY_CHECKOUT="$SANDBOX_ROOT/previous-checkout"
RETIRED_EXTENSION_DIR="$LEGACY_CHECKOUT/$(printf 'extensions-\160\151')"
LOCAL_SEED="$SANDBOX_ROOT/operator-AGENTS.md"
TOOL_PROBE="$SANDBOX_ROOT/upgrade-ipython-tool.txt"

# The previous generation already had Prime Agent and a generated conversation
# profile, but not the now-pinned process package. Build that state directly so
# the verifier exercises one — and only one — current install run.
IFS=$'\t' read -r PRIME_VERSION PRIME_ARTIFACT_URL PRIME_ARTIFACT_SHA256 <<EOF
$(node - "$CLONE_DIR/patches/prime-agent/manifest.json" <<'NODE'
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
mkdir -p "$PRIME_RUNTIME" "$PRIME_HOME/cache" "$DECK_BIN"
PRIME_ARTIFACT="$PRIME_HOME/cache/prime-agent-$PRIME_VERSION.tgz"
curl -fsSL "$PRIME_ARTIFACT_URL" -o "$PRIME_ARTIFACT"
[ "$(shasum -a 256 "$PRIME_ARTIFACT" | cut -d ' ' -f 1)" = "$PRIME_ARTIFACT_SHA256" ] ||
  fail "fixture Prime Agent artifact failed its SHA-256 check"
npm install --global --prefix "$PRIME_RUNTIME" "$PRIME_ARTIFACT" >/dev/null
PRIME_BIN="$PRIME_RUNTIME/bin/prime-agent"
# The previous generation was installed by the previous install.sh, which
# already brought the pristine artifact up to the manifest's patched tree.
PRIME_PATCH_NPM_PREFIX="$PRIME_RUNTIME" "$CLONE_DIR/ops/prime-patches.sh" apply >/dev/null
PRIME_AGENT_BIN="$PRIME_BIN" "$CLONE_DIR/ops/prime-patches.sh" verify >/dev/null
[ ! -e "$PRIME_RUNTIME/lib/node_modules/@aliou/pi-processes" ] ||
  fail "previous-generation fixture unexpectedly contains the pinned process package"

mkdir -p \
  "$DECK_HOME/broker" \
  "$PRIME_HOME/agent/extensions" \
  "$PRIME_HOME/agent/logs" \
  "$PRIME_HOME/bin" \
  "$PRIME_HOME/sessions"
chmod 700 "$DECK_HOME" "$PRIME_HOME" "$PRIME_HOME/agent" "$PRIME_HOME/bin" "$PRIME_HOME/sessions"
printf 'sandbox-gateway-token\n' > "$DECK_HOME/broker/gateway.token"
chmod 600 "$DECK_HOME/broker/gateway.token"
printf '# Operator-local edits from the previous generation\n- preserve this evidence\n' > "$LOCAL_SEED"
cp "$LOCAL_SEED" "$DECK_HOME/AGENTS.md"

cat > "$PRIME_HOME/bin/prime-conversation" <<'WRAPPER'
#!/usr/bin/env bash
printf 'stale previous-generation wrapper\n'
WRAPPER
chmod 700 "$PRIME_HOME/bin/prime-conversation"
node - "$PRIME_HOME/agent/deck-prime-conversation.json" "$LEGACY_CHECKOUT" <<'NODE'
const fs = require("node:fs");
const [manifestPath, legacyCheckout] = process.argv.slice(2);
fs.writeFileSync(manifestPath, `${JSON.stringify({
  profile: "deck-prime-conversation-v1",
  primeAgentVersion: "0.7.0",
  deckRepo: legacyCheckout,
}, null, 2)}\n`);
NODE
chmod 444 "$PRIME_HOME/agent/deck-prime-conversation.json"

for extension in deck-questions deck-recall deck-usage; do
  legacy_source="$RETIRED_EXTENSION_DIR/$extension.ts"
  mkdir -p "$(dirname "$legacy_source")" "$PRIME_HOME/agent/extensions/$extension"
  printf 'export default function legacyExtension() {}\n' > "$legacy_source"
  ln -s "$legacy_source" "$PRIME_HOME/agent/extensions/$extension/index.ts"
done
mkdir -p "$LEGACY_CHECKOUT/broker/prime"
printf 'export default function legacyProvider() {}\n' > "$LEGACY_CHECKOUT/broker/prime/deck-provider.ts"
ln -s "$LEGACY_CHECKOUT/broker/prime/deck-provider.ts" \
  "$PRIME_HOME/agent/extensions/deck-provider.ts"
mkdir -p "$LEGACY_CHECKOUT/v2/src" "$PRIME_HOME/agent/extensions/v2/src"
printf 'export const legacy = true;\n' > "$LEGACY_CHECKOUT/v2/src/home.ts"
printf '%s\n' "$LEGACY_CHECKOUT/v2" > "$PRIME_HOME/agent/extensions/v2/.deck-v2-lib"
ln -s "$LEGACY_CHECKOUT/v2/src/home.ts" "$PRIME_HOME/agent/extensions/v2/src/home.ts"
ln -s "$PRIME_BIN" "$DECK_BIN/prime-agent"
ln -s "$PRIME_HOME/bin/prime-conversation" "$DECK_BIN/prime-conversation"

# A deterministic local Deck gateway makes the upgraded seat call IPython and
# prove the tool runtime itself works. Fluent text without this file is failure.
MOCK_READY="$SANDBOX_ROOT/gateway-origin"
MOCK_REQUESTS="$SANDBOX_ROOT/gateway-requests"
MOCK_SERVER="$SANDBOX_ROOT/mock-gateway.mjs"
cat > "$MOCK_SERVER" <<'NODE'
import fs from "node:fs";
import http from "node:http";
const [readyPath, requestsPath, toolProbe] = process.argv.slice(2);
let requests = 0;
const server = http.createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume request */ }
  requests += 1;
  fs.appendFileSync(requestsPath, `${requests}\n`);
  const envelope = {
    id: `upgrade-${requests}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.6-sol",
  };
  const delta = requests === 1
    ? {
        tool_calls: [{
          index: 0,
          id: "upgrade-ipython-probe",
          type: "function",
          function: {
            name: "ipython",
            arguments: JSON.stringify({
              code: `import os\nfrom pathlib import Path\nassert "DECK_TEST_AMBIENT_SECRET" not in os.environ\nPath(${JSON.stringify(toolProbe)}).write_text("upgrade-tool-ok")\n"upgrade-tool-ok"`,
            }),
          },
        }],
      }
    : { role: "assistant", content: "UPGRADE_TOOL_OK" };
  const finishReason = requests === 1 ? "tool_calls" : "stop";
  const chunks = [
    { ...envelope, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...envelope,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") process.exit(2);
  fs.writeFileSync(readyPath, `http://127.0.0.1:${address.port}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
NODE
node "$MOCK_SERVER" "$MOCK_READY" "$MOCK_REQUESTS" "$TOOL_PROBE" &
MOCK_GATEWAY_PID=$!
for ((_attempt = 0; _attempt < 100; _attempt++)); do
  [ -s "$MOCK_READY" ] && break
  kill -0 "$MOCK_GATEWAY_PID" 2>/dev/null || fail "mock Deck gateway exited before readiness"
  sleep 0.1
done
[ -s "$MOCK_READY" ] || fail "mock Deck gateway did not become ready"
DECK_GATEWAY_ORIGIN="$(cat "$MOCK_READY")"

DAEMON_SOCKET_RELATIVE="$(node - "$CLONE_DIR/ops/prime-deck-profile.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).daemonSocketRelative;
if (typeof value !== "string" || value.startsWith("/") || value.split(/[\\/]/).includes("..")) process.exit(1);
process.stdout.write(value);
NODE
)" || fail "invalid Prime daemon socket fixture contract"
DAEMON_SOCKET="$DECK_HOME/$DAEMON_SOCKET_RELATIVE"
mkdir -p "$(dirname "$DAEMON_SOCKET")"
env HOME="$SANDBOX_HOME" \
  PATH="$TOOLS_DIR:$PRIME_RUNTIME/bin:/usr/bin:/bin" \
  DECK_GATEWAY_ORIGIN="$DECK_GATEWAY_ORIGIN" \
  DECK_TEST_AMBIENT_SECRET="must-not-survive-upgrade" \
  PRIME_AGENT_CODING_AGENT_DIR="$PRIME_HOME/agent" \
  PRIME_AGENT_SESSION_DIR="$PRIME_HOME/sessions" \
  "$PRIME_BIN" --mode daemon --daemon-socket "$DAEMON_SOCKET" \
  </dev/null >"$PRIME_HOME/agent/logs/previous-daemon.log" 2>&1 &
OLD_DAEMON_PID=$!
node - "$DAEMON_SOCKET" <<'NODE'
const net = require("node:net");
const socketPath = process.argv[2];
const deadline = Date.now() + 10_000;
function probe() {
  const socket = net.createConnection(socketPath);
  const timer = setTimeout(() => socket.destroy(), 200);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(0); });
  socket.once("error", () => {
    clearTimeout(timer);
    if (Date.now() >= deadline) process.exit(1);
    setTimeout(probe, 100);
  });
}
probe();
NODE

[ "$(cat "$DECK_HOME/AGENTS.md")" = "$(cat "$LOCAL_SEED")" ] || fail "fixture lost its local seed drift"
[ "$(readlink "$PRIME_HOME/agent/extensions/deck-questions/index.ts")" = \
  "$RETIRED_EXTENSION_DIR/deck-questions.ts" ] ||
  fail "fixture is missing its retired-generation stale extension symlink"
[ "$("$DECK_BIN/prime-conversation")" = "stale previous-generation wrapper" ] ||
  fail "fixture is missing its stale wrapper"
printf 'verify-upgrade-install: running one installer against previous-generation HOME=%s\n' "$SANDBOX_HOME"
set +e
INSTALL_OUTPUT="$(env HOME="$SANDBOX_HOME" \
  PATH="$INSTALL_PATH" \
  DECK_GATEWAY_ORIGIN="$DECK_GATEWAY_ORIGIN" \
  DECK_HOME_PROFILE= \
  DECK_V2_HOME="$DECK_HOME" \
  BIN_TARGET="$DECK_BIN" \
  WORKFLOWS_SOURCE="$CLONE_DIR/workflows" \
  WORKFLOWS_LINK="$DECK_HOME/workflows" \
  bash "$CLONE_DIR/install.sh" 2>&1)"
INSTALL_STATUS=$?
set -e
if [ "$INSTALL_STATUS" -ne 0 ]; then
  printf '%s\n' "$INSTALL_OUTPUT" >&2
  fail "single installer run did not converge the previous-generation fixture"
fi
printf '%s\n' "$INSTALL_OUTPUT"

case "$INSTALL_OUTPUT" in
  *"draining Deck Prime daemon"*"in-flight work will finish its checkpoint first"*) ;;
  *) fail "installer did not report draining the previous daemon" ;;
esac
case "$INSTALL_OUTPUT" in
  *"reconciling Deck-managed symlink"*) ;;
  *) fail "installer did not report reconciling stale Deck symlinks" ;;
esac
case "$INSTALL_OUTPUT" in
  *"backed up local AGENTS.md"*) ;;
  *) fail "installer did not report backing up the drifted managed seed" ;;
esac
if kill -0 "$OLD_DAEMON_PID" 2>/dev/null; then
  fail "previous-generation daemon process survived convergence"
fi
wait "$OLD_DAEMON_PID" >/dev/null 2>&1 || true

cmp "$CLONE_DIR/v2/seed/AGENTS.md" "$DECK_HOME/AGENTS.md" >/dev/null ||
  fail "upgrade did not restore the installer-managed seed"
shopt -s nullglob
seed_backups=("$DECK_HOME/backups"/AGENTS.md.pre-install-*/AGENTS.md)
shopt -u nullglob
[ "${#seed_backups[@]}" -eq 1 ] ||
  fail "upgrade created ${#seed_backups[@]} seed backups instead of exactly one"
cmp "$LOCAL_SEED" "${seed_backups[0]}" >/dev/null ||
  fail "upgrade seed backup does not preserve the previous local edits"

PROCESS_IDENTITY="$(node -e 'const p=require(process.argv[1]); process.stdout.write(`${p.name}@${p.version}`)' \
  "$PRIME_RUNTIME/lib/node_modules/@aliou/pi-processes/package.json")"
[ "$PROCESS_IDENTITY" = "@aliou/pi-processes@0.10.4" ] ||
  fail "upgrade did not install the pinned process package"
[ -x "$PRIME_HOME/bin/prime-conversation" ] || fail "upgrade did not regenerate prime-conversation"
case "$(cat "$PRIME_HOME/bin/prime-conversation")" in
  *"stale previous-generation wrapper"*) fail "upgrade retained the stale wrapper" ;;
esac
for extension in deck-questions deck-recall deck-usage; do
  expected="$CLONE_DIR/extensions-prime/$extension.ts"
  actual="$(readlink "$PRIME_HOME/agent/extensions/$extension/index.ts")"
  [ "$actual" = "$expected" ] || fail "$extension still targets $actual instead of $expected"
done
[ "$(readlink "$PRIME_HOME/agent/extensions/deck-provider.ts")" = "$CLONE_DIR/broker/prime/deck-provider.ts" ] ||
  fail "Deck provider still targets the previous checkout"
[ "$(cat "$PRIME_HOME/agent/extensions/v2/.deck-v2-lib")" = "$CLONE_DIR/v2" ] ||
  fail "v2 support ownership marker still targets the previous checkout"

node - "$DAEMON_SOCKET" <<'NODE'
const net = require("node:net");
const socket = net.createConnection(process.argv[2]);
const timer = setTimeout(() => { socket.destroy(); process.exit(1); }, 1_000);
socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(0); });
socket.once("error", () => { clearTimeout(timer); process.exit(1); });
NODE

set +e
SEAT_OUTPUT="$(env HOME="$SANDBOX_HOME" \
  PATH="$DECK_BIN:$INSTALL_PATH" \
  DECK_GATEWAY_ORIGIN="$DECK_GATEWAY_ORIGIN" \
  DECK_HERDR_AUTO_ATTACH=0 \
  PRIME_CONVERSATION_RLM_MAX_DEPTH=1 \
  "$DECK_BIN/prime-conversation" -p \
    "Use the ipython tool to complete the upgrade verification." 2>&1)"
SEAT_STATUS=$?
set -e
if [ "$SEAT_STATUS" -ne 0 ]; then
  printf '%s\n' "$SEAT_OUTPUT" >&2
  fail "upgraded Prime seat could not complete its tool-backed turn"
fi
case "$SEAT_OUTPUT" in
  *"UPGRADE_TOOL_OK"*) ;;
  *) fail "upgraded Prime seat did not return the gateway's completion" ;;
esac
[ "$(cat "$TOOL_PROBE" 2>/dev/null)" = "upgrade-tool-ok" ] ||
  fail "upgraded Prime seat answered without executing its IPython tool"
[ "$(wc -l < "$MOCK_REQUESTS" | tr -d '[:space:]')" -ge 2 ] ||
  fail "upgraded Prime seat did not return a tool result to the model"

[ -z "$(git -C "$CLONE_DIR" status --porcelain)" ] || {
  git -C "$CLONE_DIR" status --short >&2
  fail "upgrade verifier modified the clean checkout"
}
printf 'verify-upgrade-install: PASS commit=%s home=%s package=%s tool=ipython\n' \
  "$SOURCE_COMMIT" "$DECK_HOME" "$PROCESS_IDENTITY"
