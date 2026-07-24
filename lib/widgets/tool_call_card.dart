import 'dart:convert';
import 'package:flutter/material.dart';
import '../models/streaming_tool_call.dart';
import '../theme/app_theme.dart';

/// Card que exibe uma chamada de ferramenta com streaming visual em tempo real.
///
/// Estados visuais:
/// 1. `receivingArgs` — spinner + "args recebendo..."  (mostra args parciais)
/// 2. `executing` — spinner pulsante + última mensagem de progresso
/// 3. `completed` — check verde + duração + args (colapsável) + resultado
/// 4. `failed` — X vermelho + erro
class ToolCallCard extends StatefulWidget {
  final StreamingToolCall toolCall;

  const ToolCallCard({super.key, required this.toolCall});

  @override
  State<ToolCallCard> createState() => _ToolCallCardState();
}

class _ToolCallCardState extends State<ToolCallCard> with TickerProviderStateMixin {
  bool _argsExpanded = false;
  bool _resultExpanded = false;
  late final AnimationController _pulseController;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat();
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tc = widget.toolCall;
    final status = tc.status;

    return Container(
      margin: const EdgeInsets.only(top: 6, bottom: 6),
      decoration: BoxDecoration(
        color: AppTheme.bgSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: status == ToolCallStatus.executing
              ? AppTheme.claudeOrange.withOpacity(0.5)
              : status == ToolCallStatus.failed
                  ? AppTheme.statusError.withOpacity(0.4)
                  : status == ToolCallStatus.completed
                      ? AppTheme.statusSuccess.withOpacity(0.3)
                      : AppTheme.borderSubtle,
          width: 0.6,
        ),
      ),
      child: Material(
        color: Colors.transparent,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildHeader(tc, status),
              if (status == ToolCallStatus.receivingArgs && tc.argsBuffer.isNotEmpty)
                _buildArgsPreview(tc),
              if (status == ToolCallStatus.executing)
                _buildExecuting(tc),
              if (status == ToolCallStatus.completed || status == ToolCallStatus.failed)
                ..._buildFinal(tc, status),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(StreamingToolCall tc, ToolCallStatus status) {
    final icon = _statusIcon(status);
    final label = _statusLabel(status);
    final color = _statusColor(status);

    return Row(
      children: [
        if (status == ToolCallStatus.receivingArgs || status == ToolCallStatus.executing)
          SizedBox(
            width: 14,
            height: 14,
            child: AnimatedBuilder(
              animation: _pulseController,
              builder: (context, _) {
                return Transform.scale(
                  scale: 0.85 + 0.15 * _pulseController.value,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.8,
                    valueColor: AlwaysStoppedAnimation(color),
                  ),
                );
              },
            ),
          )
        else
          Icon(icon, size: 14, color: color),
        const SizedBox(width: 8),
        Text(
          label,
          style: AppTheme.sansTextStyle(
            color: AppTheme.textMuted,
            fontSize: 11,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            tc.name,
            style: TextStyle(
              fontFamily: 'monospace',
              color: color,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const Spacer(),
        if (tc.durationMs != null && (status == ToolCallStatus.completed || status == ToolCallStatus.failed))
          Text(
            '${tc.durationMs}ms',
            style: AppTheme.sansTextStyle(
              color: AppTheme.textMuted,
              fontSize: 10,
            ),
          ),
      ],
    );
  }

  Widget _buildArgsPreview(StreamingToolCall tc) {
    return Padding(
      padding: const EdgeInsets.only(top: 6, left: 22),
      child: Text(
        tc.argsBuffer,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontFamily: 'monospace',
          color: AppTheme.textSecondary,
          fontSize: 11,
        ),
      ),
    );
  }

  Widget _buildExecuting(StreamingToolCall tc) {
    final latest = tc.progressUpdates.isNotEmpty ? tc.progressUpdates.last : null;
    return Padding(
      padding: const EdgeInsets.only(top: 6, left: 22),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.bolt, size: 12, color: AppTheme.claudeOrange.withOpacity(0.7)),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (latest != null) ...[
                  if (latest.percent != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(2),
                        child: LinearProgressIndicator(
                          value: latest.percent! / 100,
                          minHeight: 3,
                          backgroundColor: AppTheme.bgBase,
                          valueColor: AlwaysStoppedAnimation(AppTheme.claudeOrange),
                        ),
                      ),
                    ),
                  Text(
                    latest.message,
                    style: AppTheme.sansTextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 11,
                    ),
                  ),
                ] else
                  Text(
                    'executando…',
                    style: AppTheme.sansTextStyle(
                      color: AppTheme.textMuted,
                      fontSize: 11,
                      fontStyle: FontStyle.italic,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _buildFinal(StreamingToolCall tc, ToolCallStatus status) {
    return [
      // Args (colapsável)
      if (tc.argsBuffer.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 6, left: 22),
          child: _CollapsibleSection(
            title: 'argumentos',
            content: _prettyJson(tc.argsBuffer),
            expanded: _argsExpanded,
            onToggle: () => setState(() => _argsExpanded = !_argsExpanded),
          ),
        ),
      // Result (colapsável)
      if (tc.resultContent != null)
        Padding(
          padding: const EdgeInsets.only(top: 4, left: 22),
          child: _CollapsibleSection(
            title: status == ToolCallStatus.failed ? 'erro' : 'resultado',
            content: _prettyJson(tc.resultContent!),
            isError: status == ToolCallStatus.failed,
            expanded: _resultExpanded,
            onToggle: () => setState(() => _resultExpanded = !_resultExpanded),
          ),
        ),
    ];
  }

  String _prettyJson(String raw) {
    try {
      final decoded = jsonDecode(raw);
      return const JsonEncoder.withIndent('  ').convert(decoded);
    } catch (_) {
      return raw;
    }
  }

  IconData _statusIcon(ToolCallStatus s) {
    switch (s) {
      case ToolCallStatus.receivingArgs:
        return Icons.more_horiz;
      case ToolCallStatus.executing:
        return Icons.bolt;
      case ToolCallStatus.completed:
        return Icons.check_circle;
      case ToolCallStatus.failed:
        return Icons.error;
    }
  }

  String _statusLabel(ToolCallStatus s) {
    switch (s) {
      case ToolCallStatus.receivingArgs:
        return 'preparando';
      case ToolCallStatus.executing:
        return 'executando';
      case ToolCallStatus.completed:
        return 'concluído';
      case ToolCallStatus.failed:
        return 'falhou';
    }
  }

  Color _statusColor(ToolCallStatus s) {
    switch (s) {
      case ToolCallStatus.receivingArgs:
      case ToolCallStatus.executing:
        return AppTheme.claudeOrange;
      case ToolCallStatus.completed:
        return AppTheme.statusSuccess;
      case ToolCallStatus.failed:
        return AppTheme.statusError;
    }
  }
}

class _CollapsibleSection extends StatelessWidget {
  final String title;
  final String content;
  final bool expanded;
  final bool isError;
  final VoidCallback onToggle;

  const _CollapsibleSection({
    required this.title,
    required this.content,
    required this.expanded,
    required this.onToggle,
    this.isError = false,
  });

  @override
  Widget build(BuildContext context) {
    final color = isError ? AppTheme.statusError : AppTheme.textMuted;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onToggle,
        borderRadius: BorderRadius.circular(6),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    expanded ? Icons.expand_less : Icons.expand_more,
                    size: 14,
                    color: color,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    title,
                    style: AppTheme.sansTextStyle(
                      color: color,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.4,
                    ),
                  ),
                ],
              ),
              if (expanded)
                Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(top: 4),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AppTheme.bgBase,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.borderSubtle, width: 0.3),
                  ),
                  child: SelectableText(
                    content,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      color: isError ? AppTheme.statusError.withOpacity(0.9) : AppTheme.textSecondary,
                      fontSize: 11,
                      height: 1.4,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
