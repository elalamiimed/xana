# DeepSeek API capability research — retrieved 2026-10-08

All facts below were fetched live from `api-docs.deepseek.com` on 2026-10-08 unless marked otherwise.
Uncertain / undocumented items are explicitly flagged. Nothing here is inferred silently.

## 0. CRITICAL: the model names in your project are retired

Your project calls `deepseek-chat` / `deepseek-reasoner`. **Those names no longer exist.**

- The current model table lists exactly two models: **`deepseek-flash`** (model version **DeepSeek-V4.1-Flash**) and **`deepseek-v4-pro`** (model version **DeepSeek-V4-Pro-0813**).
- Change Log, 2026-04-24: "The two legacy API model names, `deepseek-chat` and `deepseek-reasoner`, will be discontinued in three months (2026-07-24). During the current period, these two model names point to the non-thinking mode and thinking mode of `deepseek-v4-flash`, respectively."
- Release note, 2026-04-24: "⚠️ Note: deepseek-chat & deepseek-reasoner will be fully retired and inaccessible after Jul 24th, 2026, 15:59 (UTC Time)."
- Every current code sample on the site uses `deepseek-flash`.
- **Action:** switch `model` to `deepseek-flash` and verify with `GET https://api.deepseek.com/models`.

Also note: **thinking mode is ON by default** on both current models, and thinking is toggled with a DeepSeek-specific parameter (`thinking`, passed via `extra_body` in the OpenAI SDK) plus `reasoning_effort`. This is not a drop-in OpenAI parameter set — see §6.

## 1. Models, context windows, max output, pricing

| | `deepseek-flash` | `deepseek-v4-pro` |
|---|---|---|
| Model version | DeepSeek-V4.1-Flash | DeepSeek-V4-Pro-0813 |
| Base URL (OpenAI / Anthropic) | `https://api.deepseek.com` / `https://api.deepseek.com/anthropic` | same |
| Context length | 1M | 1M |
| Max output | 384K (max accepted `max_tokens` = 393216) | 384K |
| Thinking | non-thinking + thinking, **thinking default** | same |
| JSON output / tool calls / Responses API / Anthropic API / prefix completion | ✓ / ✓ / ✓ / ✓ / ✓ | ✓ / ✓ / ✓ / ✓ / ✓ |
| FIM completion (beta) | ✓ non-thinking mode only | ✓ non-thinking mode only |
| Vision | ✓ | ✗ |
| Concurrency limit | 2500 | 500 |
| Cache-hit input, off-peak / peak | $0.003 / $0.006 | $0.022 / $0.044 |
| Cache-miss input, off-peak / peak | $0.15 / $0.30 | $0.66 / $1.32 |
| Output, off-peak / peak | $0.60 / $1.20 | $1.98 / $3.96 |

Prices are USD per 1M tokens. Off-peak = half of peak. Peak hours are **01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, excluding Chinese public holidays**; everything else (incl. full weekends and Chinese public holidays) is off-peak.

`max_tokens` default when unset: **8K non-thinking, 64K thinking, 128K when `reasoning_effort="max"`**.

Legacy name routing that *is* still supported: `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted but are served by DeepSeek-V4.1-Flash and billed at the Flash price.

No newer models than the two above are listed. Latest release note on the site is V4.1-Flash, 2026-09-10.

### ⚠️ Contradiction in the official docs (uncertain — verify live)
Two pages dated 2026-09-10 disagree about `deepseek-v4-pro`:
- V4.1-Flash release note: "Starting at 04:00 UTC on Sept 14, 2026, all `deepseek-v4-pro` requests will route to V4.1-Flash at V4.1-Flash rates. This will continue until V4.1-Pro launches." … "We're phasing out V4-Pro."
- Change Log same date: "we have decided to continue providing API services for DeepSeek V4 Pro after September 14, 2026, with the billing method remaining unchanged."

The Change Log reads like a reversal issued in response to user demand, and the pricing page still lists v4-pro separately — but I cannot resolve this from the docs. **Verify with a live request before relying on v4-pro identity or price.**

## 2. Function / tool calling — supported

Yes, OpenAI-style: `tools` (only `type: "function"`), `tool_choice` (`none` | `auto` | `required` | `{"type":"function","function":{"name":...}}`), and responses carrying `message.tool_calls[]` with `id`, `type`, `function.name`, `function.arguments` (a JSON **string**), plus `finish_reason: "tool_calls"`. Defaults: `none` when no tools present, `auto` when tools present. The standard `openai` SDK works against `https://api.deepseek.com`.

