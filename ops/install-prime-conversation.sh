#!/usr/bin/env bash
set -euo pipefail

# Prime Agent release pinned by the captain's v4 adoption ruling.
PINNED_VERSION="0.7.0"
PINNED_TAG="v0.7.0"
PINNED_COMMIT="be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387"
PINNED_ARTIFACT_URL="https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz"
PINNED_ARTIFACT_SHA256="88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b"
PINNED_CLI_SHA256="ef097dce87e63c32e49493767763c7147376e6b4522818dd275ca9c32218ad35"
PINNED_PACKAGE_TREE_SHA256="bacc5921cfce2d58da0bb557501b011c699ad0a95ade6ac4499190ffd6392250"
PROFILE_ID="deck-prime-conversation-v1"

usage() {
  cat <<'USAGE'
Usage: ops/install-prime-conversation.sh [--apply]

Without --apply, validate prerequisites and print the planned profile wiring.
With --apply, wire the pinned, already-global Prime Agent into ~/.deck/.prime.
The script never installs or updates the global package and never writes ~/.prime.
USAGE
}

apply=false
case "${1:-}" in
  "") ;;
  --apply) apply=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
REPO_V2="$REPO_ROOT/v2"
EXTENSION_SOURCE="$REPO_ROOT/extensions-pi"
PROVIDER_SOURCE="$REPO_ROOT/broker/pi/deck-provider.ts"
ZOD_SOURCE="$REPO_ROOT/broker/node_modules/zod"
SEED_SOURCE="$REPO_V2/seed/AGENTS.md"
DECK_HOME="${PRIME_CONVERSATION_HOME:-$HOME/.deck}"
PROFILE_ROOT="$DECK_HOME/.prime"
AGENT_DIR="$PROFILE_ROOT/agent"
EXTENSIONS_DIR="$AGENT_DIR/extensions"
LIB_ROOT="$EXTENSIONS_DIR/v2"
LIB_DEST="$LIB_ROOT/src"
LIB_MARKER="$LIB_ROOT/.deck-v2-lib"
HARNESS_DIR="$AGENT_DIR/harness"
SETTINGS_FILE="$AGENT_DIR/settings.json"
CUSTODY_FILE="$AGENT_DIR/APPEND_SYSTEM.md"
GUARD_FILE="$EXTENSIONS_DIR/prime-conversation-guard.ts"
AUTH_FILE="$AGENT_DIR/auth.json"
MANIFEST_FILE="$AGENT_DIR/deck-prime-conversation.json"
WRAPPER="$PROFILE_ROOT/bin/prime-conversation"
RUN_DIR="$PROFILE_ROOT/run"
SOCKET="$RUN_DIR/conversation.sock"
SESSIONS_DIR="$PROFILE_ROOT/sessions"

if [[ -n "${PRIME_CONVERSATION_PRIME_BIN:-}" ]]; then
  if [[ ! -x "$PRIME_CONVERSATION_PRIME_BIN" ]]; then
    printf 'error: PRIME_CONVERSATION_PRIME_BIN is not executable: %s\n' "$PRIME_CONVERSATION_PRIME_BIN" >&2
    exit 1
  fi
  PRIME_BIN="$(cd "$(dirname "$PRIME_CONVERSATION_PRIME_BIN")" && pwd -P)/$(basename "$PRIME_CONVERSATION_PRIME_BIN")"
else
  PRIME_BIN="$(command -v prime-agent || true)"
  if [[ -z "$PRIME_BIN" ]]; then
    printf 'error: prime-agent is not installed. Install the reviewed release artifact:\n' >&2
    printf '  curl -fsSL %s -o /tmp/prime-agent-%s.tgz\n' "$PINNED_ARTIFACT_URL" "$PINNED_VERSION" >&2
    printf '  printf "%s  /tmp/prime-agent-%s.tgz\\n" | shasum -a 256 -c -\n' "$PINNED_ARTIFACT_SHA256" "$PINNED_VERSION" >&2
    printf '  npm install -g /tmp/prime-agent-%s.tgz\n' "$PINNED_VERSION" >&2
    exit 1
  fi
