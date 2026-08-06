#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'verify-clean-install: ERROR: %s\n' "$*" >&2
  exit 1
}

for prerequisite in bun cmp curl git grep python3 sed tr wc; do
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
  rm -rf "$CLONE_DIR" "$SANDBOX_HOME"
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

# A foreign pi command must stop even piped bootstrap before clone, downloads,
# dependency installation, or any Deck-home mutation.
FOREIGN_PI="$SANDBOX_HOME/.local/bin/pi"
printf '#!/bin/sh\nprintf "foreign pi must survive\\n"\n' > "$FOREIGN_PI"
chmod +x "$FOREIGN_PI"
COLLISION_TOOLS="$SANDBOX_HOME/collision-path"
mkdir -p "$COLLISION_TOOLS"
for tool in bash bun curl node npm python3 tar; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$tool_path" ]; then ln -s "$tool_path" "$COLLISION_TOOLS/$tool"; fi
done
cat > "$COLLISION_TOOLS/git" <<'EOF'
#!/bin/sh
: > "$MOCK_GIT_CALLED"
exit 91
EOF
chmod +x "$COLLISION_TOOLS/git"
PIPED_REPO="$SANDBOX_HOME/piped-deck"
MOCK_GIT_CALLED="$SANDBOX_HOME/git-called"
set +e
COLLISION_OUTPUT="$(env HOME="$SANDBOX_HOME" \
  PATH="$COLLISION_TOOLS:/usr/bin:/bin" \
  BIN_TARGET="$SANDBOX_HOME/.local/bin" \
  DECK_REPO="$PIPED_REPO" \
  DECK_REPO_URL="https://invalid.example/deck.git" \
  MOCK_GIT_CALLED="$MOCK_GIT_CALLED" \
  bash -s < "$CLONE_DIR/install.sh" 2>&1)"
COLLISION_STATUS=$?
set -e
[ "$COLLISION_STATUS" -ne 0 ] || fail "foreign pi shim did not stop piped bootstrap"
printf '%s\n' "$COLLISION_OUTPUT"
case "$COLLISION_OUTPUT" in
  *"$FOREIGN_PI already exists and is not the Deck pi shim; no changes were made."*) ;;
  *) fail "foreign pi failure did not explain the collision" ;;
esac
EXPECTED_REMEDIATION="git clone https://invalid.example/deck.git $PIPED_REPO && BIN_TARGET=$SANDBOX_HOME/.local/deck-bin bash $PIPED_REPO/install.sh"
case "$COLLISION_OUTPUT" in
  *"$EXPECTED_REMEDIATION"*) ;;
  *) fail "foreign pi failure did not print an exact BIN_TARGET remediation" ;;
esac
[ ! -e "$MOCK_GIT_CALLED" ] || fail "foreign pi collision was detected after a git command"
[ ! -e "$PIPED_REPO" ] || fail "foreign pi collision was detected after repository mutation"
[ ! -e "$SANDBOX_HOME/.deck" ] ||
  fail "foreign pi collision was detected after Deck-home mutation"
[ ! -e "$SANDBOX_HOME/.cache" ] ||
  fail "foreign pi collision was detected after a download or runtime bootstrap"
BIN_ENTRIES="$(python3 - "$SANDBOX_HOME/.local/bin" <<'PY'
from pathlib import Path
import sys

print(",".join(sorted(path.name for path in Path(sys.argv[1]).iterdir())))
PY
)"
[ "$BIN_ENTRIES" = pi ] ||
  fail "foreign pi collision mutated BIN_TARGET: $BIN_ENTRIES"
[ "$(cat "$FOREIGN_PI")" = '#!/bin/sh
printf "foreign pi must survive\n"' ] || fail "foreign pi command was modified"

DECK_BIN="$SANDBOX_HOME/.local/deck-bin"

printf 'verify-clean-install: bootstrapping with HOME=%s\n' "$SANDBOX_HOME"
env HOME="$SANDBOX_HOME" \
  PATH="$INSTALL_PATH" \
  DECK_HOME_PROFILE= \
  DECK_V2_HOME="$SANDBOX_HOME/.deck" \
  INSTALL_TARGET="$SANDBOX_HOME/.deck/.pi" \
  BIN_TARGET="$DECK_BIN" \
  WORKFLOWS_SOURCE="$CLONE_DIR/workflows" \
  WORKFLOWS_LINK="$SANDBOX_HOME/.deck/workflows" \
  PI_CODING_AGENT_DIR="$SANDBOX_HOME/.pi/agent" \
  bash "$CLONE_DIR/install.sh"

DECK_HOME="$SANDBOX_HOME/.deck"
PI_HOME="$DECK_HOME/.pi"
for extension in deck-questions deck-ship deck-recall; do
  [ -f "$PI_HOME/extensions/$extension/index.ts" ] ||
    fail "fresh install is missing $extension/index.ts"
done
[ -x "$DECK_BIN/pi" ] || fail "fresh install is missing the pinned pi command"
[ -x "$DECK_BIN/deck-v2" ] || fail "fresh install is missing deck-v2"
[ -x "$DECK_BIN/deck" ] || fail "fresh install is missing deck"
[ -x "$DECK_BIN/smithers" ] || fail "fresh install is missing smithers"
[ -x "$DECK_BIN/uv" ] || fail "fresh install is missing pinned uv"
[ -x "$DECK_BIN/uvx" ] || fail "fresh install is missing pinned uvx"
UV_DESCRIPTION="$("$DECK_BIN/uv" --version 2>&1)" ||
  fail "freshly installed uv cannot run"
case "$UV_DESCRIPTION" in
  "uv 0.11.8"|"uv 0.11.8 "*) ;;
  *) fail "fresh install has $UV_DESCRIPTION instead of pinned uv 0.11.8" ;;
