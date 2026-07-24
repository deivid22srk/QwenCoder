# QwenBridge patch — qwen3.8-max-preview + Responses SSE memory + real usage

## Shipped

### Model: `qwen3.8-max-preview`
- Registered in `model-registry` (1M context, divisor 2.2)
- Injected into `/v1/models` if Qwen catalog omits it
- **Always thinking ON** — no `-no-thinking` twin; Fast/low effort cannot disable
- GPT-5.x aliases in Responses map → `qwen3.8-max-preview`

### Thinking effort (Max / Fast)
| Client effort | Normalized | Qwen `feature_config` |
|---|---|---|
| `max`, `high`, `xhigh`, `thinking` | high | `thinking_enabled: true`, `thinking_mode: "Thinking"`, `thinking_format: "summary"` |
| `medium` | medium | same as Max (thinking on) |
| `fast`, `none`, `minimal`, `low`, `off` | low | `thinking_enabled: false`, `thinking_mode: "Fast"` (no format) |

Other models: provider/request chooses via `reasoning.effort` or model suffix `-no-thinking`.  
Chat Completions also accepts `reasoning.effort` / `reasoning_effort`.

### OpenAI `/v1/responses` — last_response_id memory
- Store each response with `session_id`, `qwen_chat_id`, `qwen_parent_id`, account
- On `previous_response_id`: **prefer native Qwen parent chain** (delta only) so the model recovers memory without full transcript resend
- Fallback: full stored chat history if Qwen ids missing/expired
- Session → latest: `GET /v1/responses/session/:session_id/latest`
- Sticky `session_id` auto-key `responses:<id>` when client omits one

### Real token usage in SSE
- Chat: seed uses model-aware estimate; **overwritten by real upstream** `input_tokens`/`output_tokens` (also accepts OpenAI field names)
- Responses: always `stream_options.include_usage: true` on internal chat fetch
- Forwards `input_tokens`, `output_tokens`, cached + reasoning details on `response.completed`
- No invented billing math when upstream sent usage

### SSE fidelity extras
- Reasoning part lifecycle: `reasoning_summary_part.added/done` + `reasoning_summary_text.done`
- Still: `event:` + `data:` + `sequence_number`

## Tests
```powershell
npx tsx --test src/tests/responses-effort.test.ts
```

## Restart
```powershell
cd C:\Users\Elaine\Documents\QwenBridge-main
npm start
```