Supported on **both** current models (pricing-page feature matrix). Tool use in thinking mode has been supported since DeepSeek-V3.2; both current models are V4.x.

Limitations (all from official docs):
- **`tool_choice: "required"` and named tool choice are NOT supported in thinking mode — the API returns a 400.** Since thinking is enabled by default, casual OpenAI-style code that sets a forced `tool_choice` will break unless thinking is disabled first. Biggest migration gotcha.
- **`reasoning_content` must be passed back on all subsequent requests when `tools` is present** (including turns with no tool call), or the API returns 400. When `tools` is absent it must not / need not be passed back (it is ignored).
- The Chat Completions API does **not** support inserting tool calls mid-conversation (inserting `system` messages mid-conversation is supported). Use the Anthropic API or Responses API for that.
- `arguments` "is a JSON string you parse yourself"; docs warn the model "does not always generate valid JSON, and may hallucinate parameters not defined by your function schema" → validate before executing.
- **`parallel_tool_calls` is not documented anywhere** in the request schema (the request-body reference lists messages, model, thinking, reasoning_effort, max_tokens, response_format, stop, stream, stream_options, temperature, top_p, tools, tool_choice, logprobs, top_logprobs, user_id, and deprecated frequency_penalty/presence_penalty — nothing else). Whether it is ignored, errors 422, or works is **uncertain**. No official statement on parallel tool call support exists. The official thinking-mode sample iterates `for tool in tool_calls`, which implies a response can contain more than one call, but that is inference, not a documented guarantee. (Third-party reports claim parallel calls occur, e.g. an Apidog tutorial and community issue trackers; treat as unverified.)
- `frequency_penalty` and `presence_penalty` are **deprecated and have no effect**.

### `strict` mode (Beta)
Available and supported in both thinking and non-thinking mode, but requires:
1. `base_url="https://api.deepseek.com/beta"`, and
2. `"strict": true` on **all** functions in `tools`.

The server validates your JSON Schema and errors on unsupported types. Supported: `object`, `string`, `number`, `integer`, `boolean`, `array`, `enum`, `anyOf`, plus `$ref`/`$def`. Every `object` must set **all** properties as `required` and set `additionalProperties: false`. Unsupported parameters: `string.minLength`/`maxLength`, `array.minItems`/`maxItems`. `string` supports `pattern` and `format` (`email`, `hostname`, `ipv4`, `ipv6`, `uuid`).

## 3. JSON output mode — supported, with mandatory prompt requirements

`response_format: {"type": "json_object"}` (default is `"text"`). Per the guide, you must:
1. set `response_format` to `json_object`;
2. **include the word "json" in the system or user prompt and provide an example of the desired JSON format**;
3. set `max_tokens` sensibly to avoid mid-string truncation;
4. accept that **"the API may occasionally return empty content"** — an acknowledged open issue the docs say they are working on.

The API reference adds a stronger warning: without instructing the model to produce JSON yourself, "the model may generate an unending stream of whitespace until the generation reaches the token limit, resulting in a long-running and seemingly 'stuck' request." Content may be truncated when `finish_reason="length"`.

Only `json_object` is documented — **there is no `json_schema` / structured-outputs mode**. Strict JSON *schema* enforcement exists only for tool-call schemas via `strict` mode (§2). Whether `json_object` is honored in thinking mode is **not explicitly stated**; the feature matrix marks JSON output ✓ for both models and no doc restricts it by mode, but I found no explicit confirmation — treat as uncertain.

## 4. Prefix completion and FIM — both supported (Beta)

- **Chat prefix completion** (`/chat/completions` on `/beta`): the last message must have `role: "assistant"` and `"prefix": true`; requires `base_url="https://api.deepseek.com/beta"`. Marked ✓ for both current models.
- **FIM completion** (`POST /completions` on `/beta`): `prompt` + optional `suffix`, `max_tokens` capped at **4K**, requires the `/beta` base URL, and the feature matrix says **non-thinking mode only** for both current models.
- Both were introduced 2024-07-25 and remain labeled Beta.

## 5. Context caching — automatic, on by default, no code changes

"Enabled by default for all users … without needing to modify their code." Disk-based. Each request builds a cache; a new request hits the cache only where its prefix **fully matches a persisted "cache prefix unit."** Because of the Sliding Window Attention design, "each cached prefix is an independent, complete unit."

