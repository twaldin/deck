# Pi deck provider

## Fast mode

Append `:fast` to an OpenAI model, such as `deck/gpt-5.6-luna:fast`. The broker strips the suffix and sends `service_tier: "priority"` to OpenAI. Priority processing has a **2x cost multiplier** over standard processing. Non-OpenAI models with `:fast` are rejected.

## Installed wiring

Pi is installed at `~/.nvm/versions/node/v24.8.0/bin/pi`. Its installed source supports custom providers both in `~/.pi/agent/models.json` and through the extension API `pi.registerProvider(name, config)`. There is no custom base-URL CLI flag; `-e` only loads an extension for that invocation.

The checked-in extension is `broker/pi/deck-provider.ts`. A new auto-discovered global extension at `~/.pi/agent/extensions/deck-provider.ts` re-exports it, so normal `pi` invocations register `deck` without changing the existing `settings.json` or `models.json`.

`deck` uses the OpenAI-compatible ingress at `http://127.0.0.1:8377/v1` and declares these broker aliases:

- `claude-sonnet-4-5`
- `claude-haiku-4-5`
- `claude-fable-5`
- `gpt-5.6-sol`

The broker's `/v1/models` response uses provider-qualified IDs, while its resolver also accepts these unqualified aliases. Pi needs an explicit declaration only for models selected through the custom provider. The extension declares the full Deck seat catalog: `claude-sonnet-4-5`, `claude-haiku-4-5`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `grok-4.5`, `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra`.

## Native reasoning selectors

Use `--thinking xhigh` (or a model selector suffix such as `deck/gpt-5.6-sol:xhigh`) for OpenAI-compatible Deck models. The broker accepts the fixed pi effort vocabulary: `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The broker validates unsupported levels per model, clamps to the nearest supported value, and logs the requested and effective values once per session. Claude models use the OpenAI-compatible ingress. The registered Grok model maps pi levels to xAI's `reasoning_effort` values (`low`, `medium`, or `high`). Explicit numeric Anthropic `budget:<tokens>` selectors are supported by the broker helper, but are not part of pi's `--thinking` vocabulary.

The catalog metadata in `deck-provider.ts` lists the selectable surface. The broker maps unsupported selectors to the nearest supported value and logs the requested and effective levels once per session.

## Reasoning capability table

This is the ground truth for the Deck aliases registered by the extension. The values are the native values sent through the OpenAI-compatible broker ingress.

| Deck model family | Provider surface | Supported levels | Native request |
|---|---|---|---|
| `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` | OpenAI/Codex | `low`, `medium`, `high`, `xhigh` | `reasoning_effort` |
| `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` | OpenAI/Codex | `low`, `medium`, `high`, `xhigh`, `max` | `reasoning_effort` |
| `claude-sonnet-4-5`, `claude-haiku-4-5` | Anthropic budget surface behind Deck | low through `xhigh` (`minimal` is accepted for Haiku) | `reasoning_effort` at Deck ingress; broker converts direct Anthropic requests to `thinking.budget_tokens` (minimum 1024) |
| `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5` | Anthropic adaptive surface behind Deck | `low`, `medium`, `high`, `xhigh`, `max` | `reasoning_effort` at Deck ingress |
| `grok-4.5` | xAI | `low`, `medium`, `high` | `reasoning_effort` |

Vendor references:

- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)
- [Anthropic extended thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking) (budget tokens must be at least 1024)
- [xAI reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) (`grok-4.5` supports low, medium, and high)
- [Baseten reasoning](https://docs.baseten.co/inference/model-apis/reasoning) (Kimi K3 uses `enable_thinking` and supports `none`, `low`, `high`, and `max`; K3 is not a Deck alias)

The extension stores no token. Its `apiKey` is the command-backed reference `!cat ~/.deck/broker/gateway.token`; Pi resolves `!` commands at request time and `authHeader: true` sends the result as a bearer credential. Installed source for this behavior is in `dist/core/model-registry.js` and `dist/core/resolve-config-value.js` under the global `@mariozechner/pi-coding-agent` package.

The Deck provider uses OpenAI chat compatibility for every model. A live native-Anthropic probe reached the broker but the upstream plan rejected the third-party client shape, while the OpenAI-compatible path completed. Anthropic budget selectors remain supported by the broker validation helper, but pi's OpenAI-compatible client does not expose them as native Anthropic thinking payloads.

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
