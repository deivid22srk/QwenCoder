# QwenBridge patch — always emit `input_tokens_details` (Grok CLI fix)

## Symptom
Grok CLI (`api_backend = "responses"`) fails immediately with:
```
serialization error: missing field `input_tokens_details`
Turn failed: Internal error: "serialization error: missing field `input_tokens_details`"
```

## Root cause
**Proxy bug, not Grok config.**

Grok is a Rust client (serde). It requires `usage.input_tokens_details` on every Responses object, including the early `response.created` / `response.in_progress` events.

QwenBridge only attached `input_tokens_details` when `cached_tokens > 0`, and `buildInProgressResponse` emitted bare:
```json
{ "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
```

## Fix
- `makeResponsesUsage()` helper always builds complete usage:
  - `input_tokens_details.cached_tokens` (default `0`)
  - `output_tokens_details.reasoning_tokens` (default `0`)
- Used by:
  - `buildInProgressResponse` (stream start)
  - `buildFinalUsage` (stream end)
  - non-stream `chatCompletionsToResponses`

## Files
- `src/routes/responses/types.ts`
- `src/routes/responses/adapter.ts`
- `src/routes/responses/streaming.ts`

## Restart (required)
```powershell
cd C:\Users\Elaine\Documents\QwenBridge-main
# stop the old npm start (Ctrl+C), then:
npm start
```

Then in another terminal:
```powershell
cd C:\Users\Elaine\Desktop\RoBack   # or any folder
grok
```

Grok config is fine as-is:
```toml
[model.qwen38-max-preview]
api_backend = "responses"
base_url = "http://127.0.0.1:3000/v1"
```
