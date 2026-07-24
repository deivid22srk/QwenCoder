import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/app_settings.dart';
import '../models/chat_message.dart';
import '../models/qwen_account.dart';
import '../models/streaming_tool_call.dart';
import 'api_client.dart';
import 'storage_service.dart';

/// Provider central que gerencia:
/// - settings (URL do proxy, API key, modelo, etc.)
/// - contas Qwen (vindas do proxy em tempo real)
/// - histórico de mensagens da sessão atual
/// - dispatch de mensagens com streaming SSE rico (tool_call.start, execute.*, result)
class ChatProvider extends ChangeNotifier {
  ChatProvider() {
    _init();
  }

  // --- Estado ---
  AppSettings _settings = const AppSettings();
  List<QwenAccount> _accounts = const [];
  List<ChatMessage> _messages = const [];
  List<String> _models = const [];
  List<Map<String, dynamic>> _serverTools = const [];
  bool _isSending = false;
  bool _isConnecting = false;
  String? _connectionError;
  bool _proxyOnline = false;
  StreamSubscription<AccountsSnapshot>? _accountsStreamSub;

  // --- Getters ---
  AppSettings get settings => _settings;
  List<QwenAccount> get accounts => List.unmodifiable(_accounts);
  List<ChatMessage> get messages => List.unmodifiable(_messages);
  List<String> get models => List.unmodifiable(_models);
  List<Map<String, dynamic>> get serverTools => List.unmodifiable(_serverTools);
  bool get isSending => _isSending;
  bool get isConnecting => _isConnecting;
  String? get connectionError => _connectionError;
  bool get proxyOnline => _proxyOnline;
  ApiClient? _client;
  ApiClient? get client => _client;

  Future<void> _init() async {
    _settings = await StorageService.loadSettings();
    _rebuildClient();
    notifyListeners();
    unawaited(_refreshProxyStatus());
  }

  void _rebuildClient() {
    _client = ApiClient(
      baseUrl: _settings.proxyBaseUrl,
      apiKey: _settings.apiKey,
    );
  }

  Future<void> _refreshProxyStatus() async {
    if (_client == null) return;
    _isConnecting = true;
    _connectionError = null;
    notifyListeners();
    try {
      final ok = await _client!.ping().timeout(const Duration(seconds: 8));
      _proxyOnline = ok;
      if (ok) {
        await _refreshModels();
        await _refreshTools();
        await _refreshAccounts();
        _startAccountsStream();
      } else {
        _connectionError = 'Proxy offline em ${_settings.proxyBaseUrl}';
      }
    } catch (e) {
      _connectionError = e.toString();
      _proxyOnline = false;
    } finally {
      _isConnecting = false;
      notifyListeners();
    }
  }

  Future<void> _refreshModels() async {
    final list = await _client!.listModels().timeout(const Duration(seconds: 10));
    _models = list;
    if (_models.isNotEmpty && !_models.contains(_settings.defaultModel)) {
      _settings = _settings.copyWith(defaultModel: _models.first);
      await StorageService.saveSettings(_settings);
    }
    notifyListeners();
  }

  Future<void> _refreshTools() async {
    try {
      _serverTools = await _client!.listServerTools().timeout(const Duration(seconds: 10));
    } catch (_) {
      _serverTools = const [];
    }
    notifyListeners();
  }

  Future<void> _refreshAccounts() async {
    try {
      final snap = await _client!.listAccounts().timeout(const Duration(seconds: 10));
      _accounts = snap.accounts;
    } catch (_) {
      _accounts = const [];
    }
    notifyListeners();
  }

  void _startAccountsStream() {
    _accountsStreamSub?.cancel();
    if (_client == null) return;
    _accountsStreamSub = _client!.streamAccounts().listen(
      (snap) {
        _accounts = snap.accounts;
        notifyListeners();
      },
      onError: (e) {
        // Silencioso — próxima chamada HTTP vai reabrir stream
        debugPrint('accounts stream error: $e');
      },
    );
  }

  // --- Settings ---

