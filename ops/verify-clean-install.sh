#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'verify-clean-install: ERROR: %s\n' "$*" >&2
  exit 1
}

for prerequisite in bun cmp curl git grep node npm python3 sed shasum tar tr wc; do
  command -v "$prerequisite" >/dev/null 2>&1 || fail "$prerequisite is required"
done

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
VERIFY_REF="${DECK_VERIFY_REF:-HEAD}"
SOURCE_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse "$VERIFY_REF^{commit}")" ||
  fail "cannot resolve DECK_VERIFY_REF=$VERIFY_REF"
CLONE_DIR="${TMPDIR:-/tmp}/deck-clone-$$"
SANDBOX_HOME="${TMPDIR:-/tmp}/deck-home-$$"
ORIGINAL_PATH="$PATH"

[ ! -e "$CLONE_DIR" ] || fail "temporary clone already exists: $CLONE_DIR"
[ ! -e "$SANDBOX_HOME" ] || fail "temporary home already exists: $SANDBOX_HOME"
cleanup() {
  # uv's cache stores read-only archive entries, so a plain rm -rf cannot remove
  # the directory. Restore write permission first, and never let teardown decide
  # the script's exit status — the verification result is what matters.
  chmod -R u+w "$CLONE_DIR" "$SANDBOX_HOME" 2>/dev/null || true
  rm -rf "$CLONE_DIR" "$SANDBOX_HOME" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

printf 'verify-clean-install: cloning %s at %s\n' "$SOURCE_ROOT" "$SOURCE_COMMIT"
git clone --no-checkout "$SOURCE_ROOT" "$CLONE_DIR"
git -C "$CLONE_DIR" checkout --detach "$SOURCE_COMMIT"
mkdir -p "$SANDBOX_HOME"
TOOLS_DIR="$SANDBOX_HOME/verify-path"
mkdir -p "$TOOLS_DIR" "$SANDBOX_HOME/.local/bin"
for tool in bash bun curl git node npm python3 tar; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$tool_path" ]; then ln -s "$tool_path" "$TOOLS_DIR/$tool"; fi
done
INSTALL_PATH="$TOOLS_DIR:/usr/bin:/bin"

# Deck no longer owns or installs a `pi` executable. A pre-existing command is
# deliberately irrelevant and must survive a Prime-only install untouched.
FOREIGN_PI="$SANDBOX_HOME/.local/bin/pi"
printf '#!/bin/sh\nprintf "foreign command survived\\n"\n' > "$FOREIGN_PI"
chmod +x "$FOREIGN_PI"

DECK_BIN="$SANDBOX_HOME/.local/deck-bin"

printf 'verify-clean-install: bootstrapping with HOME=%s\n' "$SANDBOX_HOME"
env HOME="$SANDBOX_HOME" \
  PATH="$INSTALL_PATH" \
  DECK_HOME_PROFILE= \
  DECK_V2_HOME="$SANDBOX_HOME/.deck" \
  BIN_TARGET="$DECK_BIN" \
  WORKFLOWS_SOURCE="$CLONE_DIR/workflows" \
  WORKFLOWS_LINK="$SANDBOX_HOME/.deck/workflows" \
  bash "$CLONE_DIR/install.sh"

DECK_HOME="$SANDBOX_HOME/.deck"
PRIME_HOME="$DECK_HOME/.prime"
for extension in deck-questions deck-recall deck-usage; do
  [ -f "$PRIME_HOME/agent/extensions/$extension/index.ts" ] ||
    fail "fresh install is missing Prime extension $extension/index.ts"
done
[ -f "$PRIME_HOME/agent/extensions/deck-provider.ts" ] ||
  fail "fresh install is missing the Deck Prime provider"
[ -x "$DECK_BIN/prime-agent" ] || fail "fresh install is missing prime-agent"
[ -x "$DECK_BIN/prime-conversation" ] || fail "fresh install is missing prime-conversation"
[ -x "$DECK_BIN/deck-v2" ] || fail "fresh install is missing deck-v2"
[ -x "$DECK_BIN/deck" ] || fail "fresh install is missing deck"
[ -x "$DECK_BIN/smithers" ] || fail "fresh install is missing smithers"
[ -x "$DECK_BIN/uv" ] || fail "fresh install is missing pinned uv"
[ -x "$DECK_BIN/uvx" ] || fail "fresh install is missing pinned uvx"
[ ! -e "$DECK_BIN/pi" ] || fail "fresh install produced a retired pi shim"
[ ! -e "$DECK_HOME/.pi" ] || fail "fresh install produced a retired .pi home"
PRIME_VERSION="$("$DECK_BIN/prime-agent" --version 2>&1)" ||
  fail "freshly installed prime-agent cannot run"
# Derived from the reviewed patch manifest so a version bump needs one edit.
PINNED_PRIME_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).base.version)' "$(dirname "$0")/../patches/prime-agent/manifest.json")"
[ "$PRIME_VERSION" = "$PINNED_PRIME_VERSION" ] ||
  fail "fresh install has Prime Agent $PRIME_VERSION instead of pinned $PINNED_PRIME_VERSION"
