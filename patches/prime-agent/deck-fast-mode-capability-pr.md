# Title

Allow Fast mode for capable custom OpenAI-compatible providers

# Pull request body

## Summary

- add an explicit, opt-in `supportsFastMode` capability to custom model definitions
- let the existing Fast-mode predicate accept supported GPT-5.4, GPT-5.5, and GPT-5.6-family models on capable OpenAI-compatible routes
- serialize `service_tier: "priority"` from the existing session `serviceTier` option on those routes
- preserve the current ChatGPT-authenticated `openai-codex` behavior and leave every unflagged custom or API-key route unchanged

## Problem

`/fast` currently gates on provider identity: it accepts supported models only when they use the built-in `openai-codex` provider. A custom provider can expose the same supported ChatGPT-authenticated models and can route `service_tier` correctly, but Prime rejects `/fast` before a request reaches that provider. In addition, the OpenAI-compatible completions transport does not currently serialize the session's service tier.

This makes Fast mode unavailable for valid custom routes even when the route can realize it end to end.

## Approach

Capability is explicit rather than inferred from a provider name, model name alone, or base URL. Custom models default to unsupported. A provider must set `supportsFastMode: true`, and the model must still be in the documented GPT-5.4, GPT-5.5, or GPT-5.6 family. Only then does Prime accept `/fast` and send `service_tier: "priority"`.

The opt-in matters because OpenAI API-key Priority processing is separately billed and is not the ChatGPT credit feature. This change must not relabel arbitrary API-key providers as ChatGPT Fast mode.

## Tests

`packages/ai/test/fast-mode.test.ts` covers:

- the existing built-in ChatGPT-authenticated models
- opted-in custom OpenAI-compatible models
- rejection of unsupported models and unflagged/API-key providers
- `service_tier: "priority"` serialization for an opted-in route
- unchanged payloads for an unflagged route
