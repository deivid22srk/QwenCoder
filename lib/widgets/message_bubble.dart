import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../models/chat_message.dart';
import '../theme/app_theme.dart';
import 'tool_call_card.dart';

/// Bolha de mensagem individual, com aparência inspirada no Claude.
class MessageBubble extends StatelessWidget {
  final ChatMessage message;
  final bool isLast;

  const MessageBubble({super.key, required this.message, this.isLast = false});

  @override
  Widget build(BuildContext context) {
    switch (message.role) {
      case MessageRole.user:
        return _buildUser(context);
      case MessageRole.assistant:
        return _buildAssistant(context);
      case MessageRole.tool:
        return const SizedBox.shrink(); // tool calls são exibidos inline no assistant
      case MessageRole.system:
        return const SizedBox.shrink();
    }
  }

  Widget _buildUser(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.78,
        ),
        margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: AppTheme.bgUserBubble,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(14),
            topRight: Radius.circular(14),
            bottomLeft: Radius.circular(14),
            bottomRight: Radius.circular(4),
          ),
          border: Border.all(color: AppTheme.borderSubtle, width: 0.4),
        ),
        child: SelectableText(
          message.content,
          style: AppTheme.sansTextStyle(
            color: AppTheme.textPrimary,
            fontSize: 15,
            height: 1.5,
          ),
        ),
      ),
    );
  }

  Widget _buildAssistant(BuildContext context) {
    final isStreaming = message.status == MessageStatus.streaming;
    final isError = message.status == MessageStatus.error;
    final isToolRunning = message.status == MessageStatus.toolRunning;
    final hasContent = message.content.isNotEmpty;
    final hasToolCalls = message.streamingToolCalls.isNotEmpty;

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header com avatar Claude-style
          Row(
            children: [
              Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(
                  color: AppTheme.claudeOrange,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: const Center(
                  child: Icon(Icons.auto_awesome, color: Colors.white, size: 16),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                'QwenCoder',
                style: AppTheme.sansTextStyle(
                  color: AppTheme.textSecondary,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
              const Spacer(),
              if (isStreaming || isToolRunning)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.5,
                        valueColor: AlwaysStoppedAnimation(AppTheme.claudeOrange),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      isToolRunning ? 'executando tool…' : 'gerando…',
                      style: AppTheme.sansTextStyle(
                        color: AppTheme.textMuted,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              if (message.metadata['loop_iteration'] != null) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: AppTheme.bgSurfaceAlt,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    'loop #${message.metadata['loop_iteration']}',
                    style: AppTheme.sansTextStyle(
                      color: AppTheme.claudeOrange,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 8),
          // Tool calls em streaming (cada um com card próprio)
          if (hasToolCalls) ...[
            for (final tc in message.streamingToolCalls) ToolCallCard(toolCall: tc),
            const SizedBox(height: 8),
          ],
          // Conteúdo textual (serif, estilo Claude)
          if (hasContent)
            MarkdownBody(
              data: message.content,
              selectable: true,
              styleSheet: MarkdownStyleSheet(
                p: AppTheme.serifTextStyle(
                  color: AppTheme.textPrimary,
                  fontSize: 16,
                  height: 1.65,
                ),
                h1: AppTheme.sansTextStyle(
                  color: AppTheme.textPrimary,
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
                h2: AppTheme.sansTextStyle(
                  color: AppTheme.textPrimary,
                  fontSize: 19,
                  fontWeight: FontWeight.w700,
                ),
                h3: AppTheme.sansTextStyle(
                  color: AppTheme.textPrimary,
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                ),
                code: TextStyle(
                  fontFamily: 'monospace',
                  color: AppTheme.claudeOrangeLight,
                  backgroundColor: AppTheme.bgSurface,
                  fontSize: 14,
                ),
                codeblockDecoration: BoxDecoration(
                  color: AppTheme.bgSurface,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppTheme.borderSubtle, width: 0.5),
                ),
                blockquoteDecoration: BoxDecoration(
                  border: Border(
                    left: BorderSide(color: AppTheme.claudeOrange, width: 2),
                  ),
                ),
                listBullet: AppTheme.sansTextStyle(color: AppTheme.claudeOrange),
                strong: AppTheme.serifTextStyle(
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textPrimary,
                ),
                em: AppTheme.serifTextStyle(
                  fontWeight: FontWeight.w400,
                  color: AppTheme.textPrimary,
                ).copyWith(fontStyle: FontStyle.italic),
                a: TextStyle(
                  color: AppTheme.claudeOrange,
                  decoration: TextDecoration.underline,
                ),
              ),
            ),
          if (isStreaming && !hasContent && !hasToolCalls)
            const Padding(
              padding: EdgeInsets.only(top: 4, bottom: 4),
              child: _BlinkingDots(),
            ),
          if (isError && message.error != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.error_outline, color: AppTheme.statusError, size: 16),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      message.error!,
                      style: AppTheme.sansTextStyle(
                        color: AppTheme.statusError,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _BlinkingDots extends StatefulWidget {
  @override
  State<_BlinkingDots> createState() => _BlinkingDotsState();
}

class _BlinkingDotsState extends State<_BlinkingDots> with TickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(3, (i) {
            final t = (_c.value * 3 - i).clamp(0.0, 1.0);
            final opacity = (t < 0.5) ? (t * 2) : (2 - t * 2);
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Opacity(
                opacity: 0.3 + 0.7 * opacity,
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: AppTheme.claudeOrange,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            );
          }),
        );
      },
    );
  }
}