fi
if ! installed_version="$("$PRIME_BIN" --version 2>&1)"; then
  printf 'error: Prime Agent version check failed for %s: %s\n' "$PRIME_BIN" "$installed_version" >&2
  exit 1
fi
if [[ "$installed_version" != "$PINNED_VERSION" ]]; then
  printf 'error: Prime Agent upgrade tripwire: expected %s (%s, %s), got %s from %s\n' \
    "$PINNED_VERSION" "$PINNED_TAG" "$PINNED_COMMIT" "${installed_version:-<no version>}" "$PRIME_BIN" >&2
  exit 1
fi
prime_entry="$(realpath "$PRIME_BIN")"
installed_cli_sha="$(shasum -a 256 "$prime_entry" | cut -d ' ' -f 1)"
if [[ "$installed_cli_sha" != "$PINNED_CLI_SHA256" ]]; then
  printf 'error: Prime Agent provenance tripwire: expected CLI SHA-256 %s, got %s from %s\n' \
    "$PINNED_CLI_SHA256" "$installed_cli_sha" "$prime_entry" >&2
  exit 1
fi
prime_package_root="$(cd "$(dirname "$prime_entry")/../.." && pwd -P)"
installed_tree_sha="$(node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const roots = new Set(["dist", "docs", "examples", "skills"]);
const files = new Set(["postinstall.cjs", "CHANGELOG.md", "package.json"]);
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
for (const name of [...roots].sort()) walk(path.join(root, name));
for (const name of [...files].sort()) entries.push(name);
const hash = crypto.createHash("sha256");
for (const relative of entries.sort()) {
  const absolute = path.join(root, relative);
  const symbolic = fs.lstatSync(absolute).isSymbolicLink();
  const data = symbolic ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
  hash.update(symbolic ? "L" : "F");
  hash.update(relative);
  hash.update("\\0");
  hash.update(String(data.length));
  hash.update("\\0");
  hash.update(data);
}
process.stdout.write(hash.digest("hex"));
' "$prime_package_root" 2>/dev/null || true)"
if [[ "$installed_tree_sha" != "$PINNED_PACKAGE_TREE_SHA256" ]]; then
  printf 'error: Prime Agent provenance tripwire: installed package tree does not match the reviewed artifact\n' >&2
  exit 1
fi

for source in \
  "$EXTENSION_SOURCE/deck-questions.ts" \
  "$EXTENSION_SOURCE/deck-ship.ts" \
  "$EXTENSION_SOURCE/deck-recall.ts" \
  "$PROVIDER_SOURCE" \
  "$SEED_SOURCE"; do
  if [[ ! -f "$source" ]]; then
    printf 'error: missing profile source %s\n' "$source" >&2
    exit 1
  fi
done
if [[ ! -d "$ZOD_SOURCE" ]]; then
  printf 'error: Deck provider dependencies are missing; run bun install --cwd %s/broker\n' "$REPO_ROOT" >&2
  exit 1
fi
managed=false
if [[ -f "$MANIFEST_FILE" ]]; then
  manifest_owner="$(node -e '
const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value && value.profile === process.argv[2]) process.stdout.write("owned");
} catch {}
' "$MANIFEST_FILE" "$PROFILE_ID")"
  if [[ "$manifest_owner" != owned ]]; then
    printf 'error: %s is not a valid %s ownership manifest\n' "$MANIFEST_FILE" "$PROFILE_ID" >&2
    exit 1
  fi
  managed=true