UV_DESCRIPTION="$("$DECK_BIN/uv" --version 2>&1)" ||
  fail "freshly installed uv cannot run"
case "$UV_DESCRIPTION" in
  "uv 0.11.8"|"uv 0.11.8 "*) ;;
  *) fail "fresh install has $UV_DESCRIPTION instead of pinned uv 0.11.8" ;;
esac
[ "$(cat "$FOREIGN_PI")" = '#!/bin/sh
printf "foreign command survived\n"' ] ||
  fail "Prime-only install modified an unrelated command"
ENTER_PRIME="$(env HOME="$SANDBOX_HOME" PATH="$INSTALL_PATH" \
  bash -c '. "$HOME/.deck/enter.sh" >/dev/null; command -v prime-conversation')"
[ "$ENTER_PRIME" = "$DECK_BIN/prime-conversation" ] ||
  fail "enter.sh did not activate Prime conversation (got $ENTER_PRIME)"

KERNEL_PROBE="$SANDBOX_HOME/kernel-tool-runtime.txt"
if ! HOME="$SANDBOX_HOME" "$DECK_BIN/uv" \
  run --isolated --no-project --python 3.11 --with ipykernel \
  python -I - "$KERNEL_PROBE" <<'PY'
from pathlib import Path
import sys

from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpec

probe = Path(sys.argv[1])
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
    display_name="Deck clean-install verification",
    language="python",
    env={},
)
client = None
try:
    kernel.start_kernel()
    client = kernel.client()
    client.start_channels()
    client.wait_for_ready(timeout=30)
    message_id = client.execute(
        f"import sys; from pathlib import Path; Path({str(probe)!r}).write_text(sys.executable)"
    )
    while True:
        reply = client.get_shell_msg(timeout=30)
        if reply.get("parent_header", {}).get("msg_id") == message_id:
            if reply["content"].get("status") != "ok":
                raise RuntimeError(reply["content"])
            break
    if probe.read_text() != sys.executable:
        raise RuntimeError("kernel did not use the uv-managed Python")
    probe.write_text("kernel-tool-runtime-ok")
finally:
    try:
        if client is not None:
            client.stop_channels()
    finally:
        if kernel.has_kernel:
            kernel.shutdown_kernel(now=True)
PY
then
  fail "installed uv could not bootstrap and execute the seat's IPython tool runtime"
fi
[ "$(cat "$KERNEL_PROBE" 2>/dev/null)" = "kernel-tool-runtime-ok" ] ||
  fail "IPython kernel started but did not execute its filesystem probe"

cmp "$CLONE_DIR/v2/seed/AGENTS.md" "$DECK_HOME/AGENTS.md" >/dev/null ||
  fail "installed AGENTS.md does not match the public seed"
AGENTS_SIZE="$(wc -c < "$DECK_HOME/AGENTS.md" | tr -d '[:space:]')"
# Budget is injected into EVERY session, so it stays tight. It moved from 12288
# once, deliberately, to fit three things a production repo cannot ship without:
# the human-reviewer contract, the global-memory privacy boundary, and the CLI
# table. Keep this in lockstep with v2/test/home.test.ts. It moved again to
# 7168 for the wake contract; see the rationale in v2/test/home.test.ts.
[ "$AGENTS_SIZE" -lt 7168 ] || fail "installed AGENTS.md is $AGENTS_SIZE bytes (must be under 7168)"

