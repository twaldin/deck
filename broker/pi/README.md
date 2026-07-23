# Pi deck provider

## Installed wiring

Pi 0.73.0 is installed at `~/.nvm/versions/node/v24.8.0/bin/pi`. Its installed source supports custom providers both in `~/.pi/agent/models.json` and through the extension API `pi.registerProvider(name, config)`. There is no custom base-URL CLI flag; `-e` only loads an extension for that invocation.

The checked-in extension is `broker/pi/deck-provider.ts`. A new auto-discovered global extension at `~/.pi/agent/extensions/deck-provider.ts` re-exports it, so normal `pi` invocations register `deck` without changing the existing `settings.json` or `models.json`.

`deck` uses the OpenAI-compatible ingress at `http://127.0.0.1:8377/v1` and declares these broker aliases:

- `claude-sonnet-4-5`
- `claude-haiku-4-5`
- `claude-fable-5`
- `gpt-5.6-sol`

The broker's `/v1/models` response uses provider-qualified IDs, while its resolver also accepts these unqualified aliases. Pi needs an explicit declaration only for models selected through the custom provider.

The extension stores no token. Its `apiKey` is the command-backed reference `!cat ~/.deck/broker/gateway.token`; Pi resolves `!` commands at request time and `authHeader: true` sends the result as a bearer credential. Installed source for this behavior is in `dist/core/model-registry.js` and `dist/core/resolve-config-value.js` under the global `@mariozechner/pi-coding-agent` package.

Pi also supports `api: "anthropic-messages"` custom models. This wiring deliberately uses OpenAI chat compatibility for every deck model: a live native-Anthropic probe reached the broker but the upstream plan rejected the third-party client shape, while the OpenAI-compatible path completed.

## Smoke evidence

Run a non-interactive, ephemeral call with a 32-token request cap:

```sh
DECK_PI_MAX_TOKENS=32 pi \
  --provider deck \
  --model claude-haiku-4-5 \
  --thinking off \
  --no-tools \
  --no-skills \
  --no-context-files \
  --no-session \
  -p "Reply with exactly: DECK_PI_SMOKE_OK"
```

Observed on 2026-07-22 through the live broker at `http://127.0.0.1:8377`:

```text
DECK_PI_SMOKE_OK
```

`DECK_PI_MAX_TOKENS` is optional and is intended for quota-safe probes. It can only lower a declared model limit; without it, Pi's OpenAI-compatible request path caps output at 32,000 tokens.
