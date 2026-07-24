import 'package:flutter/foundation.dart';
import 'tool_call.dart';
import 'streaming_tool_call.dart';

export 'tool_call.dart' show MessageRole, ToolCall;
export 'streaming_tool_call.dart' show StreamingToolCall, ToolCallStatus, ToolCallProgressUpdate;

/// Status de uma mensagem no histórico.
enum MessageStatus {
  sending,
  streaming,
  complete,
  error,
  toolRunning,
}

/// Uma mensagem no histórico de chat.
/// Suporta conteúdo textual, chamadas de ferramenta (assistant) com
/// streaming em tempo real, e resultados de ferramenta (tool).
@immutable
class ChatMessage {
  final String id;
  final MessageRole role;
  final String content;
  final List<ToolCall> toolCalls;
  final List<StreamingToolCall> streamingToolCalls;
  final String? toolCallId;
  final String? toolName;
  final MessageStatus status;
  final DateTime createdAt;
  final String? error;
  final Map<String, dynamic> metadata;

  const ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    this.toolCalls = const [],
    this.streamingToolCalls = const [],
    this.toolCallId,
    this.toolName,
    this.status = MessageStatus.complete,
    required this.createdAt,
    this.error,
    this.metadata = const {},
  });

  ChatMessage copyWith({
    String? id,
    MessageRole? role,
    String? content,
    List<ToolCall>? toolCalls,
    List<StreamingToolCall>? streamingToolCalls,
    String? toolCallId,
    String? toolName,
    MessageStatus? status,
    DateTime? createdAt,
    String? error,
    Map<String, dynamic>? metadata,
  }) =>
      ChatMessage(
        id: id ?? this.id,
        role: role ?? this.role,
        content: content ?? this.content,
        toolCalls: toolCalls ?? this.toolCalls,
        streamingToolCalls: streamingToolCalls ?? this.streamingToolCalls,
        toolCallId: toolCallId ?? this.toolCallId,
        toolName: toolName ?? this.toolName,
        status: status ?? this.status,
        createdAt: createdAt ?? this.createdAt,
        error: error ?? this.error,
        metadata: metadata ?? this.metadata,
      );

  factory ChatMessage.user(String text) => ChatMessage(
        id: _uuid(),
        role: MessageRole.user,
        content: text,
        createdAt: DateTime.now(),
      );

  factory ChatMessage.assistant({String content = ''}) => ChatMessage(
        id: _uuid(),
        role: MessageRole.assistant,
        content: content,
        createdAt: DateTime.now(),
        status: MessageStatus.streaming,
      );

  factory ChatMessage.tool({
    required String toolCallId,
    required String toolName,
    required String content,
  }) =>
      ChatMessage(
        id: _uuid(),
        role: MessageRole.tool,
        content: content,
        toolCallId: toolCallId,
        toolName: toolName,
        createdAt: DateTime.now(),
        status: MessageStatus.complete,
      );

  factory ChatMessage.system(String text) => ChatMessage(
        id: _uuid(),
        role: MessageRole.system,
        content: text,
        createdAt: DateTime.now(),
      );

  factory ChatMessage.error(String text) => ChatMessage(
        id: _uuid(),
        role: MessageRole.assistant,
        content: text,
        createdAt: DateTime.now(),
        status: MessageStatus.error,
        error: text,
      );

  /// Converte para o formato JSON esperado pela API OpenAI-compatible.
  /// Importante: o proxy agora executa tools server-side, então o cliente
  /// NÃO envia tool_results manualmente — apenas as mensagens user/assistant/system.
  Map<String, dynamic> toApiJson() {
    final Map<String, dynamic> j = {
      'role': role.wire,
    };
    if (role == MessageRole.tool) {
      // Não enviamos tool messages para o proxy — ele gerencia isso server-side
      j['content'] = content;
      j['tool_call_id'] = toolCallId;
    } else {
      j['content'] = content;
    }
    return j;
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) || other is ChatMessage && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

int _counter = 0;
String _uuid() {
  _counter += 1;
  final ts = DateTime.now().microsecondsSinceEpoch;
  return 'msg_${ts}_$_counter';
}