  Future<void> updateSettings(AppSettings next) async {
    final urlChanged = next.proxyBaseUrl != _settings.proxyBaseUrl;
    final keyChanged = next.apiKey != _settings.apiKey;
    _settings = next;
    await StorageService.saveSettings(_settings);
    if (urlChanged || keyChanged) {
      _rebuildClient();
      _proxyOnline = false;
      _models = const [];
      _accounts = const [];
      _serverTools = const [];
      _accountsStreamSub?.cancel();
      notifyListeners();
      await _refreshProxyStatus();
    } else {
      notifyListeners();
    }
  }

  Future<void> testConnection() async {
    await _refreshProxyStatus();
  }

  // --- Accounts management (delegados ao proxy) ---

  Future<AddAccountsResult> addAccount({required String email, required String password}) async {
    final r = await _client!.addAccount(email: email, password: password);
    await _refreshAccounts();
    return r;
  }

  Future<AddAccountsResult> addAccountsBatch(List<({String email, String password})> accounts) async {
    final r = await _client!.addAccountsBatch(accounts);
    await _refreshAccounts();
    return r;
  }

  Future<AddAccountsResult> addAccountsFromWire(String wire) async {
    final r = await _client!.addAccountsFromWire(wire);
    await _refreshAccounts();
    return r;
  }

  Future<bool> removeAccount(String id) async {
    final ok = await _client!.removeAccount(id);
    if (ok) await _refreshAccounts();
    return ok;
  }

  Future<bool> clearAccountCooldown(String id) async {
    final ok = await _client!.patchAccount(id, action: 'clear_cooldown');
    if (ok) await _refreshAccounts();
    return ok;
  }

  Future<bool> warmupAccount(String id) async {
    final ok = await _client!.patchAccount(id, action: 'warmup');
    if (ok) await _refreshAccounts();
    return ok;
  }

  // --- Chat ---

  void clearChat() {
    _messages = const [];
    notifyListeners();
  }

