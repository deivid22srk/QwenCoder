# QwenBridge — Tools server-side + Accounts Management API (QwenCoder fork patch)

Este documento descreve as **extensões adicionadas** ao QwenBridge para suportar
o app Android **QwenCoder**. As extensões são 100% aditivas — não alteram
comportamento existente para clientes que não usam tools.

> **Changelog (patch 2 — fix crashes):**
> - `accounts/stream`: trocou `stream.addEventListener("abort", ...)` (não existe na API Hono v4) por loop `while (!stream.aborted) + stream.sleep()`. Resolve `TypeError: stream.addEventListener is not a function` que crashava o proxy quando o app abria a tela de configurações.
> - `POST /v1/accounts`: agora dispara `initPlaywrightForAccount` em background para cada conta adicionada — sem isso, `/v1/models` continuava 401 após add.
> - `accounts/stream`: `getCooldownStatus()` envolto em try/catch — em startup frio pode falhar.
> - App Flutter: `listModels()` agora trata 401 retornando lista fallback de modelos Qwen padrão (não trava UI quando proxy ainda não tem contas).
> - App Flutter: `streamAccounts()` agora reconecta automaticamente com backoff exponencial em caso de erro de rede ou proxy reiniciando.

---

## Novos endpoints

### `GET /v1/accounts`
Lista contas Qwen configuradas (sem expor senhas).

**Response 200:**
```json
{
  "total": 3,
  "active": 2,
  "in_cooldown": 1,
  "accounts": [
    {
      "id": "uuid-ou-md5",
      "email": "user@example.com",
      "enabled": true,
      "cooldown_until": null,
      "cooldown_reason": null,
      "cooldown_remaining_ms": null,
      "in_cooldown": false
    }
  ]
}
```

### `GET /v1/accounts/status`
Status detalhado, incluindo cooldowns internos do `account-manager`.

### `POST /v1/accounts`
Adiciona uma ou várias contas. Aceita 3 formatos:

```json
// Single
{ "email": "user@example.com", "password": "secret" }

// Batch
{ "accounts": [
  { "email": "user1@example.com", "password": "p1" },
  { "email": "user2@example.com", "password": "p2" }
]}

// Wire format (mesma string do .env QWEN_ACCOUNTS)
{ "wire": "user1@example.com:pass1;user2@example.com:pass2" }
```

**Response 201:**
```json
{
  "added": 2,
  "skipped": 0,
  "failed": 0,
  "results": [
    { "email": "user1@example.com", "status": "ok", "id": "abc-123" },
    { "email": "user2@example.com", "status": "ok", "id": "def-456" }
  ]
}
```

### `DELETE /v1/accounts/:id`
Remove uma conta. **Response 200** `{"ok":true,"id":"..."}` ou **404** se não existe.

### `PATCH /v1/accounts/:id`
Ações de gerenciamento:

- `{"action":"clear_cooldown"}` — limpa cooldown manualmente
- `{"action":"warmup"}` — força re-init via Playwright em background

### `GET /v1/accounts/stream`
**SSE** com mudanças de status em tempo real. Eventos:

- `snapshot` — emitido na conexão inicial
- `heartbeat` — emitido a cada 10s com estado completo
- (em futuro: `cooldown_started`, `cooldown_cleared`, `account_added`, `account_removed`)

### `GET /v1/tools`
Lista tools server-side disponíveis no proxy. Retorna descrição + schema OpenAI.

---

## Modificação do `/v1/chat/completions`

O endpoint agora passa pelo **Tool Call Interceptor** (`src/routes/tools/interceptor.ts`).

### O que mudou para o cliente:
- O proxy agora **injeta tools server-side** automaticamente no request ao modelo Qwen.
- Quando o modelo emite `tool_calls`, o proxy **executa server-side** e re-envia
  ao modelo automaticamente (loop de até 6 iterações).
- O stream SSE ganha **eventos extras** para streaming em tempo real:

| Evento | Quando é emitido | Payload |
|---|---|---|
| `tool_call.start` | Início de cada tool_call | `{tool_call_id, name, iteration}` |
| `tool_call.args_delta` | Args JSON parciais (cada chunk) | `{tool_call_id, name, delta}` |
| `tool_call.execute.start` | Antes de executar | `{tool_call_id, name, started_at}` |
| `tool_call.execute.progress` | Atualização de progresso (tool longa) | `{tool_call_id, name, message, percent?, data?}` |
| `tool_call.execute.complete` | Após execução | `{tool_call_id, name, success, duration_ms, result_length}` |
| `tool_call.result` | Resultado completo (JSON) | `{tool_call_id, name, content, is_error, duration_ms}` |
| `tool_call.loop` | Próxima iteração do loop | `{iteration}` |

### Compatibilidade
Os eventos OpenAI padrão são **mantidos** — clientes existentes continuam funcionando:
- `data: {"choices":[{"delta":{"content":"..."}}]}` — texto incremental
- `data: {"choices":[{"delta":{"tool_calls":[...]}}]}` — tool_calls parciais
- `data: {"choices":[{"finish_reason":"stop"}]}` — fim
- `data: [DONE]`

### Como desabilitar tools server-side
Inclua `"enable_tools": false` no body do request. Sem tools injetadas, o proxy
passa direto para o handler original.

---

## Tools server-side disponíveis

| Tool | Descrição |
|---|---|
| `get_current_time` | Data/hora atual do servidor proxy |
| `calculator` | Avaliador matemático seguro (sem eval) |
| `random_number` | Inteiro aleatório em [min, max] |
| `list_qwen_accounts` | Lista contas configuradas no proxy (sem senhas) |
| `http_request` | Faz HTTP request a uma URL pública (servidor executa) |

Para adicionar novas tools, edite `src/routes/tools/registry.ts`:
1. Defina um `ToolDefinition` com `name`, `description`, `parameters`, `execute`
2. Adicione ao array `REGISTRY`

O `execute` recebe `(args, ctx)` onde `ctx.emitProgress({message, percent?})`
envia um evento SSE de progresso em tempo real para o cliente.

---

## Arquitetura

```
QwenCoder App (Flutter)
    │
    │ HTTP + SSE
    ▼
QwenBridge Proxy (Hono)
    ├── /v1/chat/completions ──► Tool Interceptor
    │                              ├── injeta tools server-side
    │                              ├── chama handler original via fetch interno
    │                              ├── lê stream SSE do modelo Qwen
    │                              ├── detecta tool_calls
    │                              ├── executa tool via registry
    │                              ├── emite eventos SSE extras
    │                              └── re-envia ao modelo com tool_results (loop)
    │
    ├── /v1/accounts ─────────► Accounts REST API (add/remove/list/patch)
    ├── /v1/accounts/stream ──► SSE de mudanças de status
    ├── /v1/tools ────────────► Lista tools disponíveis
    │
    └── handler original ─────► chat.qwen.ai (via Playwright + stealth)
```

## Setup

As extensões já estão no código-fonte. Apenas rode normalmente:

```bash
npm install
npm start
```

O proxy continua compatível com OpenAI SDK / Anthropic SDK existentes.