Cache prefix units are persisted in three ways:
1. **At request boundaries** — at the end position of the user input and the end position of the model output.
2. **Common-prefix detection** — when the system sees a shared prefix across multiple requests, it persists that prefix as its own unit (so the *3rd* similar request can hit even if the first two missed).
3. **At fixed token intervals** for long inputs/outputs, so very long prefixes are not permanently uncacheable.

Hit/miss reporting: `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens` (`prompt_tokens` = hit + miss), plus `usage.prompt_tokens_details.cached_tokens` (same value as the hit count).

Cache-hit price: `deepseek-flash` **$0.003 off-peak / $0.006 peak** per 1M; `deepseek-v4-pro` **$0.022 / $0.044** per 1M — i.e. 50× cheaper than a miss on flash, 30× on v4-pro (off-peak both).

Other documented properties:
- Best-effort, "does not guarantee a 100% cache hit rate"; cache construction "takes seconds"; unused caches are cleared automatically, "usually within a few hours to a few days."
- Caching only matches the input prefix; output is still computed and remains random/temperature-dependent.
- `user_id` provides **KVCache isolation** between your end users (and note it also partitions cache, which can reduce cross-user hits).
- **Minimum token block size: NOT documented** on the current Context Caching page. The page mentions "fixed token intervals" without a number. Treat any specific minimum (e.g. 64 tokens, as in older DeepSeek docs) as **unverified for the current API**.
- V4.1-Flash reduced KV cache footprint to 1/4 the HBM and 1/8 the SSD storage of the previous generation.

## 6. Reasoning specifics

There is no separate reasoning model any more: reasoning = **thinking mode** of `deepseek-flash` / `deepseek-v4-pro`.

- **`reasoning_content`: yes.** Returned in `choices[0].message.reasoning_content`, at the same level as `content` ("For thinking mode only"). Usage also reports `completion_tokens_details.reasoning_tokens`.
- **Function calling in thinking mode: yes**, with the mandatory `reasoning_content` replay rule described in §2.
- **Temperature / top_p constraints** (all official):
  - Thinking mode **does not support `temperature`, `presence_penalty`, or `frequency_penalty`** — passing them does **not** error, it simply has no effect. (`temperature` is `<= 2`, default 1, and "has no effect in thinking mode.")
  - `top_p` **only takes effect in thinking mode**, effective range **0.95–1.0**; values below 0.95 are clamped to 0.95. In non-thinking mode it is **fixed at 1.0 and your value is ignored**.
- **Toggles:** `thinking: {"type": "enabled"|"disabled"}` (default `enabled`) — with the OpenAI SDK this must go in `extra_body`. Effort via `reasoning_effort`, documented as `none | low | high | max` (`none` disables thinking; default `high`), with compatibility mapping: `minimal→low`, `medium→high`, `xhigh→high`, `ultra→max`.
- Multi-turn without tools: the CoT from previous turns is **not** concatenated into context; passing it back is ignored.
- `GET /models` exposes per-model `context_window`, `max_output_tokens`, `input_modalities`/`output_modalities`, and `effort.supported_levels` / `default_level` — useful for a capability probe.
- Thinking can dramatically inflate output tokens and cost; `max_tokens` defaults to 64K in thinking mode.

## 7. Rate limits and error semantics

- **There are no documented RPM/TPM limits.** Isolation is by **concurrency**: `deepseek-flash` 2500, `deepseek-v4-pro` 500, measured **per account** (not per API key). A request occupies one concurrent slot from send until the response completes. Exceeding the limit → **HTTP 429**. Higher concurrency is available via a capacity-expansion request form at no extra cost, and expanded accounts then also get per-`user_id` limits (2500 flash / 500 v4-pro per id; empty id is treated as a distinct id).
- Documented status codes: **400** invalid format, **401** bad API key, **402** insufficient balance, **422** invalid parameters, **429** rate limit, **500** server error, **503** server overloaded.
- **Retry guidance is minimal and non-numeric.** 429: "Please pace your requests reasonably. We also advise users to temporarily switch to the APIs of alternative LLM service providers, like OpenAI." 500: "retry your request after a brief wait and contact us if the issue persists." 503: "retry your request after a brief wait." **No `Retry-After` header and no backoff formula are documented.**
- **The 429 response body shape is not documented anywhere.** Older DeepSeek behavior was an OpenAI-shaped `{"error": {...}}`, but I could not confirm the current schema — **uncertain**. Parse defensively.
- Keep-alive quirk: while a request is queued you may receive **empty lines** (non-streaming) or **SSE comment lines `: keep-alive`** (streaming). Docs say these do not affect JSON body parsing but your parser must tolerate them. If inference has not started within **10 minutes**, the server closes the connection.
- `finish_reason` can be `stop`, `length`, `content_filter`, `tool_calls`, **`insufficient_system_resource`**, or **`aborted`** — handle the last two as retryable/partial-generation cases.
- Streaming: `stream: true` yields data-only SSE terminated by `data: [DONE]`; `stream_options.include_usage` controls whether every chunk carries `usage` (last chunk carries full usage either way, riding on the final content chunk).