  /// Envia uma mensagem de usuário e processa o stream SSE rico do proxy.
  /// O proxy executa tools server-side — só recebemos eventos para exibir.
  Future<void> sendUserMessage(String text) async {
    if (text.trim().isEmpty || _isSending) return;
    if (_client == null) {
      _messages = [..._messages, ChatMessage.error('Cliente não inicializado. Verifique as configurações.')];
      notifyListeners();
      return;
    }

    final userMsg = ChatMessage.user(text);
    var assistantMsg = ChatMessage.assistant(content: '');
    _messages = [..._messages, userMsg, assistantMsg];
    _isSending = true;
    notifyListeners();

    // System prompt opcional
    final history = <ChatMessage>[];
    if (_settings.systemPrompt.trim().isNotEmpty) {
      history.add(ChatMessage.system(_settings.systemPrompt.trim()));
    }
    history.addAll(_messages.where((m) => m.id != assistantMsg.id));

    final stream = _client!.chatStream(
      model: _settings.defaultModel,
      messages: history,
      temperature: _settings.temperature,
    );

    // Mapa de tool_call_id -> StreamingToolCall (estado corrente)
    final streamingTools = <String, StreamingToolCall>{};

    await for (final ev in stream) {
      switch (ev) {
        case ChatDeltaEvent(:final text):
          assistantMsg = assistantMsg.copyWith(
            content: assistantMsg.content + text,
            status: MessageStatus.streaming,
          );
          _updateMessage(assistantMsg);
          break;

        case ToolCallStartEvent(:final toolCallId, :final name, :final iteration):
          final tc = StreamingToolCall(
            id: toolCallId,
            name: name,
            status: ToolCallStatus.receivingArgs,
          );
          streamingTools[toolCallId] = tc;
          assistantMsg = assistantMsg.copyWith(
            streamingToolCalls: [...streamingTools.values],
            status: MessageStatus.toolRunning,
          );
          _updateMessage(assistantMsg);
          break;

        case ToolCallArgsDeltaEvent(:final toolCallId, :final delta):
          final existing = streamingTools[toolCallId];
          if (existing != null) {
            streamingTools[toolCallId] = existing.copyWith(
              argsBuffer: existing.argsBuffer + delta,
            );
            assistantMsg = assistantMsg.copyWith(
              streamingToolCalls: [...streamingTools.values],
            );
            _updateMessage(assistantMsg);
          }
          break;

        case ToolCallExecuteStartEvent(:final toolCallId, :final startedAt):
          final existing = streamingTools[toolCallId];
          if (existing != null) {
            streamingTools[toolCallId] = existing.copyWith(
              status: ToolCallStatus.executing,
              startedAt: startedAt,
            );
            assistantMsg = assistantMsg.copyWith(
              streamingToolCalls: [...streamingTools.values],
            );
            _updateMessage(assistantMsg);
          }
          break;

        case ToolCallProgressEvent(:final toolCallId, :final message, :final percent):
          final existing = streamingTools[toolCallId];
          if (existing != null) {
            streamingTools[toolCallId] = existing.copyWith(
              progressUpdates: [
                ...existing.progressUpdates,
                ToolCallProgressUpdate(
                  message: message,
                  percent: percent,
                  timestamp: DateTime.now(),
                ),
              ],
            );
            assistantMsg = assistantMsg.copyWith(
              streamingToolCalls: [...streamingTools.values],
            );
            _updateMessage(assistantMsg);
          }
          break;

        case ToolCallExecuteCompleteEvent(:final toolCallId, :final success, :final durationMs):
          final existing = streamingTools[toolCallId];
          if (existing != null) {
            streamingTools[toolCallId] = existing.copyWith(
              status: success ? ToolCallStatus.completed : ToolCallStatus.failed,
              durationMs: durationMs,
              completedAt: DateTime.now(),
            );
            assistantMsg = assistantMsg.copyWith(
              streamingToolCalls: [...streamingTools.values],
            );
            _updateMessage(assistantMsg);
          }
          break;

        case ToolCallResultEvent(:final toolCallId, :final content, :final isError, :final durationMs, :final name):
          final existing = streamingTools[toolCallId];
          if (existing != null) {
            streamingTools[toolCallId] = existing.copyWith(
              resultContent: content,
              isError: isError,
              durationMs: durationMs,
              status: isError ? ToolCallStatus.failed : ToolCallStatus.completed,
            );
            assistantMsg = assistantMsg.copyWith(
              streamingToolCalls: [...streamingTools.values],
            );
            _updateMessage(assistantMsg);
          } else {
            // Resultado sem start anterior — cria agora
            streamingTools[toolCallId] = StreamingToolCall(
              id: toolCallId,
              name: name,
              resultContent: content,
              isError: isError,
              durationMs: durationMs,
              status: isError ? ToolCallStatus.failed : ToolCallStatus.completed,
              completedAt: DateTime.now(),
            );
            assistantMsg = assistantMsg.copyWith(
              streamingToolCalls: [...streamingTools.values],
            );
            _updateMessage(assistantMsg);
          }
          break;

        case ToolCallLoopEvent(:final iteration):
          // Próxima iteração do loop server-side — limpa tools atuais para a próxima rodada
          // mas mantém o histórico visível
          assistantMsg = assistantMsg.copyWith(
            metadata: {...assistantMsg.metadata, 'loop_iteration': iteration},
          );
          _updateMessage(assistantMsg);
          break;

        case ChatToolCallsEvent():
          // Tool calls finais no formato OpenAI padrão (caso o proxy não emita eventos extras)
          // — já coberto pelos eventos acima, ignoramos aqui
          break;

        case ChatErrorEvent(:final message):
          assistantMsg = assistantMsg.copyWith(
            content: assistantMsg.content.isEmpty
                ? '❌ Erro: $message'
                : '${assistantMsg.content}\n\n❌ Erro: $message',
            status: MessageStatus.error,
            error: message,
          );
          _updateMessage(assistantMsg);
          _isSending = false;
          notifyListeners();
          return;

        case ChatDoneEvent():
          assistantMsg = assistantMsg.copyWith(
            status: MessageStatus.complete,
          );
          _updateMessage(assistantMsg);
          break;
      }
    }

    _isSending = false;
    notifyListeners();
  }

  void _updateMessage(ChatMessage updated) {
    final idx = _messages.indexWhere((m) => m.id == updated.id);
    if (idx < 0) {
      _messages = [..._messages, updated];
    } else {
      final list = List<ChatMessage>.from(_messages);
      list[idx] = updated;
      _messages = list;
    }
    notifyListeners();
  }

  /// Aborta a requisição em andamento (best-effort).
  Future<void> stopGeneration() async {
    _isSending = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _accountsStreamSub?.cancel();
    super.dispose();
  }
}
