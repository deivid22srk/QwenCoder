# QwenCoder

> App **Flutter (Android)** + **Proxy QwenBridge modificado** — chat com a IA Qwen em tempo real, com **tool calls executadas no próprio proxy** e **gerenciamento de contas em runtime** via API.

[![Build APK](https://github.com/deivid22srk/QwenCoder/actions/workflows/build.yml/badge.svg)](https://github.com/deivid22srk/QwenCoder/actions/workflows/build.yml)
[![Flutter](https://img.shields.io/badge/Flutter-3.24-blue)](https://flutter.dev)
[![Platform](https://img.shields.io/badge/Platform-Android-green)](#)

---

## O que é

O **QwenCoder** é composto por duas partes que se comunicam:

```
┌──────────────────────┐    HTTP + SSE    ┌──────────────────────────────────┐
│  QwenCoder App       │ ◄─────────────► │  QwenBridge Proxy (modificado)   │
│  (Flutter / Android) │                  │  (Node + Hono, neste repo em     │
│                      │                  │   /proxy)                        │
│  • UI estilo Claude  │                  │                                  │
│  • streaming SSE     │                  │  • /v1/chat/completions (SSE     │
│  • tool_call.start,  │                  │    com eventos extras)           │
│    execute.*, result │                  │  • /v1/accounts (CRUD)           │
│  • gerencia contas   │                  │  • /v1/accounts/stream (SSE)     │
│    via /v1/accounts  │                  │  • /v1/tools                     │
│                      │                  │  • executa tools server-side     │
└──────────────────────┘                  │  • gerencia contas no SQLite     │
                                          │  • rotaciona com cooldown        │
                                          │  • stealth + Playwright          │
                                          └──────────────────────────────────┘
                                                                │
                                                                ▼
                                                        chat.qwen.ai
```

### Principais recursos

- **Tool calls executadas no proxy**, não no app. O proxy injeta as tools no request, detecta `tool_calls` no stream do modelo, executa server-side, e emite eventos SSE extras para o app mostrar **em tempo real**:
  - `tool_call.start` — início de cada tool_call
  - `tool_call.args_delta` — args JSON parciais (cada chunk)
  - `tool_call.execute.start` — antes de executar
  - `tool_call.execute.progress` — atualização de progresso
  - `tool_call.execute.complete` — fim da execução
  - `tool_call.result` — conteúdo completo do resultado
  - `tool_call.loop` — próxima iteração do loop (até 6)

- **Gerenciamento de contas em runtime** — o app lista/adiciona/remove contas Qwen via `POST /v1/accounts` no proxy. As senhas são armazenadas no SQLite do proxy (com encrypt Brotli), nunca no app. Mudanças refletem imediatamente no proxy.

- **Streaming SSE em tempo real** — tokens aparecem incrementalmente na UI, e o card de cada tool call muda de estado visual conforme chegam os eventos: `preparando → executando → concluído` (ou `falhou`).

- **Layout estilo Claude** — paleta dark (`#0b0b0b` / `#d97757`), fonte serif (Source Serif 4) para respostas, sans (Inter) para UI.

---

## Estrutura do repositório

```
QwenCoder/
├── proxy/                       # ← QwenBridge modificado (Node + Hono)
│   ├── src/
│   │   ├── api/server.ts        # registra novas rotas
│   │   ├── routes/
│   │   │   ├── accounts/        # ← NOVO: /v1/accounts CRUD + SSE
│   │   │   ├── tools/           # ← NOVO: registry + interceptor
│   │   │   │   ├── registry.ts      # tools server-side + executor
│   │   │   │   └── interceptor.ts   # wrap do /v1/chat/completions
│   │   │   ├── chat/            # original (intacto)
│   │   │   ├── anthropic/       # original (intacto)
│   │   │   └── responses/       # original (intacto)
│   │   ├── core/                # original (contas, config, db, etc)
│   │   └── services/            # original (qwen, playwright, etc)
│   ├── QWENCODER-PATCH.md       # documentação das extensões
│   ├── README.md                # docs originais do QwenBridge
│   ├── package.json
│   ├── Dockerfile
│   └── docker-compose.yml
│
├── lib/                         # ← App Flutter QwenCoder
│   ├── main.dart
│   ├── app.dart
│   ├── models/
│   │   ├── app_settings.dart
│   │   ├── chat_message.dart
│   │   ├── qwen_account.dart    # ← reflete o proxy (sem senha)
│   │   ├── streaming_tool_call.dart
│   │   └── tool_call.dart
│   ├── services/
│   │   ├── api_client.dart      # ← SSE rico + accounts API
│   │   ├── chat_provider.dart   # ← orquestra eventos SSE
│   │   └── storage_service.dart
│   ├── screens/
│   │   ├── chat_screen.dart
│   │   └── settings_screen.dart # ← gerencia contas via proxy
│   ├── theme/app_theme.dart
│   └── widgets/
│       ├── chat_input.dart
│       ├── message_bubble.dart
│       └── tool_call_card.dart  # ← streaming visual (start→executing→result)
│
├── android/                     # projeto Android
├── assets/                      # ícones
├── .github/workflows/build.yml  # CI: build APK + release em tags
├── pubspec.yaml
└── README.md
```

---

## Como rodar o proxy (QwenBridge modificado)

### Pré-requisitos

- Node.js 20+
- npm 9+
- Playwright (para stealth + captura de headers anti-bot)

### Passo a passo

```bash
# 1. Entrar na pasta do proxy
cd proxy

# 2. Instalar dependências
npm install

# 3. Instalar Chromium para o Playwright
npx playwright install chromium

# 4. Criar .env com suas contas Qwen (opcional — pode usar o app depois)
cp .env.example .env
# Edite o .env:
#   QWEN_ACCOUNTS=user1@example.com:senha1;user2@example.com:senha2
#   PORT=3000
#   HOST=0.0.0.0
#   API_KEY=                    # opcional, mas recomendado em produção

# 5. (Alternativa ao .env) Login interativo — adiciona contas no SQLite
npm run login
#   [A] Adicionar uma conta
#   [B] Adicionar várias contas em lote (4 formatos aceitos)
#   [C] Criar contas automaticamente (mail.tm + captcha)
#   [R] Remover conta
#   [Q] Sair

# 6. Iniciar o proxy
npm start
# Ouvindo em http://localhost:3000/v1
```

### Verificar se está funcionando

```bash
# Health check
curl http://localhost:3000/health

# Listar modelos
curl http://localhost:3000/v1/models

# Listar contas (sem senhas)
curl http://localhost:3000/v1/accounts

# Listar tools server-side disponíveis
curl http://localhost:3000/v1/tools

# Teste de chat simples (streaming)
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-plus",
    "messages": [{"role":"user","content":"Que horas são?"}],
    "stream": true
  }'
# Você verá eventos SSE extras:
#   event: tool_call.start
#   event: tool_call.args_delta
#   event: tool_call.execute.start
#   event: tool_call.execute.progress
#   event: tool_call.execute.complete
#   event: tool_call.result
#   event: tool_call.loop
#   data: {"choices":[{"delta":{"content":"..."}}]}
```

### Adicionar contas em runtime via API (o que o app faz)

```bash
# Adicionar uma conta
curl -X POST http://localhost:3000/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"email":"novo@x.com","password":"segredo"}'

# Adicionar várias contas (3 formatos aceitos)
curl -X POST http://localhost:3000/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"wire":"u1@x.com:p1;u2@x.com:p2;u3@x.com:p3"}'

# Ou batch estruturado
curl -X POST http://localhost:3000/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"accounts":[
    {"email":"a@x.com","password":"p1"},
    {"email":"b@x.com","password":"p2"}
  ]}'

# Remover uma conta
curl -X DELETE http://localhost:3000/v1/accounts/<id>

# Limpar cooldown de uma conta
curl -X PATCH http://localhost:3000/v1/accounts/<id> \
  -H "Content-Type: application/json" \
  -d '{"action":"clear_cooldown"}'

# Forçar warmup (re-init via Playwright em background)
curl -X PATCH http://localhost:3000/v1/accounts/<id> \
  -H "Content-Type: application/json" \
  -d '{"action":"warmup"}'

# SSE de mudanças de status em tempo real
curl -N http://localhost:3000/v1/accounts/stream
```

### Docker

```bash
cd proxy
docker-compose up -d
# Veja docker-compose.yml para variáveis
```

---

## Como rodar o app Flutter

### Pré-requisitos

- Flutter 3.24+
- Android SDK (compileSdk 34)
- Um emulador Android ou device físico

### Passo a passo

```bash
# 1. Na raiz do repositório (fora de /proxy)
flutter pub get

# 2. Rodar em emulador/device
flutter run

# 3. Build APK release
flutter build apk --release
# APK gerado em build/app/outputs/flutter-apk/app-release.apk
```

### Configurando o app para conectar no proxy

1. **No emulador Android**: use `http://10.0.2.2:3000` (o `10.0.2.2` mapeia para `localhost` do host)
2. **No device físico** (mesma rede do proxy): use `http://<ip-do-pc>:3000` (ex: `http://192.168.0.10:3000`)
3. **Servidor remoto**: use a URL pública

Abra o app → ícone de engrenagem (canto superior direito) → configure:
- **URL base do proxy**
- **API key** (só se você configurou `API_KEY=` no `.env` do proxy)
- Clique em **Testar conexão** — deve aparecer "Proxy online — N modelos, M contas, K tools"

---

## Build via GitHub Actions (CI)

O workflow `.github/workflows/build.yml` roda em todo push para `main`/`master`, em tags `v*`, em PRs, ou manualmente.

Ele:
1. Setup Flutter 3.24 + Java 17
2. `flutter pub get`, `flutter analyze`, `flutter_launcher_icons`
3. `flutter build apk --debug` + `flutter build apk --release`
4. Sobe ambos como artifacts (retenção 30/7 dias)
5. Em tags `v*`: cria um **GitHub Release** automático com o APK anexado

Para baixar o APK depois de um build:
1. Acesse https://github.com/deivid22srk/QwenCoder/actions
2. Clique no último run verde
3. Baixe o artifact `qwencoder-apk-release`

Para criar uma release com APK:
```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Tools server-side disponíveis (no proxy)

| Tool | Descrição |
|---|---|
| `get_current_time` | Data/hora atual do servidor proxy |
| `calculator` | Avaliador matemático seguro (sem eval) |
| `random_number` | Inteiro aleatório em [min, max] |
| `list_qwen_accounts` | Lista contas do proxy (sem expor senhas) |
| `http_request` | HTTP request a URL pública (o proxy executa) |

Para adicionar mais tools, edite `proxy/src/routes/tools/registry.ts`:
1. Crie um `ToolDefinition` com `name`, `description`, `parameters`, `execute`
2. Adicione ao array `REGISTRY`

O `execute(args, ctx)` recebe `(args, ctx)` onde `ctx.emitProgress({message, percent?})`
envia um evento SSE de progresso em tempo real para o cliente.

---

## Arquitetura do streaming SSE

Quando o usuário envia uma mensagem no app:

1. **App → Proxy**: `POST /v1/chat/completions` com `stream: true` e `enable_tools: true`
2. **Proxy → Qwen**: injeta tools server-side e repassa ao modelo
3. **Qwen → Proxy**: stream SSE com `delta.content` (texto) e `delta.tool_calls` (se houver)
4. **Proxy → App**: repassa texto + emite eventos extras (`tool_call.start`, `args_delta`)
5. **Proxy executa tool**: chama `ToolDefinition.execute(args, ctx)` server-side
   - Durante execução: emite `tool_call.execute.progress`
   - Ao final: emite `tool_call.execute.complete` + `tool_call.result`
6. **Proxy → Qwen**: re-envia conversa com `tool_result` incluído
7. **Loop**: até 6 iterações (evento `tool_call.loop` em cada)
8. **App mostra tudo em tempo real**: cada evento atualiza o `ToolCallCard` na UI

---

## Troubleshooting

| Problema | Solução |
|---|---|
| `Proxy offline` no app | Verifique se `npm start` está rodando. No emulador use `10.0.2.2`, não `localhost`. |
| Nenhum modelo carregado | Configure `QWEN_ACCOUNTS` no `.env` ou use o app em Configurações → Contas Qwen. |
| Tool calls não aparecem | Verifique se "Habilitar tool calls" está ligado nas configurações. |
| `Connection refused` | Firewall bloqueando ou porta errada. |
| APK não instala | Habilite "Fontes desconhecidas" no Android. |
| Playwright não inicia | Rode `npx playwright install chromium` em `proxy/`. |
| Conta em cooldown | Botão "Limpar cooldown" no app, ou aguarde o tempo expirar. |

---

## Documentação adicional

- **`proxy/QWENCODER-PATCH.md`** — detalhes das extensões adicionadas ao QwenBridge
- **`proxy/README.md`** — documentação original do QwenBridge (upstream)
- **`proxy/docs/rotas-compatibilidade-confirmada.md`** — rotas OpenAI/Anthropic suportadas

## Licença

ISC — mesmo licença do QwenBridge upstream.

## Créditos

- **Proxy backend**: [QwenBridge Custom Version](https://github.com/deivid22srk/QwenBridge-Custom-Version) por [@deivid22srk](https://github.com/deivid22srk)
- **Design inspiration**: Claude interface (`claude.ai`)
- **Fontes**: Inter (Rasmus Andersson), Source Serif 4 (Google Fonts)