REVIEWERS_FILE="$DECK_HOME/config/reviewers.json"
[ -f "$REVIEWERS_FILE" ] || fail "fresh install is missing private reviewer config"
env REVIEWERS_FILE="$REVIEWERS_FILE" bun -e '
  const config = await Bun.file(process.env.REVIEWERS_FILE).json();
  const keys = ["selfLogins", "excludedApprovers", "reviewerDenylist", "reviewers"];
  if (keys.some((key) => !Array.isArray(config[key]) || config[key].length !== 0)) process.exit(1);
' || fail "fresh reviewer config must contain only empty public defaults"

mkdir -p "$DECK_HOME/run"

PROBE="$SANDBOX_HOME/verify-deck-tools.mjs"
cat > "$PROBE" <<'EOF'
export default function verifyDeckInstall(agent) {
  agent.registerCommand("verify-deck-install", {
    description: "Report clean-install resources",
    handler: async (_args, ctx) => {
      const tools = agent.getAllTools().map((tool) => tool.name).sort();
      const systemPrompt = ctx.getSystemPrompt();
      ctx.ui.notify(`DECK_TOOLS:${tools.join(",")}`, "info");
      ctx.ui.notify(`DECK_CONTEXT:${systemPrompt.includes("# Deck home")}`, "info");
    },
  });
}
EOF

RPC_OUTPUT="$({
  printf '%s\n' '{"type":"prompt","id":"probe","message":"/verify-deck-install"}'
  printf '%s\n' '{"type":"get_commands","id":"commands"}'
} | (
  cd "$DECK_HOME"
  env HOME="$SANDBOX_HOME" \
    PATH="$DECK_BIN:$ORIGINAL_PATH" \
    DECK_V2_HOME="$DECK_HOME" \
    DECK_HERDR_AUTO_ATTACH=0 \
    PRIME_AGENT_CODING_AGENT_DIR="$PRIME_HOME/agent" \
    PRIME_AGENT_SESSION_DIR="$PRIME_HOME/sessions" \
    RLM_MAX_DEPTH=1 \
    "$DECK_BIN/prime-agent" --mode rpc --no-session --offline --provider deck \
      --daemon-socket "$DECK_HOME/run/prime-agent.sock" --extension "$PROBE"
) 2>&1)" || {
  printf '%s\n' "$RPC_OUTPUT" >&2
  fail "fresh Prime RPC conversation failed"
}
printf '%s\n' "$RPC_OUTPUT"

case "$RPC_OUTPUT" in
  *'"command":"get_commands","success":true'*) ;;
  *) fail "fresh Prime conversation did not answer get_commands" ;;
esac
for command in questions quota; do
  case "$RPC_OUTPUT" in
    *"\"name\":\"$command\""*) ;;
    *) fail "Prime extension pack did not register /$command" ;;
  esac
done
case "$RPC_OUTPUT" in
  *'DECK_CONTEXT:true'*) ;;
  *) fail "fresh Prime conversation did not load the Deck-home AGENTS.md" ;;
esac
TOOLS_LINE="$(printf '%s\n' "$RPC_OUTPUT" | sed -n 's/.*\(DECK_TOOLS:[^"]*\).*/\1/p' | sed -n '1p')"
[ -n "$TOOLS_LINE" ] || fail "fresh Prime conversation did not report loaded tools"
# EXACT, not a denylist: code execution is the only tool. Checking that known
# retired names are absent would let a NEW pi-tool creep in unnoticed.
case "${TOOLS_LINE#DECK_TOOLS:}" in
  "ipython") ;;
  *) fail "the agent tool surface must be exactly ipython; got: ${TOOLS_LINE#DECK_TOOLS:}" ;;
esac

# A minimal tool surface is only correct if the code surface replaced it. The
# kernel gets `deck` through PYTHONPATH, and auto-imports it through IPYTHONDIR,
# both of which the wrapper must export past `env -i`.
PROFILE_PY="$DECK_HOME/.prime/python/deck/__init__.py"
[ -f "$PROFILE_PY" ] || fail "the deck Python surface was not installed at $PROFILE_PY"
[ -f "$DECK_HOME/.prime/ipython/profile_default/startup/00-deck.py" ] \
  || fail "the kernel startup file that imports deck was not installed"
PYTHONPATH="$DECK_HOME/.prime/python" python3 -c 'import deck; assert "deck.ship" in deck.help()' \
  || fail "the deck Python surface does not import cleanly"
grep -q 'PYTHONPATH IPYTHONDIR' "$DECK_HOME/.prime/bin/prime-conversation" \
  || fail "the wrapper does not pass PYTHONPATH/IPYTHONDIR through env -i; the kernel would not see deck"

