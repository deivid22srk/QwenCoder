import 'dart:async';
import 'dart:convert';
import 'package:dio/dio.dart';
import '../models/chat_message.dart';
import '../models/tool_call.dart';
import '../models/qwen_account.dart';
import '../models/streaming_tool_call.dart';

/// Cliente da API do proxy QwenBridge.
///
/// Endpoints consumidos:
/// - `POST /v1/chat/completions` (streaming SSE com eventos extras de tool_call)
/// - `GET  /v1/models`
/// - `GET  /v1/accounts`
/// - `POST /v1/accounts`
/// - `DELETE /v1/accounts/:id`
/// - `PATCH /v1/accounts/:id` (clear_cooldown | warmup)
/// - `GET  /v1/accounts/stream` (SSE de mudanças de status)
/// - `GET  /v1/tools`
/// - `GET  /health`
class ApiClient {
  ApiClient({required String baseUrl, String apiKey = ''})
      : _baseUrl = baseUrl,
        _apiKey = apiKey {
    _dio = Dio(BaseOptions(
      baseUrl: _baseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(minutes: 5),
      sendTimeout: const Duration(seconds: 30),
      headers: {
        'Content-Type': 'application/json',
        if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
      },
      responseType: ResponseType.stream,
      validateStatus: (s) => s != null && s < 500,
    ));
  }

  final String _baseUrl;
  final String _apiKey;
  late final Dio _dio;

  String get baseUrl => _baseUrl;
  String get apiKey => _apiKey;

