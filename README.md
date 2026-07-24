# QwenCoder

> Cliente **Flutter** (Android + Web) para o proxy [**QwenBridge Custom Version**](https://github.com/deivid22srk/QwenBridge-Custom-Version) — layout inspirado no visual do Claude (`claude.ai`), com suporte completo a **tool calls**, **streaming SSE** e gerenciamento de **múltiplas contas Qwen**.

[![Build](https://github.com/deivid22srk/QwenCoder/actions/workflows/build.yml/badge.svg)](https://github.com/deivid22srk/QwenCoder/actions/workflows/build.yml)
[![Flutter](https://img.shields.io/badge/Flutter-3.24-blue)](https://flutter.dev)
[![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20Web-purple)](#)

---

## Visão geral

O **QwenCoder** é o frontend móvel do seu proxy QwenBridge. Ele se conecta ao proxy rodando localmente (ou em qualquer host configurável) através da API compatível com OpenAI exposta pelo QwenBridge em `/v1/chat/completions`, `/v1/models`, etc.

```
┌─────────────────┐         ┌────────────────────────┐         ┌────────────────┐
│  QwenCoder App  │ ──HTTP──│ QwenBridge Proxy       │ ──HTTPS─│ chat.qwen.ai   │
│  (Flutter)      │  SSE    │ (Node/Hono, localhost) │  Playwr │ (anti-bot)     │
└─────────────────┘         └────────────────────────┘         └────────────────┘
```

### Principais recursos

- **Layout estilo Claude** — paleta dark (`#0b0b0b`, `#d97757`), fonte serif (Source Serif 4) para respostas da IA e sans (Inter) para mensagens do usuário.
- **Conexão configurável** com o proxy — URL base editável (suporta `10.0.2.2:3000` no emulador, IP local no device físico, ou qualquer host remoto).
- **Tool calling completo** — implementa 6 ferramentas locais que o modelo pode chamar (calculator, get_current_time, random_number, text_transform, device_info, get_weather). Suporta loop de tool calls encadeados (até 6 iterações).
- **Streaming SSE** — tokens aparecem incrementalmente, igual à experiência do ChatGPT/Claude.
- **Gerenciamento de contas Qwen** — adicionar, editar, ativar/desativar, excluir. Suporta importação em lote nos mesmos 4 formatos aceitos pelo QwenBridge.
- **Geração do `QWEN_ACCOUNTS`** — botão que copia a string pronta para colar no `.env` do proxy.
- **Android + Web** — o build.yml gera APK (debug + release) e o site Flutter Web (deploy automático no GitHub Pages).

---

## Pré-requisitos

Para usar o app compilado, você precisa:

1. **Do proxy QwenBridge rodando** em algum lugar alcançável pelo device.
   - Emulador Android: `http://10.0.2.2:3000`
   - Device físico na mesma rede: `http://192.168.x.y:3000`
   - Servidor remoto: `https://seu-proxy.com`

2. **Contas Qwen configuradas no proxy** (via `QWEN_ACCOUNTS` no `.env` ou `npm run login`).
   - O QwenCoder também permite gerenciar essa lista e gerar a string `QWEN_ACCOUNTS` pronta para colar.

3. **(Opcional) API key** se você configurou `API_KEY=...` no proxy.

---

## Como compilar

### Via GitHub Actions (recomendado)

O workflow `.github/workflows/build.yml` é disparado em todo `push` para `main`/`master`, em qualquer `tag v*`, em PRs, ou manualmente via `workflow_dispatch`.

Ele:
1. Faz setup do Flutter 3.24 + Java 17
2. Roda `flutter pub get`, `flutter analyze`, e `dart run flutter_launcher_icons`
3. Compila `flutter build apk --debug` e `flutter build apk --release`
4. Sobe ambos como artifacts do workflow (retention 30/7 dias)
5. Em pushes para `main` ou tags `v*`, compila também o **site Flutter Web** e publica em GitHub Pages
6. Em tags `v*`, cria um **GitHub Release** automático com o APK anexado

### Local

```bash
# Pré-requisitos: Flutter 3.24+ e Android SDK
flutter pub get
dart run flutter_launcher_icons
flutter run                       # debug no device/emulador
flutter build apk --release       # APK release em build/app/outputs/flutter-apk/
flutter build web --release       # Site em build/web/
```

---

## Arquitetura do app

```
lib/
├── main.dart                 # entrypoint — inicializa o provider
├── app.dart                  # MaterialApp com tema dark
├── models/
│   ├── app_settings.dart     # settings persistidas (URL, API key, modelo, etc)
│   ├── chat_message.dart     # ChatMessage (user/assistant/tool/system)
│   ├── qwen_account.dart     # conta Qwen (email, senha, label, enabled)
│   └── tool_call.dart        # ToolCall + parser JSON tolerante
├── services/
│   ├── api_client.dart       # cliente OpenAI-compat com streaming SSE
│   ├── chat_provider.dart    # ChangeNotifier — orquestra chat + tool call loop
│   ├── storage_service.dart  # persistência (SharedPreferences)
│   └── tool_executor.dart    # executor de ferramentas locais + schemas OpenAI
├── screens/
│   ├── chat_screen.dart      # tela principal de chat
│   └── settings_screen.dart  # configurações + contas Qwen
├── theme/
│   └── app_theme.dart        # tema dark estilo Claude + fontes Google
└── widgets/
    ├── chat_input.dart       # caixa de texto arredondada
    ├── message_bubble.dart   # bolhas user/assistant/tool estilo Claude
    └── tool_call_card.dart   # card expansível para tool calls
```

### Tool calling loop

O `ChatProvider._runCompletionLoop` implementa o loop padrão de tool calling OpenAI:

1. Envia mensagens + tools pro proxy via `POST /v1/chat/completions` (streaming SSE)
2. Acumula `delta.content` e `delta.tool_calls` do stream
3. Se o modelo retornou `tool_calls`, executa cada ferramenta via `ToolExecutor.execute` localmente
4. Adiciona uma mensagem `role: tool` para cada resultado
5. Refaz a requisição com o histórico atualizado (até 6 iterações)
6. Quando o modelo não pede mais tools, a resposta final é exibida

### Ferramentas locais disponíveis

| Tool              | Descrição                                                            |
|-------------------|----------------------------------------------------------------------|
| `get_current_time`| Data/hora atual no device (ISO-8601 + formato amigável PT-BR)        |
| `calculator`      | Avaliador matemático seguro (4 ops, ^, sqrt, sin, cos, tan, log, ln)|
| `random_number`   | Inteiro aleatório em [min, max]                                      |
| `text_transform`  | uppercase/lowercase/titlecase/reverse/base64/length/word_count       |
| `device_info`     | Plataforma (android/ios/web/...), locale                             |
| `get_weather`     | Mock de clima (determinístico por cidade — substitua por API real)   |

Para adicionar novas ferramentas, edite `lib/services/tool_executor.dart`:
1. Adicione uma nova entrada em `allDefinitions()` (schema OpenAI)
2. Adicione um `case` no `execute()` que retorna um `ToolResult`

---

## Como usar o app

1. **Abra o QwenCoder** no device
2. Vá em **Configurações** (ícone de engrenagem no topo direito)
3. Em **Conexão com o Proxy QwenBridge**, configure:
   - **URL base**: `http://10.0.2.2:3000` (emulador) ou `http://<seu-ip>:3000` (device físico)
   - **API key**: só preencha se o proxy tiver `API_KEY=...` configurado
4. Clique em **Testar conexão** — deve aparecer "Proxy online — N modelos disponíveis."
5. Em **Contas Qwen**, adicione suas contas (individualmente ou em lote — mesmos 4 formatos do QwenBridge)
6. Use **Copiar QWEN_ACCOUNTS para .env do proxy** para gerar a string e colar no `.env` do QwenBridge
7. Volte para a tela de chat, escolha o modelo (ícone de chip no topo), e comece a conversar
8. Teste tool calls perguntando, por exemplo:
   - *"Que horas são agora no meu device?"*
   - *"Calcule 2*(3+4)^2 - sqrt(16)"*
   - *"Converta 'QwenCoder' para base64"*

---

## Configuração de rede no Android

O `AndroidManifest.xml` já vem com:
- `INTERNET` e `ACCESS_NETWORK_STATE` permissions
- `usesCleartextTraffic="true"` (necessário para HTTP em localhost)
- `network_security_config.xml` permitindo cleartext para `localhost`, `10.0.2.2` e `127.0.0.1`

Se você for usar HTTPS com certificado auto-assinado, precisará adicionar o certificado ao `network_security_config.xml`.

---

## Deploy Web (GitHub Pages)

O workflow publica automaticamente em `https://deivid22srk.github.io/QwenCoder/` após cada push em `main`.

Para rodar localmente:
```bash
flutter build web --release
cd build/web && python3 -m http.server 8080
# abre http://localhost:8080
```

⚠️ **Atenção CORS no Web**: o proxy QwenBridge precisa permitir CORS para a origem do site. Adicione `Access-Control-Allow-Origin: *` (ou o domínio específico do GitHub Pages) no proxy, senão o navegador bloqueia as requisições.

---

## Tokens e Segurança

- As **credenciais das contas Qwen** ficam salvas apenas no sandbox do app (SharedPreferences). Não são enviadas para nenhum servidor além do proxy configurado.
- A **URL do proxy** e a **API key** também ficam no sandbox.
- **Não** deixe seu repositório público com `.env` ou credenciais commitadas.

---

## Troubleshooting

| Problema | Solução |
|---|---|
| `Proxy offline` em vermelho | Verifique se o QwenBridge está rodando e acessível pela URL configurada. No emulador use `10.0.2.2`, não `localhost`. |
| `Connection refused` | O proxy não está escutando na porta configurada, ou firewall bloqueando. |
| Nenhum modelo carregado | Proxy online mas `/v1/models` vazio — provavelmente você não configurou contas Qwen (`QWEN_ACCOUNTS`). |
| Tool calls não funcionam | Verifique se "Habilitar tool calls" está ligado nas configurações. Confirme que o modelo escolhido suporta function calling (todos os qwen3-coder-plus, qwen3.x-plus suportam). |
| Stream trava | Aumente o timeout no proxy (`TOTAL_REQUEST_TIMEOUT`). |
| APK não instala | Habilite "Fontes desconhecidas" no Android. |
| Web não conecta no proxy | Verifique CORS no proxy e se a URL é HTTPS (browsers bloqueiam mixed content). |

---

## Roadmap

- [ ] Anexos multimodais (imagens, PDFs) via `/v1/upload` do QwenBridge
- [ ] Histórico de conversas persistido (SQLite)
- [ ] Múltiplas sessões em paralelo (sidebar com lista)
- [ ] Suporte ao endpoint `/v1/messages` (Anthropic format)
- [ ] Renderização LaTeX (via `flutter_math_fork`)
- [ ] Modo claro (light theme)
- [ ] Backup/restore de configurações
- [ ] FAB para anexos

---

## Licença

ISC — mesmo licença do upstream QwenBridge.

## Créditos

- **Proxy backend**: [QwenBridge Custom Version](https://github.com/deivid22srk/QwenBridge-Custom-Version) por [@deivid22srk](https://github.com/deivid22srk)
- **Design inspiration**: Claude interface (`claude.ai`)
- **Fontes**: Inter (Rasmus Andersson) e Source Serif 4 (Google Fonts)