esac
[ "$(cat "$FOREIGN_PI")" = '#!/bin/sh
printf "foreign pi must survive\n"' ] ||
  fail "alternate BIN_TARGET install overwrote the foreign pi command"
ENTER_PI="$(env HOME="$SANDBOX_HOME" PATH="$INSTALL_PATH" \
  bash -c '. "$HOME/.deck/enter.sh" >/dev/null; command -v pi')"
[ "$ENTER_PI" = "$DECK_BIN/pi" ] ||
  fail "enter.sh did not activate remediated BIN_TARGET (got $ENTER_PI)"

KERNEL_PROBE="$SANDBOX_HOME/kernel-tool-runtime.txt"
HOME="$SANDBOX_HOME" "$DECK_BIN/uv" \
  run --isolated --no-project --python 3.11 --with ipykernel python -I - "$KERNEL_PROBE" <<'PY' ||
  fail "installed uv could not bootstrap and execute the seat's IPython tool runtime"
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
[ "$(cat "$KERNEL_PROBE" 2>/dev/null)" = "kernel-tool-runtime-ok" ] ||
  fail "IPython kernel started but did not execute its filesystem probe"

cmp "$CLONE_DIR/v2/seed/AGENTS.md" "$DECK_HOME/AGENTS.md" >/dev/null ||
  fail "installed AGENTS.md does not match the public seed"
AGENTS_SIZE="$(wc -c < "$DECK_HOME/AGENTS.md" | tr -d '[:space:]')"
[ "$AGENTS_SIZE" -lt 12288 ] || fail "installed AGENTS.md is $AGENTS_SIZE bytes (must be under 12288)"

REVIEWERS_FILE="$DECK_HOME/config/reviewers.json"
[ -f "$REVIEWERS_FILE" ] || fail "fresh install is missing private reviewer config"
env REVIEWERS_FILE="$REVIEWERS_FILE" bun -e '
  const config = await Bun.file(process.env.REVIEWERS_FILE).json();
  const keys = ["selfLogins", "excludedApprovers", "reviewerDenylist", "reviewers"];
  if (keys.some((key) => !Array.isArray(config[key]) || config[key].length !== 0)) process.exit(1);
' || fail "fresh reviewer config must contain only empty public defaults"

PROBE="$SANDBOX_HOME/verify-deck-tools.mjs"
cat > "$PROBE" <<'EOF'
export default function verifyDeckInstall(pi) {
  pi.registerCommand("verify-deck-install", {
    description: "Report clean-install resources",
    handler: async (_args, ctx) => {
      const tools = pi.getAllTools().map((tool) => tool.name).sort();
      const contexts = (ctx.getSystemPromptOptions().contextFiles ?? []).map((file) => file.path);
      ctx.ui.notify(`DECK_TOOLS:${tools.join(",")}`, "info");
      ctx.ui.notify(`DECK_CONTEXT:${contexts.join(",")}`, "info");
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
    PI_CODING_AGENT_DIR="$SANDBOX_HOME/.pi/agent" \
    pi --mode rpc --no-session --offline --approve --extension "$PROBE"
) 2>&1)" || {
  printf '%s\n' "$RPC_OUTPUT" >&2
  fail "fresh Pi RPC session failed"
}
printf '%s\n' "$RPC_OUTPUT"

case "$RPC_OUTPUT" in
  *'"command":"get_commands","success":true'*) ;;
  *) fail "fresh Pi session did not answer get_commands" ;;
esac
case "$RPC_OUTPUT" in
  *'"name":"questions"'*) ;;
  *) fail "deck-questions did not register /questions" ;;
esac
case "$RPC_OUTPUT" in
  *'DECK_CONTEXT:'*'/AGENTS.md'*) ;;
  *) fail "fresh Pi session did not read the Deck-home AGENTS.md" ;;
esac
TOOLS_LINE="$(printf '%s\n' "$RPC_OUTPUT" | sed -n 's/.*\(DECK_TOOLS:[^"]*\).*/\1/p' | sed -n '1p')"
[ -n "$TOOLS_LINE" ] || fail "fresh Pi session did not report loaded tools"
for tool in ask_captain list_questions answer_question ship adopt status recall_effort; do
  case ",${TOOLS_LINE#DECK_TOOLS:}," in
    *",$tool,"*) ;;
    *) fail "fresh Pi session did not load tool $tool" ;;
  esac
done

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
PERSONAL_PATTERN='/Users/[^/[:space:]]+|deckbox|(^|[^[:alnum:]_])(twaldin|ali|mackcooper1408|spencer-negri|daniel-covelli|akshat-lindy|Tim|Sathiral|Jeremy)([^[:alnum:]_]|$)'
if git -C "$CLONE_DIR" grep -nEI "$PERSONAL_PATTERN" -- "${PERSONAL_SCAN_FILES[@]}"; then
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
PUBLIC_VOCAB_PATTERN='(^|[^[:alnum:]_])(captain|deckbox|tailnet)([^[:alnum:]_]|$)'
if git -C "$CLONE_DIR" grep -nEI "$PUBLIC_VOCAB_PATTERN" -- "${PUBLIC_COPY_FILES[@]}"; then
  fail "public onboarding copy contains operator-specific vocabulary"
fi

printf 'verify-clean-install: PASS commit=%s home=%s tools=%s AGENTS=%s-bytes\n' \
  "$SOURCE_COMMIT" "$DECK_HOME" "${TOOLS_LINE#DECK_TOOLS:}" "$AGENTS_SIZE"
