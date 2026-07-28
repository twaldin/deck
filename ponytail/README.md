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

## Provenance and license

Vendored from `DietrichGebert/ponytail` (MIT), including its `LICENSE`; the source repository and upstream pi entrypoint are recorded above. Deck's model-family gate is the only local behavior change to the upstream extension.

## Uninstall

Remove the installed paths (not the source checkout):

```sh
rm -rf ~/.pi/agent/extensions/ponytail ~/.pi/agent/skills/ponytail{,-review,-audit,-debt,-gain,-help}
```