## 8. Prompt caching / context layout best practice

DeepSeek's own cache model rewards exactly one layout: **a byte-identical, fully-matching leading prefix.**

- **Put stable/repeated content first, volatile content last**, and keep conversation history **append-only**. This is the stated best practice for OpenAI-compatible endpoints (Azure/OpenAI docs) and is implied by DeepSeek's "fully matches a cache prefix unit" rule — any edit to an earlier message invalidates the whole prefix.
- Never put dynamic data (timestamps, request IDs, randomized ordering) before reusable content.
- Keep **tool/function definitions stable and in identical order** across requests — in OpenAI-format caching, tool definitions are part of the cached prefix. Reordering `tools` is a cache miss.
- DeepSeek's documented pattern: a stable `system` message plus a large document reused across questions. The first two requests populate the unit and miss; from the third request on it hits. Expect a warm-up cost, not an instant hit.
- Because DeepSeek persists a unit at the **end of user input** and the **end of model output**, multi-turn chats naturally hit: request N+1 extends request N exactly. Do not truncate or summarize the middle of history if you care about hits.
- Use `user_id` only if you need cache isolation between end users — it partitions the cache and can reduce hit rates; note it is also used for scheduling isolation.
- Monitor `usage.prompt_cache_hit_tokens` (or `prompt_tokens_details.cached_tokens`) to confirm real hit rates, and schedule flexible/batch work off-peak to halve prices (peak = 01:00–04:00 and 06:00–10:00 UTC Mon–Fri).
- For reference, OpenAI-format caching (Azure docs, updated 2026-08-11) additionally requires **≥1024 tokens** with **identical first 1024 tokens**, rounds hits after the first 1024 in **128-token increments** (GPT-5.5 and earlier), and offers `prompt_cache_key` (≤ ~15 req/min per prefix+key before misses) and explicit cache breakpoints on GPT-5.6+. No equivalent key/breakpoint parameters exist in the DeepSeek API.

## Sources

DeepSeek official docs (all fetched 2026-10-08):
- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/quick_start/token_usage
- https://api-docs.deepseek.com/quick_start/rate_limit
- https://api-docs.deepseek.com/quick_start/error_codes
- https://api-docs.deepseek.com/guides/tool_calls
- https://api-docs.deepseek.com/guides/json_mode
- https://api-docs.deepseek.com/guides/kv_cache
- https://api-docs.deepseek.com/guides/thinking_mode
- https://api-docs.deepseek.com/guides/chat_prefix_completion
- https://api-docs.deepseek.com/guides/fim_completion
- https://api-docs.deepseek.com/api/create-chat-completion
- https://api-docs.deepseek.com/api/list-models
- https://api-docs.deepseek.com/updates
- https://api-docs.deepseek.com/news/news260424
- https://api-docs.deepseek.com/news/news260910
- https://api-docs.deepseek.com/api/create-completion (FIM API reference, listed in nav)

Third-party / other:
- https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/prompt-caching (redirects to /en-us/azure/foundry/openai/how-to/prompt-caching/; last updated 2026-08-11) — OpenAI-format prompt caching mechanics and best practice
- https://apidog.com/blog/deepseek-v4-pro-function-calling/ (2026-08-13) — third-party; used only for community context. **Its prices ($0.435 miss / $0.003625 hit / $0.87 output) disagree with the current official pricing page and should not be used.**
- Note: `https://api-docs.deepseek.com/guides/function_calling` now redirects to the docs home page; the canonical page is `/guides/tool_calls`.
- Note: `platform.openai.com/docs/guides/prompt-caching` returned HTTP 403 (Cloudflare) and `platform.claude.com` blocked cross-origin fetching, so OpenAI's and Anthropic's own caching pages could not be read directly; Azure's page was used as the accessible official OpenAI-format reference.
