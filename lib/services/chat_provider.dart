import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/app_settings.dart';
import '../models/chat_message.dart';
import '../models/tool_call.dart';
import '../models/qwen_account.dart';
import 'api_client.dart';
import 'storage_service.dart';
import 'tool_executor.dart';

/// Provider central que gerencia:
/// - settings (URL do proxy, API key, modelo, etc.)
/// - contas Qwen (lista persistida)
/// - histórico de mensagens da sessão atual
/// - dispatch de mensagens com tool call loop
class ChatProvider extends ChangeNotifier {
  ChatProvider() {
    _init();
  }

  // --- Estado ---
  AppSettings _settings = const AppSettings();
  List<QwenAccount> _accounts = const [];
  List<ChatMessage> _messages = const [];
  List<String> _models = const [];
  bool _isSending = false;
  bool _isConnecting = false;
  String? _connectionError;
  bool _proxyOnline = false;

  // --- Getters ---
  AppSettings get settings => _settings;
  List<QwenAccount> get accounts => List.unmodifiable(_accounts);
  List<ChatMessage> get messages => List.unmodifiable(_messages);
  List<String> get models => List.unmodifiable(_models);
  bool get isSending => _isSending;
  bool get isConnecting => _isConnecting;
  String? get connectionError => _connectionError;
  bool get proxyOnline => _proxyOnline;
  ApiClient? _client;

  ApiClient? get client => _client;

  Future<void> _init() async {
    _settings = await StorageService.loadSettings();
    _accounts = await StorageService.loadAccounts();
    _rebuildClient();
    notifyListeners();
    // Verifica conexão em background
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
      notifyListeners();
      await _refreshProxyStatus();
    } else {
      notifyListeners();
    }
  }

  Future<void> testConnection() async {
    await _refreshProxyStatus();
  }

  // --- Accounts ---

  Future<void> addAccount(QwenAccount acc) async {
    _accounts = [..._accounts, acc];
    await StorageService.saveAccounts(_accounts);
    notifyListeners();
  }

  Future<void> updateAccount(QwenAccount acc) async {
    _accounts = _accounts.map((a) => a.id == acc.id ? acc : a).toList();
    await StorageService.saveAccounts(_accounts);
    notifyListeners();
  }

  Future<void> removeAccount(String id) async {
    _accounts = _accounts.where((a) => a.id != id).toList();
    await StorageService.saveAccounts(_accounts);
    notifyListeners();
  }

  /// Constrói a string `QWEN_ACCOUNTS=user:pass;user:pass` com todas as contas habilitadas.
  /// Útil para o usuário copiar/colar no `.env` do proxy QwenBridge.
  String buildWireString() {
    return _accounts
        .where((a) => a.enabled)
        .map((a) => a.toWireFormat())
        .join(';');
  }

  // --- Chat ---

  void clearChat() {
    _messages = const [];
    notifyListeners();
  }

  /// Envia uma mensagem de usuário e processa a resposta (com tool calls).
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

    await _runCompletionLoop(history, assistantMsg);

    _isSending = false;
    notifyListeners();
  }

  Future<void> _runCompletionLoop(List<ChatMessage> history, ChatMessage assistantMsg) async {
    const maxIterations = 6; // Limite de tool calls encadeados
    var currentHistory = List<ChatMessage>.from(history);
    var currentAssistant = assistantMsg;

    for (var i = 0; i < maxIterations; i++) {
      var content = '';
      List<ToolCall> toolCalls = const [];
      var hadError = false;
      String? errorMsg;

      final completer = Completer<void>();
      final stream = _client!.chatStream(
        model: _settings.defaultModel,
        messages: currentHistory,
        temperature: _settings.temperature,
        enableTools: _settings.enableTools,
      );

      await for (final ev in stream) {
        switch (ev) {
          case ChatDeltaEvent(:final text):
            content += text;
            currentAssistant = currentAssistant.copyWith(content: content, status: MessageStatus.streaming);
            _updateMessage(currentAssistant);
            break;
          case ChatToolCallsEvent(:final calls):
            toolCalls = calls;
            break;
          case ChatErrorEvent(:final message):
            hadError = true;
            errorMsg = message;
            break;
          case ChatDoneEvent():
            break;
        }
        if (hadError) break;
      }

      if (hadError) {
        currentAssistant = currentAssistant.copyWith(
          content: content.isEmpty ? '❌ Erro: $errorMsg' : content,
          status: MessageStatus.error,
          error: errorMsg,
        );
        _updateMessage(currentAssistant);
        return;
      }

      // Finaliza o assistant message (com tool_calls se houver)
      currentAssistant = currentAssistant.copyWith(
        content: content,
        toolCalls: toolCalls,
        status: toolCalls.isEmpty ? MessageStatus.complete : MessageStatus.toolRunning,
      );
      _updateMessage(currentAssistant);

      if (toolCalls.isEmpty) {
        // Sem tool calls — fim do loop
        return;
      }

      // Executa cada tool call e adiciona mensagem "tool" para cada
      currentHistory = List<ChatMessage>.from(currentHistory);
      // Atualiza o assistant atual no histórico com tool_calls incluídas
      final assistantIdx = currentHistory.indexWhere((m) => m.id == currentAssistant.id);
      if (assistantIdx >= 0) {
        currentHistory[assistantIdx] = currentAssistant;
      } else {
        currentHistory.add(currentAssistant);
      }

      for (final tc in toolCalls) {
        final result = ToolExecutor.execute(tc.name, tc.arguments);
        final toolMsg = ChatMessage.tool(
          toolCallId: tc.id,
          toolName: tc.name,
          content: result.content,
        );
        _messages = [..._messages, toolMsg];
        currentHistory.add(toolMsg);
        notifyListeners();
      }

      // Próxima iteração: nova mensagem assistant que vai receber a resposta final
      currentAssistant = ChatMessage.assistant(content: '');
      _messages = [..._messages, currentAssistant];
      notifyListeners();
    }

    // Se excedeu iterações, marca erro
    currentAssistant = currentAssistant.copyWith(
      content: '⚠️ Limite de tool calls encadeados atingido.',
      status: MessageStatus.error,
    );
    _updateMessage(currentAssistant);
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

  /// Aborta a requisição em andamento (best-effort — apenas limpa flag).
  Future<void> stopGeneration() async {
    _isSending = false;
    notifyListeners();
    // TODO: chamar /v1/chat/completions/stop no proxy se implementado.
  }
}
