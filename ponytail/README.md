# Ponytail for Deck

This package vendors the [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) pi extension and its six skills for Deck's crew. Ponytail injects a minimalism ladder into the main agent: **need to exist? → reuse → stdlib → native → installed dependency → one line → minimum that works**. It never removes validation, security, error handling, accessibility, or required tests.

## Install

```sh
./ponytail/install.sh
# safe test target:
INSTALL_TARGET="$(mktemp -d)" ./ponytail/install.sh
```

The installer copies into `$INSTALL_TARGET/extensions/ponytail` and `$INSTALL_TARGET/skills/ponytail*`; rerunning converges (including removal of stale extension files when `rsync` is available). It does not touch the live `~/.pi` during repository tests.

## Model-family gate

The wrapper uses pi's `session_start` model context. Claude/Anthropic-family models are enabled by the configured Ponytail default (normally `full`); GPT/OpenAI-family models default to `off`. An explicit persisted/session mode still wins, so operators can opt GPT lanes in with `/ponytail full` (or a persisted session entry). `PONYTAIL_DEFAULT_MODE` and config defaults do not override the GPT safety default on a fresh session; use the command to make the opt-in deliberate. Unknown families retain the configured default. The family check is in `pi-extension/index.js` (`modelFamily` / `defaultModeForModel`) and does not add advisor calls or models.

## GPT A/B plan

Before enabling GPT by default, run matched gpt-5.6 lanes on the same representative tasks, with Ponytail off and on, identical repository snapshots and tool/model settings, and at least several repetitions. Record input/output/thinking tokens, wall-clock time, changed LOC/files, test outcomes, and security/a11y regressions. Compare medians and task success; flip the default only if Ponytail does not worsen success and its token/time/LOC tradeoff is favorable. Preserve raw run metadata and task prompts so the result is reproducible.

## Upstream divergences

The vendored tree differs from `DietrichGebert/ponytail` in exactly three places:

1. **`pi-extension/index.js` hook paths.** Upstream requires `../hooks/*.js`, because upstream keeps `hooks/` as a sibling of `pi-extension/`. Deck's installer flattens `hooks/` *into* the installed extension directory, so the vendored copy requires `./hooks/*.js`.
2. **`hooks/package.json` (Deck-only file).** Consequence of divergence 1, and a real shipped bug worth remembering. `pi-extension/package.json` declares `"type": "module"` (upstream needs it for its own `node --test` scripts). Once the CommonJS hooks are copied *underneath* that package.json, Node reinterprets them as ESM and they fail with `ReferenceError: require is not defined in ES module scope`, so pi refuses to load the extension. Upstream never hits this only because its `hooks/` sit outside that package scope. This one-line `{ "type": "commonjs" }` scope marker pins the hooks back to CommonJS wherever they are copied. Do not delete it, and do not "fix" it by editing the hook files to ESM: they are shared verbatim with the Claude/Codex/OpenCode hook adapters, and keeping them byte-identical to upstream is what makes re-vendoring safe.
3. **Model-family gate.** `modelFamily` / `defaultModeForModel` in `pi-extension/index.js` default GPT/OpenAI-family sessions to `off` (see above).

Upstream was checked at `16f2980` and has not changed the pi-extension shape; there is nothing to re-vendor. When re-vendoring later, reapply all three divergences and re-verify with the load check below.

```sh
# packaging regression check: hooks must load as CommonJS after install
INSTALL_TARGET="$(mktemp -d)" ./ponytail/install.sh
node -e 'import(process.argv[1]).then(m=>console.log(typeof m.default))' \
  "$INSTALL_TARGET/extensions/ponytail/index.js"   # must print: function
```

## Provenance and license

Vendored from `DietrichGebert/ponytail` (MIT), including its `LICENSE`; the source repository and upstream pi entrypoint are recorded above. See Upstream divergences for the local changes.

## Uninstall

Remove the installed paths (not the source checkout):

```sh
rm -rf ~/.pi/agent/extensions/ponytail ~/.pi/agent/skills/ponytail{,-review,-audit,-debt,-gain,-help}
```
