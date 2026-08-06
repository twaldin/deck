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

printf 'verify-clean-install: bootstrapping with HOME=%s\n' "$SANDBOX_HOME"
env HOME="$SANDBOX_HOME" \
  PATH="$ORIGINAL_PATH" \
  DECK_HOME_PROFILE= \
  DECK_V2_HOME="$SANDBOX_HOME/.deck" \
  INSTALL_TARGET="$SANDBOX_HOME/.deck/.pi" \
  BIN_TARGET="$SANDBOX_HOME/.local/bin" \
  WORKFLOWS_SOURCE="$CLONE_DIR/workflows" \
  WORKFLOWS_LINK="$SANDBOX_HOME/.deck/workflows" \
  PI_CODING_AGENT_DIR="$SANDBOX_HOME/.pi/agent" \
  bash "$CLONE_DIR/install.sh"

DECK_HOME="$SANDBOX_HOME/.deck"
PI_HOME="$DECK_HOME/.pi"
for extension in deck-questions deck-ship deck-recall deck-subagents; do
  [ -f "$PI_HOME/extensions/$extension/index.ts" ] ||
    fail "fresh install is missing $extension/index.ts"
done
[ -x "$SANDBOX_HOME/.local/bin/pi" ] || fail "fresh install is missing the pinned pi command"
[ -x "$SANDBOX_HOME/.local/bin/deck-v2" ] || fail "fresh install is missing deck-v2"
[ -x "$SANDBOX_HOME/.local/bin/deck" ] || fail "fresh install is missing deck"
[ -x "$SANDBOX_HOME/.local/bin/smithers" ] || fail "fresh install is missing smithers"

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
    PATH="$SANDBOX_HOME/.local/bin:$ORIGINAL_PATH" \
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
for tool in ask_captain list_questions answer_question ship adopt status recall_effort subagent; do
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
  subagents/install.sh
  v2/README.md
  v2/seed/AGENTS.md
  v2/seed/README.md
  v2/src/projects.ts
  docs/LAPTOP-AGENTS.md
  docs/gateway-auth.md
  docs/personal-home.md
  workflows/pr-pipeline/README.md
  workflows/pr-pipeline/pipeline.tsx
  workflows/pr-pipeline/lib/models.ts
  workflows/pr-pipeline/lib/profiles.ts
  workflows/pr-pipeline/lib/ready.ts
  workflows/pr-pipeline/lib/reviewers.ts
  workflows/review-gate/launch.ts
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
