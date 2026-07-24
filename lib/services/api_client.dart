import 'dart:async';
import 'dart:convert';
import 'package:dio/dio.dart';
import '../models/chat_message.dart';
import '../models/tool_call.dart';
import 'tool_executor.dart';

/// Cliente da API OpenAI-compatible do proxy QwenBridge.
///
/// Endpoints consumidos:
/// - `POST /v1/chat/completions` (com `stream: true` por padrão)
/// - `GET  /v1/models`
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
  Future<List<String>> listModels() async {
    try {
      final r = await Dio(BaseOptions(
        baseUrl: _baseUrl,
        headers: {
          if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
        },
        responseType: ResponseType.json,
      )).get<Map<String, dynamic>>('/v1/models');
      final data = r.data;
      if (data == null) return const [];
      final list = data['data'] as List? ?? [];
      return list
          .map((m) => (m as Map<String, dynamic>)['id'] as String?)
          .where((s) => s != null && s.isNotEmpty)
          .cast<String>()
          .toList();
    } catch (_) {
      return const [];
    }
  }

  /// Envia uma requisição de chat completion com streaming SSE.
  ///
  /// Emite eventos de três tipos:
  /// - `ChatStreamEvent.delta(String text)` — texto incremental da resposta
  /// - `ChatStreamEvent.toolCalls(List<ToolCall> calls)` — chamadas de ferramenta finalizadas
  /// - `ChatStreamEvent.done(String? finishReason)` — fim do stream
  /// - `ChatStreamEvent.error(String message)` — erro
  Stream<ChatStreamEvent> chatStream({
    required String model,
    required List<ChatMessage> messages,
    double temperature = 0.7,
    bool enableTools = true,
    String? toolChoice,
  }) async* {
    final body = <String, dynamic>{
      'model': model,
      'messages': _buildMessagesPayload(messages),
      'stream': true,
      'temperature': temperature,
    };
    if (enableTools) {
      body['tools'] = ToolExecutor.allDefinitions().map((t) => t.toApiJson()).toList();
      if (toolChoice != null) {
        body['tool_choice'] = toolChoice;
      } else {
        body['tool_choice'] = 'auto';
      }
    }

    final accumulators = <String, _ToolCallAcc>{};
    final contentBuf = StringBuffer();
    String? finishReason;

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

      // Buffer para juntar chunks SSE que chegam fragmentados.
      final lineBuf = StringBuffer();
      await for (final chunk in stream) {
        final decoded = utf8.decode(chunk, allowMalformed: true);
        lineBuf.write(decoded);
        final raw = lineBuf.toString();
        if (!raw.contains('\n')) continue;
        final lines = raw.split('\n');
        // Mantém última linha parcial no buffer
        lineBuf.clear();
        lineBuf.write(lines.removeLast());

        for (final line in lines) {
          final trimmed = line.trim();
          if (trimmed.isEmpty) continue;
          if (!trimmed.startsWith('data:')) continue;
          final payload = trimmed.substring(5).trim();
          if (payload == '[DONE]') {
            yield ChatStreamEvent.done(finishReason);
            return;
          }
          try {
            final json = jsonDecode(payload) as Map<String, dynamic>;
            if (json.containsKey('error')) {
              final errMsg = (json['error'] is Map)
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
                contentBuf.write(piece);
                yield ChatStreamEvent.delta(piece);
              }
              final tcList = delta['tool_calls'] as List?;
              if (tcList != null) {
                for (final tcRaw in tcList) {
                  final tc = tcRaw as Map<String, dynamic>;
                  final idx = (tc['index'] as num?)?.toInt() ?? 0;
                  final acc = accumulators.putIfAbsent(idx.toString(), () => _ToolCallAcc());
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
            // Ignora payload não-JSON (ex: comentários SSE)
          }
        }
      }
      // Stream fechou sem [DONE] — emite done com o finishReason visto.
      if (accumulators.isNotEmpty) {
        yield ChatStreamEvent.toolCalls(accumulators.values.map((a) => a.toToolCall()).toList());
      }
      yield ChatStreamEvent.done(finishReason);
    } on DioException catch (e) {
      final data = e.response?.data;
      String msg = e.message ?? 'Dio error';
      if (data is List) {
        // dio retorna List<dynamic>; utf8.decode espera List<int>
        final bytes = (data as List).whereType<int>().toList(growable: false);
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

  /// Modo não-streaming (fallback).
  Future<ChatCompletionResult> chatOnce({
    required String model,
    required List<ChatMessage> messages,
    double temperature = 0.7,
    bool enableTools = true,
  }) async {
    final body = <String, dynamic>{
      'model': model,
      'messages': _buildMessagesPayload(messages),
      'stream': false,
      'temperature': temperature,
    };
    if (enableTools) {
      body['tools'] = ToolExecutor.allDefinitions().map((t) => t.toApiJson()).toList();
      body['tool_choice'] = 'auto';
    }
    final r = await Dio(BaseOptions(
      baseUrl: _baseUrl,
      headers: {
        'Content-Type': 'application/json',
        if (_apiKey.isNotEmpty) 'Authorization': 'Bearer $_apiKey',
      },
      responseType: ResponseType.json,
      receiveTimeout: const Duration(minutes: 5),
    )).post<Map<String, dynamic>>('/v1/chat/completions', data: body);

    final data = r.data!;
    final choice = (data['choices'] as List).first as Map<String, dynamic>;
    final msg = choice['message'] as Map<String, dynamic>;
    final content = (msg['content'] as String?) ?? '';
    final toolCalls = (msg['tool_calls'] as List?)
            ?.map((t) => ToolCall.fromJson(t as Map<String, dynamic>))
            .toList() ??
        const [];
    return ChatCompletionResult(content: content, toolCalls: toolCalls);
  }

  List<Map<String, dynamic>> _buildMessagesPayload(List<ChatMessage> messages) {
    return messages.where((m) {
      // Skip mensagens de erro (não vão para a API)
      if (m.status == MessageStatus.error) return false;
      // Skip mensagens vazias
      if (m.content.isEmpty && m.toolCalls.isEmpty) return false;
      return true;
    }).map((m) => m.toApiJson()).toList();
  }
}

/// Eventos emitidos pelo stream de chat.
sealed class ChatStreamEvent {
  const ChatStreamEvent();
  const factory ChatStreamEvent.delta(String text) = ChatDeltaEvent;
  const factory ChatStreamEvent.toolCalls(List<ToolCall> calls) = ChatToolCallsEvent;
  const factory ChatStreamEvent.done(String? finishReason) = ChatDoneEvent;
  const factory ChatStreamEvent.error(String message) = ChatErrorEvent;
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

class ChatCompletionResult {
  final String content;
  final List<ToolCall> toolCalls;
  const ChatCompletionResult({required this.content, required this.toolCalls});
}

class _ToolCallAcc {
  String id = '';
  String name = '';
  final StringBuffer argsBuf = StringBuffer();

  ToolCall toToolCall() => ToolCall(
        id: id,
        name: name,
        arguments: _parseLooseArgs(argsBuf.toString()),
      );

  static Map<String, dynamic> _parseLooseArgs(String s) {
    final trimmed = s.trim();
    if (trimmed.isEmpty) return {};
    try {
      final d = jsonDecode(trimmed);
      if (d is Map) return Map<String, dynamic>.from(d);
    } catch (_) {}
    final cleaned = trimmed.replaceAll(RegExp(r',\s*([}\]])'), r'$1');
    try {
      final d = jsonDecode(cleaned);
      if (d is Map) return Map<String, dynamic>.from(d);
    } catch (_) {}
    final s2 = trimmed.replaceAll("'", '"');
    try {
      final d = jsonDecode(s2);
      if (d is Map) return Map<String, dynamic>.from(d);
    } catch (_) {}
    // Fallback final — devolve o conteúdo cru em _raw
    return {'_raw': trimmed};
  }
}