fi
if [[ "$managed" != true ]]; then
  for path_to_claim in "$SETTINGS_FILE" "$CUSTODY_FILE" "$GUARD_FILE" "$AUTH_FILE" "$WRAPPER"; do
    if [[ -e "$path_to_claim" || -L "$path_to_claim" ]]; then
      printf 'error: refusing to overwrite unowned conversation profile path %s\n' "$path_to_claim" >&2
      exit 1
    fi
  done
fi

if [[ ! -f "$DECK_HOME/AGENTS.md" ]] || ! cmp -s "$SEED_SOURCE" "$DECK_HOME/AGENTS.md"; then
  printf 'error: %s must exactly match the Deck v4 seed %s\n' \
    "$DECK_HOME/AGENTS.md" "$SEED_SOURCE" >&2
  exit 1
fi

if [[ "$apply" != true ]]; then
  cat <<EOF
DRY RUN — no files will be changed
Prime Agent: $PRIME_BIN ($PINNED_VERSION, $PINNED_TAG, $PINNED_COMMIT)
Deck home:   $DECK_HOME
Profile:     $AGENT_DIR
Extensions:  deck-questions, deck-ship, deck-recall, deck-provider
Custody:     $CUSTODY_FILE (read-only base-prompt supplement)
Refinement:  $HARNESS_DIR (writable supplemental state)
Socket:      $SOCKET (isolated from the per-UID default daemon)
Entry:       cd "$DECK_HOME" && "$WRAPPER"

Re-run with --apply to write this profile.
EOF
  exit 0
fi


