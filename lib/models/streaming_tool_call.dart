import 'package:flutter/foundation.dart';

/// Status de execução de uma tool call — usado para renderizar o card
/// com transições visuais (start → executing → result).
enum ToolCallStatus {
  /// Args ainda estão sendo recebidos do modelo
  receivingArgs,

  /// Tool está sendo executada server-side
  executing,

  /// Tool finalizou (com sucesso)
  completed,

  /// Tool falhou
  failed,
}

/// Modelo que rastreia uma tool call durante o ciclo de vida no app.
/// É atualizado a cada evento SSE correspondente emitido pelo proxy.
@immutable
class StreamingToolCall {
  final String id;
  final String name;
  final String argsBuffer;
  final ToolCallStatus status;
  final String? resultContent;
  final bool isError;
  final int? durationMs;
  final List<ToolCallProgressUpdate> progressUpdates;
  final DateTime? startedAt;
  final DateTime? completedAt;

  const StreamingToolCall({
    required this.id,
    required this.name,
    this.argsBuffer = '',
    this.status = ToolCallStatus.receivingArgs,
    this.resultContent,
    this.isError = false,
    this.durationMs,
    this.progressUpdates = const [],
    this.startedAt,
    this.completedAt,
  });

  StreamingToolCall copyWith({
    String? id,
    String? name,
    String? argsBuffer,
    ToolCallStatus? status,
    String? resultContent,
    bool? isError,
    int? durationMs,
    List<ToolCallProgressUpdate>? progressUpdates,
    DateTime? startedAt,
    DateTime? completedAt,
  }) =>
      StreamingToolCall(
        id: id ?? this.id,
        name: name ?? this.name,
        argsBuffer: argsBuffer ?? this.argsBuffer,
        status: status ?? this.status,
        resultContent: resultContent ?? this.resultContent,
        isError: isError ?? this.isError,
        durationMs: durationMs ?? this.durationMs,
        progressUpdates: progressUpdates ?? this.progressUpdates,
        startedAt: startedAt ?? this.startedAt,
        completedAt: completedAt ?? this.completedAt,
      );
}

@immutable
class ToolCallProgressUpdate {
  final String message;
  final int? percent;
  final Map<String, dynamic>? data;
  final DateTime timestamp;

  const ToolCallProgressUpdate({
    required this.message,
    this.percent,
    this.data,
    required this.timestamp,
  });
}