  /// Health check no proxy.
  Future<bool> ping() async {
    try {
      final r = await Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 5),
        receiveTimeout: const Duration(seconds: 5),
      )).get<Map<String, dynamic>>('$_baseUrl/health');
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Lista modelos disponíveis no proxy.
  /// Retorna lista vazia se:
  /// - O proxy não tem contas Qwen configuradas (401)
  /// - Erro de rede
  Future<List<String>> listModels() async {
    try {
      final r = await Dio(BaseOptions(
        baseUrl: _baseUrl,
        headers: {
          if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
        },
        responseType: ResponseType.json,
        receiveTimeout: const Duration(seconds: 15),
        validateStatus: (s) => s != null && s < 500,
      )).get<Map<String, dynamic>>('/v1/models');
      if (r.statusCode == 401) {
        // Sem contas configuradas no proxy — usa fallback de modelos padrão
        return _fallbackModels;
      }
      final data = r.data;
      if (data == null) return _fallbackModels;
      final list = data['data'] as List? ?? [];
      final models = list
          .map((m) => (m as Map<String, dynamic>)['id'] as String?)
          .where((s) => s != null && s.isNotEmpty)
          .cast<String>()
          .toList();
      return models.isEmpty ? _fallbackModels : models;
    } catch (_) {
      return _fallbackModels;
    }
  }

  /// Modelos Qwen padrão para fallback quando o proxy não tem contas ainda.
  /// (mesma lista do README do QwenBridge)
  static const _fallbackModels = <String>[
    'qwen3-coder-plus',
    'qwen3.7-plus',
    'qwen3.7-max',
    'qwen3.6-plus',
    'qwen3.5-flash',
  ];

  /// Lista tools server-side disponíveis no proxy (endpoint /v1/tools).
  Future<List<Map<String, dynamic>>> listServerTools() async {
    try {
      final r = await Dio(BaseOptions(
        baseUrl: _baseUrl,
        headers: {
          if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
        },
        responseType: ResponseType.json,
      )).get<Map<String, dynamic>>('/v1/tools');
      final list = r.data?['tools'] as List? ?? [];
      return list
          .map((t) => Map<String, dynamic>.from(t as Map))
          .toList();
    } catch (_) {
      return const [];
    }
  }

  // ============ ACCOUNTS API ============

  /// `GET /v1/accounts` — lista contas (sem senhas).
  Future<AccountsSnapshot> listAccounts() async {
    final r = await _jsonGet('/v1/accounts');
    return AccountsSnapshot.fromJson(r);
  }

  /// `POST /v1/accounts` — adiciona uma conta.
  Future<AddAccountsResult> addAccount({required String email, required String password}) async {
    final r = await _jsonPost('/v1/accounts', {'email': email, 'password': password});
    return AddAccountsResult.fromJson(r);
  }

  /// `POST /v1/accounts` — adiciona várias contas (batch).
  Future<AddAccountsResult> addAccountsBatch(List<({String email, String password})> accounts) async {
    final r = await _jsonPost('/v1/accounts', {
      'accounts': accounts.map((a) => {'email': a.email, 'password': a.password}).toList(),
    });
    return AddAccountsResult.fromJson(r);
  }

  /// `POST /v1/accounts` — adiciona via string wire `email:pass;email:pass`.
  Future<AddAccountsResult> addAccountsFromWire(String wire) async {
    final r = await _jsonPost('/v1/accounts', {'wire': wire});
    return AddAccountsResult.fromJson(r);
  }

  /// `DELETE /v1/accounts/:id`
  Future<bool> removeAccount(String id) async {
    final r = await Dio(BaseOptions(
      baseUrl: _baseUrl,
      headers: {
        'Content-Type': 'application/json',
        if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
      },
      responseType: ResponseType.json,
    )).delete<Map<String, dynamic>>('/v1/accounts/$id');
    return r.statusCode == 200 && (r.data?['ok'] == true);
  }

  /// `PATCH /v1/accounts/:id` com action `clear_cooldown` ou `warmup`.
  Future<bool> patchAccount(String id, {required String action}) async {
    final r = await Dio(BaseOptions(
      baseUrl: _baseUrl,
      headers: {
        'Content-Type': 'application/json',
        if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
      },
      responseType: ResponseType.json,
    )).patch<Map<String, dynamic>>('/v1/accounts/$id', data: {'action': action});
    return r.statusCode == 200 && (r.data?['ok'] == true);
  }

  /// `GET /v1/accounts/stream` — SSE de mudanças de status em tempo real.
  /// Emite um evento a cada snapshot/heartbeat recebido do proxy.
  /// Reconecta automaticamente em caso de erro de rede.
  Stream<AccountsSnapshot> streamAccounts() async* {
    int reconnectDelay = 1;
    while (true) {
      try {
        final resp = await _dio.get<ResponseBody>(
          '/v1/accounts/stream',
          options: Options(responseType: ResponseType.stream, headers: {'Accept': 'text/event-stream'}),
        );
        final stream = resp.data?.stream;
        if (stream == null) {
          await Future.delayed(Duration(seconds: reconnectDelay));
          reconnectDelay = (reconnectDelay * 2).clamp(1, 30);
          continue;
        }
        reconnectDelay = 1; // reset após sucesso
        final lineBuf = StringBuffer();
        String? currentEventName;
        await for (final chunk in stream) {
          lineBuf.write(utf8.decode(chunk, allowMalformed: true));
          final raw = lineBuf.toString();
          if (!raw.contains('\n')) continue;
          final lines = raw.split('\n');
          lineBuf.clear();
          lineBuf.write(lines.removeLast());
          for (final line in lines) {
            final trimmed = line.trim();
            if (trimmed.isEmpty) {
              currentEventName = null;
              continue;
            }
            if (trimmed.startsWith('event:')) {
              currentEventName = trimmed.substring(6).trim();
            } else if (trimmed.startsWith('data:')) {
              final payload = trimmed.substring(5).trim();
              if (currentEventName == 'snapshot' || currentEventName == 'heartbeat') {
                try {
                  final j = jsonDecode(payload) as Map<String, dynamic>;
                  final accs = j['accounts'];
                  if (accs is List) {
                    yield AccountsSnapshot.fromJson({
                      'total': accs.length,
                      'active': accs.where((a) => !(a as Map)['in_cooldown']).length,
                      'in_cooldown': accs.where((a) => (a as Map)['in_cooldown']).length,
                      'accounts': accs,
                    });
                  }
                } catch (_) {}
              }
            }
          }
        }
        // Stream fechou normalmente — reconecta
        await Future.delayed(const Duration(seconds: 2));
      } catch (e) {
        // Erro de rede — reconecta com backoff
        await Future.delayed(Duration(seconds: reconnectDelay));
        reconnectDelay = (reconnectDelay * 2).clamp(1, 30);
      }
    }
  }

  // ============ CHAT (SSE RICO) ============

  /// Envia uma requisição de chat completion com streaming SSE.
  /// O proxy executa tools server-side e emite eventos extras:
  /// `tool_call.start`, `tool_call.args_delta`, `tool_call.execute.start`,
  /// `tool_call.execute.progress`, `tool_call.execute.complete`,
  /// `tool_call.result`, `tool_call.loop`.
  Stream<ChatStreamEvent> chatStream({
    required String model,
    required List<ChatMessage> messages,
    double temperature = 0.7,
  }) async* {
    final body = <String, dynamic>{
      'model': model,
      'messages': _buildMessagesPayload(messages),
      'stream': true,
      'temperature': temperature,
      // Habilita tools server-side (interceptor do proxy).
      'enable_tools': true,
    };

    String? finishReason;
    final toolCallsAcc = <String, _ToolCallAcc>{};

    try {
      final resp = await _dio.post<ResponseBody>(
        '/v1/chat/completions',
        data: body,
        options: Options(responseType: ResponseType.stream),
      );

      final stream = resp.data?.stream;
      if (stream == null) {
        yield ChatStreamEvent.error('Empty response stream');
        return;
      }

      final lineBuf = StringBuffer();
      String? currentEventName;

      await for (final chunk in stream) {
        final decoded = utf8.decode(chunk, allowMalformed: true);
        lineBuf.write(decoded);
        final raw = lineBuf.toString();
        if (!raw.contains('\n')) continue;
        final lines = raw.split('\n');
        lineBuf.clear();
        lineBuf.write(lines.removeLast());

        for (final line in lines) {
          final trimmed = line.trim();
          if (trimmed.isEmpty) {
            // Event boundary — reset event name
            currentEventName = null;
            continue;
          }
          if (trimmed.startsWith('event:')) {
            currentEventName = trimmed.substring(6).trim();
            continue;
          }
          if (!trimmed.startsWith('data:')) continue;
          final payload = trimmed.substring(5).trim();
          if (payload == '[DONE]') {
            // Emite tool_calls finais (se houver acumulado)
            if (toolCallsAcc.isNotEmpty) {
              yield ChatStreamEvent.toolCalls(
                toolCallsAcc.values.map((a) => a.toToolCall()).toList(),
              );
            }
            yield ChatStreamEvent.done(finishReason);
            return;
          }

          try {
            final json = jsonDecode(payload) as Map<String, dynamic>;

            // Eventos extras do interceptor
            switch (currentEventName) {
              case 'tool_call.start':
                yield ChatStreamEvent.toolCallStart(
                  toolCallId: json['tool_call_id'] as String,
                  name: json['name'] as String,
                  iteration: (json['iteration'] as num?)?.toInt() ?? 1,
                );
                continue;
              case 'tool_call.args_delta':
                final id = json['tool_call_id'] as String;
                final name = json['name'] as String;
                final delta = json['delta'] as String;
                final acc = toolCallsAcc.putIfAbsent(id, () => _ToolCallAcc()..id = id..name = name);
                acc.argsBuf.write(delta);
                yield ChatStreamEvent.toolCallArgsDelta(
                  toolCallId: id,
                  name: name,
                  delta: delta,
                );
                continue;
              case 'tool_call.execute.start':
                yield ChatStreamEvent.toolCallExecuteStart(
                  toolCallId: json['tool_call_id'] as String,
                  name: json['name'] as String,
                  startedAt: DateTime.fromMillisecondsSinceEpoch(
                    (json['started_at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
                  ),
                );
                continue;
              case 'tool_call.execute.progress':
                yield ChatStreamEvent.toolCallProgress(
                  toolCallId: json['tool_call_id'] as String,
                  name: json['name'] as String,
                  message: json['message'] as String? ?? '',
                  percent: (json['percent'] as num?)?.toInt(),
                  data: json['data'] as Map<String, dynamic>?,
                );
                continue;
              case 'tool_call.execute.complete':
                yield ChatStreamEvent.toolCallExecuteComplete(
                  toolCallId: json['tool_call_id'] as String,
                  name: json['name'] as String,
                  success: (json['success'] as bool?) ?? true,
                  durationMs: (json['duration_ms'] as num?)?.toInt() ?? 0,
                  resultLength: (json['result_length'] as num?)?.toInt() ?? 0,
                );
                continue;
              case 'tool_call.result':
                yield ChatStreamEvent.toolCallResult(
                  toolCallId: json['tool_call_id'] as String,
                  name: json['name'] as String,
                  content: json['content'] as String,
                  isError: (json['is_error'] as bool?) ?? false,
                  durationMs: (json['duration_ms'] as num?)?.toInt() ?? 0,
                );
                continue;
              case 'tool_call.loop':
                yield ChatStreamEvent.toolCallLoop(
                  iteration: (json['iteration'] as num?)?.toInt() ?? 0,
                );
                continue;
              case 'error':
                final errMsg = json['error'] is Map
                    ? (json['error']['message'] ?? json['error'].toString())
                    : json['error'].toString();
                yield ChatStreamEvent.error(errMsg.toString());
                return;
            }

            // Evento OpenAI padrão (sem nome, ou `data:` direto)
            if (json.containsKey('error')) {
              final errMsg = json['error'] is Map
                  ? (json['error']['message'] ?? json['error'].toString())
                  : json['error'].toString();
              yield ChatStreamEvent.error(errMsg.toString());
              return;
            }
            final choices = json['choices'] as List?;
            if (choices == null || choices.isEmpty) continue;
            final choice = choices.first as Map<String, dynamic>;
            final delta = choice['delta'] as Map<String, dynamic>?;
            if (delta != null) {
              if (delta['content'] is String) {
                final piece = delta['content'] as String;
                yield ChatStreamEvent.delta(piece);
              }
              // Acumula tool_calls no formato OpenAI (compat)
              final tcList = delta['tool_calls'] as List?;
              if (tcList != null) {
                for (final tcRaw in tcList) {
                  final tc = tcRaw as Map<String, dynamic>;
                  final idx = (tc['index'] as num?)?.toInt() ?? 0;
                  final acc = toolCallsAcc.putIfAbsent(idx.toString(), () => _ToolCallAcc());
                  if (tc['id'] is String) acc.id = tc['id'] as String;
                  final fn = tc['function'] as Map<String, dynamic>?;
                  if (fn != null) {
                    if (fn['name'] is String) acc.name = fn['name'] as String;
                    if (fn['arguments'] is String) acc.argsBuf.write(fn['arguments'] as String);
                  }
                }
              }
            }
            if (choice['finish_reason'] is String) {
              finishReason = choice['finish_reason'] as String;
            }
          } catch (_) {
            // Ignora payload não-JSON
          }
        }
      }
      // Stream fechou sem [DONE]
      if (toolCallsAcc.isNotEmpty) {
        yield ChatStreamEvent.toolCalls(
          toolCallsAcc.values.map((a) => a.toToolCall()).toList(),
        );
      }
      yield ChatStreamEvent.done(finishReason);
    } on DioException catch (e) {
      final data = e.response?.data;
      String msg = e.message ?? 'Dio error';
      if (data is List) {
        final bytes = data.whereType<int>().toList(growable: false);
        if (bytes.isNotEmpty) {
          msg = utf8.decode(bytes, allowMalformed: true);
        }
      } else if (data is String) {
        msg = data;
      } else if (data is Map) {
        msg = data['error']?['message']?.toString() ?? data.toString();
      }
      yield ChatStreamEvent.error('HTTP ${e.response?.statusCode ?? "?"}: $msg');
    } catch (e) {
      yield ChatStreamEvent.error(e.toString());
    }
  }

  List<Map<String, dynamic>> _buildMessagesPayload(List<ChatMessage> messages) {
    // Filtra só user/system/assistant — o proxy gerencia tool_results server-side
    return messages
        .where((m) =>
            m.status != MessageStatus.error &&
            m.content.isNotEmpty &&
            (m.role == MessageRole.user ||
             m.role == MessageRole.system ||
             m.role == MessageRole.assistant))
        .map((m) => m.toApiJson())
        .toList();
  }

  // ============ Helpers JSON ============

  Future<Map<String, dynamic>> _jsonGet(String path) async {
    final r = await Dio(BaseOptions(
      baseUrl: _baseUrl,
      headers: {
        if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
      },
      responseType: ResponseType.json,
      receiveTimeout: const Duration(seconds: 15),
    )).get<Map<String, dynamic>>(path);
    return r.data ?? {};
  }

  Future<Map<String, dynamic>> _jsonPost(String path, Map<String, dynamic> body) async {
    final r = await Dio(BaseOptions(
      baseUrl: _baseUrl,
      headers: {
        'Content-Type': 'application/json',
        if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
      },
      responseType: ResponseType.json,
      receiveTimeout: const Duration(seconds: 30),
    )).post<Map<String, dynamic>>(path, data: body);
    return r.data ?? {};
  }
}

/// Eventos emitidos pelo stream de chat.
/// Inclui eventos OpenAI padrão + eventos extras do interceptor do proxy.
sealed class ChatStreamEvent {
  const ChatStreamEvent();
  const factory ChatStreamEvent.delta(String text) = ChatDeltaEvent;
  const factory ChatStreamEvent.toolCalls(List<ToolCall> calls) = ChatToolCallsEvent;
  const factory ChatStreamEvent.done(String? finishReason) = ChatDoneEvent;
  const factory ChatStreamEvent.error(String message) = ChatErrorEvent;
  const factory ChatStreamEvent.toolCallStart({required String toolCallId, required String name, required int iteration}) = ToolCallStartEvent;
  const factory ChatStreamEvent.toolCallArgsDelta({required String toolCallId, required String name, required String delta}) = ToolCallArgsDeltaEvent;
  const factory ChatStreamEvent.toolCallExecuteStart({required String toolCallId, required String name, required DateTime startedAt}) = ToolCallExecuteStartEvent;
  const factory ChatStreamEvent.toolCallProgress({required String toolCallId, required String name, required String message, int? percent, Map<String, dynamic>? data}) = ToolCallProgressEvent;
  const factory ChatStreamEvent.toolCallExecuteComplete({required String toolCallId, required String name, required bool success, required int durationMs, required int resultLength}) = ToolCallExecuteCompleteEvent;
  const factory ChatStreamEvent.toolCallResult({required String toolCallId, required String name, required String content, required bool isError, required int durationMs}) = ToolCallResultEvent;
  const factory ChatStreamEvent.toolCallLoop({required int iteration}) = ToolCallLoopEvent;
}

class ChatDeltaEvent extends ChatStreamEvent {
  final String text;
  const ChatDeltaEvent(this.text);
}

class ChatToolCallsEvent extends ChatStreamEvent {
  final List<ToolCall> calls;
  const ChatToolCallsEvent(this.calls);
}

class ChatDoneEvent extends ChatStreamEvent {
  final String? finishReason;
  const ChatDoneEvent(this.finishReason);
}

class ChatErrorEvent extends ChatStreamEvent {
  final String message;
  const ChatErrorEvent(this.message);
}

class ToolCallStartEvent extends ChatStreamEvent {
  final String toolCallId;
  final String name;
  final int iteration;
  const ToolCallStartEvent({required this.toolCallId, required this.name, required this.iteration});
}

class ToolCallArgsDeltaEvent extends ChatStreamEvent {
  final String toolCallId;
  final String name;
  final String delta;
  const ToolCallArgsDeltaEvent({required this.toolCallId, required this.name, required this.delta});
}

class ToolCallExecuteStartEvent extends ChatStreamEvent {
  final String toolCallId;
  final String name;
  final DateTime startedAt;
  const ToolCallExecuteStartEvent({required this.toolCallId, required this.name, required this.startedAt});
}

class ToolCallProgressEvent extends ChatStreamEvent {
  final String toolCallId;
  final String name;
  final String message;
  final int? percent;
  final Map<String, dynamic>? data;
  const ToolCallProgressEvent({required this.toolCallId, required this.name, required this.message, this.percent, this.data});
}

class ToolCallExecuteCompleteEvent extends ChatStreamEvent {
  final String toolCallId;
  final String name;
  final bool success;
  final int durationMs;
  final int resultLength;
  const ToolCallExecuteCompleteEvent({required this.toolCallId, required this.name, required this.success, required this.durationMs, required this.resultLength});
}

class ToolCallResultEvent extends ChatStreamEvent {
  final String toolCallId;
  final String name;
  final String content;
  final bool isError;
  final int durationMs;
  const ToolCallResultEvent({required this.toolCallId, required this.name, required this.content, required this.isError, required this.durationMs});
}

class ToolCallLoopEvent extends ChatStreamEvent {
  final int iteration;
  const ToolCallLoopEvent({required this.iteration});
}

class _ToolCallAcc {
  String id = '';
  String name = '';
  final StringBuffer argsBuf = StringBuffer();

  ToolCall toToolCall() {
    Map<String, dynamic> args;
    try {
      args = Map<String, dynamic>.from(jsonDecode(argsBuf.toString()));
    } catch (_) {
      try {
        args = Map<String, dynamic>.from(
          jsonDecode(argsBuf.toString().replaceAll(RegExp(r',\s*([}\]])'), r'$1')),
        );
      } catch (_) {
        args = {'_raw': argsBuf.toString()};
      }
    }
    return ToolCall(id: id, name: name, arguments: args);
  }
}