# Reject every unowned auto-discovery entry before creating profile state. Prime
# loads top-level *.ts files and */index.ts automatically.
if [[ -d "$EXTENSIONS_DIR" ]]; then
  for existing in "$EXTENSIONS_DIR"/*; do
    [[ -e "$existing" || -L "$existing" ]] || continue
    case "$(basename "$existing")" in
      deck-questions|deck-ship|deck-recall|deck-provider.ts|prime-conversation-guard.ts|node_modules|v2) ;;
      *)
        printf 'error: unapproved conversation-profile extension is present: %s\n' "$existing" >&2
        exit 1
        ;;
    esac
  done
fi
for forbidden in "$EXTENSIONS_DIR/deck-subagents" "$EXTENSIONS_DIR/subagent" "$EXTENSIONS_DIR/herdr-agent-state.ts" "$EXTENSIONS_DIR/herdr-agent-state.js"; do
  if [[ -e "$forbidden" || -L "$forbidden" ]]; then
    printf 'error: forbidden conversation-profile extension is present: %s\n' "$forbidden" >&2
    exit 1
  fi
done

umask 077
mkdir -p "$AGENT_DIR" "$EXTENSIONS_DIR" "$HARNESS_DIR" "$PROFILE_ROOT/bin" "$RUN_DIR" "$SESSIONS_DIR"
chmod 700 "$PROFILE_ROOT" "$AGENT_DIR" "$HARNESS_DIR" "$PROFILE_ROOT/bin" "$RUN_DIR" "$SESSIONS_DIR"


ensure_symlink() {
  local source="$1"
  local destination="$2"
  if [[ -L "$destination" ]]; then
    if [[ "$(readlink "$destination")" != "$source" ]]; then
      printf 'error: %s is a symlink not owned by this Deck checkout\n' "$destination" >&2
      exit 1
    fi
    return
  fi
  if [[ -e "$destination" ]]; then
    printf 'error: refusing to replace non-symlink path %s\n' "$destination" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$destination")"
  ln -s "$source" "$destination"
}

# Reuse the v2 installer's exact extension tree shape without invoking it. The
# full v2 installer also adds deck-subagents, CLI shims, and a Smithers runtime;
# those are deliberately forbidden in this zero-custody conversation profile.
if [[ -e "$LIB_ROOT" || -L "$LIB_ROOT" ]]; then
  if [[ -L "$LIB_ROOT" || ! -d "$LIB_ROOT" ]]; then
    printf 'error: %s exists and is not Deck support state\n' "$LIB_ROOT" >&2
    exit 1
  fi
  owner=""
  if [[ -f "$LIB_MARKER" ]]; then IFS= read -r owner < "$LIB_MARKER" || true; fi
  if [[ "$owner" != "$REPO_V2" ]]; then
    printf 'error: %s exists without Deck ownership for %s\n' "$LIB_ROOT" "$REPO_V2" >&2
    exit 1
  fi
else
  mkdir -p "$LIB_ROOT"
  printf '%s\n' "$REPO_V2" > "$LIB_MARKER"
fi
mkdir -p "$LIB_DEST"
for module in "$REPO_V2"/src/*.ts; do
  name="$(basename "$module")"
  [[ "$name" == index.ts ]] && continue
  ensure_symlink "$module" "$LIB_DEST/$name"
done

for extension in deck-questions deck-ship deck-recall; do
  destination="$EXTENSIONS_DIR/$extension"
  if [[ -L "$destination" || ( -e "$destination" && ! -d "$destination" ) ]]; then
    printf 'error: %s exists and is not an extension directory\n' "$destination" >&2
    exit 1
  fi
  mkdir -p "$destination"
  ensure_symlink "$EXTENSION_SOURCE/$extension.ts" "$destination/index.ts"
done
ensure_symlink "$PROVIDER_SOURCE" "$EXTENSIONS_DIR/deck-provider.ts"
mkdir -p "$EXTENSIONS_DIR/node_modules"
ensure_symlink "$ZOD_SOURCE" "$EXTENSIONS_DIR/node_modules/zod"

guard_tmp="$GUARD_FILE.tmp.$$"
cat > "$guard_tmp" <<'GUARD'
import * as fs from "node:fs";

interface PrimeModel {
  provider: string;
}
interface PrimeTool {
  name: string;
}
interface PrimeContext {
  model: PrimeModel | undefined;
  abort(): void;
  shutdown(): void;
  getSystemPrompt(): string;
}
interface ModelSelectEvent {
  model: PrimeModel;
}
interface PrimeGuardApi {
  getAllTools(): PrimeTool[];
  on(event: string, handler: (event: ModelSelectEvent, context: PrimeContext) => void): void;
}

export default function primeConversationGuard(pi: PrimeGuardApi): void {
  const enforceDeck = (model: PrimeModel | undefined, context: PrimeContext): void => {
    if (model?.provider === "deck") return;
    context.abort();
    context.shutdown();
  };
  pi.on("session_start", (_event, context) => {
    enforceDeck(context.model, context);
    const output = process.env.PRIME_CONVERSATION_PROBE;
    if (output === undefined) return;
    fs.writeFileSync(output, JSON.stringify({
      cwd: process.cwd(),
      systemPrompt: context.getSystemPrompt(),
      tools: pi.getAllTools().map((tool) => tool.name).sort(),
      gatewayToken: process.env.SMITHERS_GATEWAY_TOKEN ?? null,
      tokenStore: process.env.SMITHERS_TOKEN_STORE ?? null,
      stampToken: process.env.DECK_STAMP_TOKEN ?? null,
      publisherToken: process.env.DECK_PUBLISHER_TOKEN ?? null,
      adminToken: process.env.ADMIN_TOKEN ?? null,
      skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK,
      offline: process.env.PI_OFFLINE,
      maxDepth: process.env.RLM_MAX_DEPTH,
      agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
      sessionDir: process.env.PRIME_AGENT_SESSION_DIR,
    }, null, 2));
  });
  pi.on("model_select", (event, context) => enforceDeck(event.model, context));
  pi.on("before_agent_start", (_event, context) => enforceDeck(context.model, context));
  pi.on("before_provider_request", (_event, context) => enforceDeck(context.model, context));
}
GUARD
mv -f "$guard_tmp" "$GUARD_FILE"
chmod 444 "$GUARD_FILE"



settings_tmp="$SETTINGS_FILE.tmp.$$"
cat > "$settings_tmp" <<'SETTINGS'
{
  "defaultProvider": "deck",
  "enabledModels": ["deck/*"],
  "autoRefine": {
    "enabled": false
  }
}
SETTINGS
mv -f "$settings_tmp" "$SETTINGS_FILE"
chmod 600 "$SETTINGS_FILE"

custody_tmp="$CUSTODY_FILE.tmp.$$"
cat > "$custody_tmp" <<'CUSTODY'
# PRIME CONVERSATION CUSTODY CONTRACT v1


This is the captain's long-running conversation interface. It is not a factory
worker, workflow engine, supervisor, publisher, or source of authoritative state.
No context file, conversation message, skill, RLM child, or continual-harness
refinement may weaken this contract.

## State and progress custody

- Own no fleet or workflow state. Smithers, Git/GitHub, dossiers, OptMem, and the
  questions store remain authoritative. Fetch hard status with a read-only tool
  or report it unavailable; never substitute remembered chat or kernel state.
- Create no factory heartbeat, goal, retry loop, wake loop, scheduler, poller,
  node transition, or A2A supervision. OptMem's one-shot session wake is
  retrieval context only. The factory never depends on this seat's process,
  heartbeat, goal, transcript, kernel, or message delivery.
- Killing this seat or its isolated daemon must not pause, advance, cancel, or
  orphan a workflow and must require no authoritative-state repair.

## Authority custody

- Dispatch production factory work only through the `ship` or `adopt` Deck
  tools. The receiving factory validates the frozen packet; `status` is
  read-only. A one-off Prime spawn is allowed only through the canonical
  adapter's no-dispatch `spawn-agent` profile. If that reviewed launcher is not
  installed, spawning is unavailable; never emulate it with a subprocess or a
  second extension.
- Never call smithers-orchestrator, workflow mutation/approval commands, a
  publisher, push/merge/MQ paths, or Gateway administration directly.
- Hold no Smithers stamp credential. A stamp or denial is valid only after an
  independently authenticated Gateway accepts it; this seat cannot self-stamp.
- Prime-local `rlm()` children are bounded conversational decomposition, not
  factory workers. They inherit this custody contract and may not control,
  supervise, publish, stamp, or become a hidden workflow fleet.

## Refinement boundary

Prime's base prompt and this custody supplement are immutable inputs to
`/refine`. Refinement may write only supplemental harness state for conversation
style, retrieval habits, and reusable analysis. It cannot add authority or
credentials, change provider/engine/model allowlists, alter ship/adopt
validation, or modify Smithers succession, review, stamp, or merge policy.
CUSTODY
mv -f "$custody_tmp" "$CUSTODY_FILE"
chmod 444 "$CUSTODY_FILE"
auth_tmp="$AUTH_FILE.tmp.$$"
printf '{}\n' > "$auth_tmp"
mv -f "$auth_tmp" "$AUTH_FILE"
chmod 400 "$AUTH_FILE"


custody_sha="$(shasum -a 256 "$CUSTODY_FILE" | cut -d ' ' -f 1)"
guard_sha="$(shasum -a 256 "$GUARD_FILE" | cut -d ' ' -f 1)"
settings_sha="$(shasum -a 256 "$SETTINGS_FILE" | cut -d ' ' -f 1)"
auth_sha="$(shasum -a 256 "$AUTH_FILE" | cut -d ' ' -f 1)"
seed_sha="$(shasum -a 256 "$DECK_HOME/AGENTS.md" | cut -d ' ' -f 1)"

printf -v prime_bin_q '%q' "$PRIME_BIN"
printf -v deck_home_q '%q' "$DECK_HOME"
printf -v socket_q '%q' "$SOCKET"
printf -v custody_file_q '%q' "$CUSTODY_FILE"
printf -v settings_file_q '%q' "$SETTINGS_FILE"
printf -v auth_file_q '%q' "$AUTH_FILE"
printf -v seed_file_q '%q' "$DECK_HOME/AGENTS.md"
printf -v extensions_dir_q '%q' "$EXTENSIONS_DIR"
printf -v extension_source_q '%q' "$EXTENSION_SOURCE"
printf -v provider_source_q '%q' "$PROVIDER_SOURCE"
printf -v zod_source_q '%q' "$ZOD_SOURCE"
printf -v lib_root_q '%q' "$LIB_ROOT"
printf -v prime_package_root_q '%q' "$prime_package_root"
printf -v guard_file_q '%q' "$GUARD_FILE"
printf -v run_dir_q '%q' "$RUN_DIR"
printf -v sessions_dir_q '%q' "$SESSIONS_DIR"
printf -v agent_dir_q '%q' "$AGENT_DIR"
wrapper_tmp="$WRAPPER.tmp.$$"
cat > "$wrapper_tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
PINNED_VERSION='$PINNED_VERSION'
PINNED_TAG='$PINNED_TAG'
PINNED_CLI_SHA256='$PINNED_CLI_SHA256'
PINNED_COMMIT='$PINNED_COMMIT'
PRIME_AGENT_BIN=$prime_bin_q
DECK_HOME=$deck_home_q
SOCKET=$socket_q
CUSTODY_FILE=$custody_file_q
GUARD_FILE=$guard_file_q
RUN_DIR=$run_dir_q
SESSIONS_DIR=$sessions_dir_q
PRIME_PACKAGE_ROOT=$prime_package_root_q
EXTENSIONS_DIR=$extensions_dir_q
EXTENSION_SOURCE=$extension_source_q
PROVIDER_SOURCE=$provider_source_q
ZOD_SOURCE=$zod_source_q
LIB_ROOT=$lib_root_q
SETTINGS_FILE=$settings_file_q
AUTH_FILE=$auth_file_q
SEED_FILE=$seed_file_q
AGENT_DIR=$agent_dir_q
CUSTODY_SHA256='$custody_sha'
PINNED_PACKAGE_TREE_SHA256='$PINNED_PACKAGE_TREE_SHA256'
SETTINGS_SHA256='$settings_sha'
AUTH_SHA256='$auth_sha'
SEED_SHA256='$seed_sha'
GUARD_SHA256='$guard_sha'

if ! actual_version="\$("\$PRIME_AGENT_BIN" --version 2>&1)"; then
  printf 'error: Prime Agent version check failed: %s\n' "\$actual_version" >&2
  exit 1
fi
if [[ "\$actual_version" != "\$PINNED_VERSION" ]]; then
  printf 'error: Prime Agent upgrade tripwire: expected %s (%s, %s), got %s\\n' \\
    "\$PINNED_VERSION" "\$PINNED_TAG" "\$PINNED_COMMIT" "\${actual_version:-<no version>}" >&2
  exit 1
fi
actual_cli_sha="\$(shasum -a 256 "\$PRIME_AGENT_BIN" | cut -d ' ' -f 1)"
if [[ "\$actual_cli_sha" != "\$PINNED_CLI_SHA256" ]]; then
  printf 'error: Prime Agent provenance tripwire: CLI SHA-256 mismatch\n' >&2
  exit 1
fi
actual_custody_sha="\$(shasum -a 256 "\$CUSTODY_FILE" | cut -d ' ' -f 1)"
if [[ "\$actual_custody_sha" != "\$CUSTODY_SHA256" ]]; then
  printf 'error: Prime conversation custody prompt failed its launch digest check\n' >&2
  exit 1
fi
actual_guard_sha="\$(shasum -a 256 "\$GUARD_FILE" 2>/dev/null | cut -d ' ' -f 1)"
if [[ "\$actual_guard_sha" != "\$GUARD_SHA256" ]]; then
  printf 'error: Prime conversation provider guard failed its launch digest check\n' >&2
  exit 1
fi
case "\${1:-}" in
  update|package)
    printf 'error: prime-agent %s is disabled for the pinned conversation profile; follow docs/prime-conversation.md\n' "\$1" >&2
    exit 1
    ;;
  shutdown)
    if [[ \$# -ne 1 ]]; then
      printf 'error: usage: prime-conversation shutdown\n' >&2
      exit 2
    fi
    node - "\$SOCKET" "\$PINNED_VERSION" <<'PRIME_CONVERSATION_SHUTDOWN'
const net = require("node:net");
const socketPath = process.argv[2];
const pinnedVersion = process.argv[3];
const client = net.createConnection(socketPath);
let buffer = "";
let requestId;
let acknowledged = false;
let settled = false;
const timer = setTimeout(() => fail("timed out"), 10_000);
function finish(message) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.log(message);
  client.destroy();
}
function fail(message) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.error("error: isolated Prime daemon shutdown failed: " + message);
  client.destroy();
  process.exitCode = 1;
}
client.setEncoding("utf8");
client.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail("daemon sent malformed JSON");
      return;
    }
    if (message.type === "daemon_hello") {
      if (message.socketPath !== socketPath ||
          message.appVersion !== pinnedVersion ||
          message.protocol?.name !== "prime-agent.daemon" ||
          message.protocol?.version !== 7) {
        fail("daemon identity does not match the pinned conversation profile");
        return;
      }
      requestId = "prime_conversation_shutdown_" + process.pid;
      client.write(JSON.stringify({
        type: "command",
        id: requestId,
        protocol: message.protocol,
        clientId: "prime-conversation-shutdown:" + process.pid,
        command: { type: "shutdown", force: true, id: requestId },
      }) + "\n");
      continue;
    }
    if (message.type === "response" && message.id === requestId) {
      if (message.success !== true) {
        fail(typeof message.error === "string" ? message.error : "daemon rejected shutdown");
        return;
      }
      acknowledged = true;
      continue;
    }
  }
});
client.on("error", (error) => {
  if (error.code === "ENOENT") {
    finish("Prime conversation daemon is not running.");
    return;
  }
  fail(error.message);
});
client.on("close", () => {
  if (!settled) {
    if (acknowledged) finish("Prime conversation daemon stopped.");
    else fail("daemon closed before acknowledging shutdown");
  }
});
PRIME_CONVERSATION_SHUTDOWN
    exit \$?
    ;;
esac

scan_options=true
model_value_pending=false
for argument in "\$@"; do
  if [[ "\$scan_options" != true ]]; then continue; fi
  if [[ "\$model_value_pending" == true ]]; then
    if [[ "\$argument" == */* ]]; then
      printf 'error: provider-qualified --model values are forbidden; choose a bare Deck model id\n' >&2
      exit 2
    fi
    model_value_pending=false
    continue
  fi
  case "\$argument" in
    --) scan_options=false ;;
    --model) model_value_pending=true ;;
    --model=*/*)
      printf 'error: provider-qualified --model values are forbidden; choose a bare Deck model id\n' >&2
      exit 2
      ;;
    --daemon-socket|--daemon-socket=*|--cwd|--cwd=*|--session-dir|--session-dir=*|\\
    --system-prompt|--system-prompt=*|--append-system-prompt|--append-system-prompt=*|\\
    --provider|--provider=*|--no-context-files|-nc|--no-extensions|-ne|\\
    --extension|--extension=*|-e|--models|--models=*|\\
    --resume|--resume=*|-r|--fork|--fork=*)
      printf 'error: %s is fixed by the prime conversation profile\\n' "\$argument" >&2
      exit 2
      ;;
  esac
done
if [[ "\$model_value_pending" == true ]]; then
  printf 'error: --model requires a bare Deck model id\n' >&2
  exit 2
fi

case "\${PRIME_CONVERSATION_RLM_MAX_DEPTH:-1}" in
  ''|*[!0-9]*)
    printf 'error: PRIME_CONVERSATION_RLM_MAX_DEPTH must be a non-negative integer\\n' >&2
    exit 2
    ;;
esac

mkdir -p "\$RUN_DIR" "\$SESSIONS_DIR"
chmod 700 "\$RUN_DIR" "\$SESSIONS_DIR"
export PRIME_AGENT_CODING_AGENT_DIR="\$AGENT_DIR"
export PRIME_AGENT_SESSION_DIR="\$SESSIONS_DIR"
export DECK_V2_HOME="\$DECK_HOME"
export PI_SKIP_VERSION_CHECK=1
export PI_OFFLINE=1
export RLM_MAX_DEPTH="\${PRIME_CONVERSATION_RLM_MAX_DEPTH:-1}"
unset SMITHERS_GATEWAY_TOKEN SMITHERS_TOKEN_STORE DECK_STAMP_TOKEN DECK_PUBLISHER_TOKEN ADMIN_TOKEN
unset ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY XAI_API_KEY GROQ_API_KEY
cd "\$DECK_HOME"
if [[ "\${1:-}" == --version ]]; then
  exec "\$PRIME_AGENT_BIN" --version
fi
catalog_probe="\$(printf '%s\\n%s\\n' \\
  '{"id":"models","type":"get_available_models"}' \\
  '{"id":"state","type":"get_state"}' | \\
  "\$PRIME_AGENT_BIN" --mode rpc --offline --no-session --daemon-socket "\$SOCKET" --provider deck 2>/dev/null)" || {
  printf 'error: Deck provider preflight failed\n' >&2
  exit 1
}
if ! printf '%s\\n' "\$catalog_probe" | node -e '
const fs = require("node:fs");
const frames = fs.readFileSync(0, "utf8").split("\\n")
  .filter((line) => line.trim().startsWith("{"))
  .map((line) => JSON.parse(line));
const models = frames.find((frame) => frame.command === "get_available_models" && frame.success === true);
const state = frames.find((frame) => frame.command === "get_state" && frame.success === true);
const deckModels = models?.data?.models?.filter((model) => model.provider === "deck") ?? [];
if (deckModels.length === 0 || state?.data?.model?.provider !== "deck") process.exit(1);
'; then
  printf 'error: Deck provider preflight found no Deck model or selected a non-Deck provider\n' >&2
  exit 1
fi
exec "\$PRIME_AGENT_BIN" --offline --daemon-socket "\$SOCKET" --provider deck "\$@"
EOF
mv -f "$wrapper_tmp" "$WRAPPER"
chmod 700 "$WRAPPER"

manifest_tmp="$MANIFEST_FILE.tmp.$$"
node -e '
const fs = require("node:fs");
const [file, profile, version, tag, commit, primeBin, repo, custodySha] = process.argv.slice(1);
fs.writeFileSync(file, `${JSON.stringify({
  profile,
  primeAgentVersion: version,
  primeAgentTag: tag,
  primeAgentCommit: commit,
  primeAgentBin: primeBin,
  deckRepo: repo,
  custodySha256: custodySha,
}, null, 2)}\n`);
' "$manifest_tmp" "$PROFILE_ID" "$PINNED_VERSION" "$PINNED_TAG" "$PINNED_COMMIT" "$PRIME_BIN" "$REPO_ROOT" "$custody_sha"
mv -f "$manifest_tmp" "$MANIFEST_FILE"
chmod 444 "$MANIFEST_FILE"

printf 'Prime conversation profile wired at %s\n' "$AGENT_DIR"
printf 'Pinned Prime Agent: %s (%s, %s)\n' "$PINNED_VERSION" "$PINNED_TAG" "$PINNED_COMMIT"
printf 'Enter: cd "%s" && "%s"\n' "$DECK_HOME" "$WRAPPER"
printf 'Rollback: cd "%s" && pi\n' "$DECK_HOME"