[ -z "$(git -C "$CLONE_DIR" status --porcelain)" ] || {
  git -C "$CLONE_DIR" status --short >&2
  fail "bootstrap modified the clean checkout"
}

PERSONAL_SCAN_FILES=(
  README.md
  AGENTS.md
  install.sh
  update.sh
  scripts/update-home.sh
  v2/README.md
  v2/seed/AGENTS.md
  v2/seed/README.md
  v2/src/projects.ts
  docs/LAPTOP-AGENTS.md
  v2/src/signature.ts
  docs/gateway-auth.md
  docs/personal-home.md
  workflows/pr-pipeline/README.md
  workflows/pr-pipeline/pipeline.tsx
  workflows/pr-pipeline/lib/models.ts
  workflows/pr-pipeline/lib/profiles.ts
  workflows/pr-pipeline/lib/ready.ts
  workflows/pr-pipeline/lib/reviewers.ts
  workflows/review-gate/launch.ts
  workflows/review-gate/pipeline.tsx
)
# Both scans derive their words from ops/forbidden-vocabulary.txt, which is
# split into [identities] (banned everywhere, including source) and
# [vocabulary] (banned in human-facing copy only, because some of those words
# are persisted workflow and node identifiers).
vocab_section() {
  awk -v want="[$1]" '
    /^\[/ { inside = ($0 == want); next }
    inside && !/^[[:space:]]*(#|$)/ { print }
  ' "$CLONE_DIR/ops/forbidden-vocabulary.txt" | paste -sd '|' -
}
IDENTITY_WORDS="$(vocab_section identities)"
VOCAB_WORDS="$(vocab_section vocabulary)"
[ -n "$IDENTITY_WORDS" ] && [ -n "$VOCAB_WORDS" ] || fail "ops/forbidden-vocabulary.txt is empty or malformed"

# Absolute home paths: case-SENSITIVE. `/Users/` is a real macOS path, while
# `/users/{login}` is an ordinary API route and must not trip this.
if git -C "$CLONE_DIR" grep -nEI '/Users/[^/[:space:]]+' -- "${PERSONAL_SCAN_FILES[@]}"; then
  fail "shipped defaults or onboarding surfaces contain absolute home paths"
fi
# Identities: case-insensitive, since a name is a name however it is capitalized.
if git -C "$CLONE_DIR" grep -nEIi "(^|[^[:alnum:]_])($IDENTITY_WORDS)([^[:alnum:]_]|$)" -- "${PERSONAL_SCAN_FILES[@]}"; then
  fail "shipped defaults or onboarding surfaces contain machine-specific identities"
fi

DEFAULT_GITHUB_BLOCK="$(sed -n '/export const DEFAULT_GITHUB/,/^};/p' "$CLONE_DIR/workflows/pr-pipeline/pipeline.tsx")"
for key in selfLogins excludedApprovers reviewerDenylist reviewers; do
  if ! printf '%s\n' "$DEFAULT_GITHUB_BLOCK" |
    grep -Eq "^[[:space:]]*$key:[[:space:]]*\\[\\]([[:space:]]+as[[:space:]]+string\\[\\])?,"; then
    fail "workflow default $key must be empty; private values belong in ~/.deck/config/reviewers.json"
  fi
done

PUBLIC_COPY_FILES=(
  README.md
  AGENTS.md
  install.sh
  update.sh
  scripts/update-home.sh
  v2/README.md
  v2/seed/AGENTS.md
  v2/seed/README.md
  docs/LAPTOP-AGENTS.md
  docs/gateway-auth.md
  docs/personal-home.md
)
# Human-facing copy: identities AND internal role/product vocabulary.
if git -C "$CLONE_DIR" grep -nEIi "(^|[^[:alnum:]_])($IDENTITY_WORDS|$VOCAB_WORDS)([^[:alnum:]_]|$)" -- "${PUBLIC_COPY_FILES[@]}"; then
  fail "public onboarding copy contains operator-specific vocabulary"
fi

printf 'verify-clean-install: PASS commit=%s home=%s tools=%s AGENTS=%s-bytes\n' \
  "$SOURCE_COMMIT" "$DECK_HOME" "${TOOLS_LINE#DECK_TOOLS:}" "$AGENTS_SIZE"
