import 'dart:convert';
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/tool_call.dart';

/// Card que exibe uma chamada de ferramenta solicitada pelo modelo.
/// Mostra o nome da ferramenta e os argumentos JSON em formato colapsável.
class ToolCallCard extends StatefulWidget {
  final ToolCall toolCall;

  const ToolCallCard({super.key, required this.toolCall});

  @override
  State<ToolCallCard> createState() => _ToolCallCardState();
}

class _ToolCallCardState extends State<ToolCallCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final args = const JsonEncoder.withIndent('  ').convert(widget.toolCall.arguments);
    return Container(
      margin: const EdgeInsets.only(top: 4, bottom: 4, left: 0),
      decoration: BoxDecoration(
        color: AppTheme.bgSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.borderSubtle, width: 0.5),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => setState(() => _expanded = !_expanded),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.call_made,
                      size: 14,
                      color: AppTheme.claudeOrange,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'chamada de ferramenta',
                      style: AppTheme.sansTextStyle(
                        color: AppTheme.textMuted,
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      widget.toolCall.name,
                      style: TextStyle(
                        fontFamily: 'monospace',
                        color: AppTheme.claudeOrangeLight,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const Spacer(),
                    Icon(
                      _expanded ? Icons.expand_less : Icons.expand_more,
                      size: 18,
                      color: AppTheme.textMuted,
                    ),
                  ],
                ),
                if (_expanded) ...[
                  const SizedBox(height: 8),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppTheme.bgBase,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: AppTheme.borderSubtle, width: 0.3),
                    ),
                    child: SelectableText(
                      args,
                      style: TextStyle(
                        fontFamily: 'monospace',
                        color: AppTheme.textSecondary,
                        fontSize: 12,
                        height: 1.4,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
