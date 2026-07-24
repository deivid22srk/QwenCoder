import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Caixa de entrada de texto estilo Claude:
/// - Campo arredondado, sem bordas visíveis pesadas
/// - Botão de enviar circular com cor de destaque
/// - Suporte para multiline (até 6 linhas)
class ChatInput extends StatefulWidget {
  final ValueChanged<String> onSend;
  final VoidCallback? onStop;
  final bool isSending;
  final bool enabled;

  const ChatInput({
    super.key,
    required this.onSend,
    this.onStop,
    this.isSending = false,
    this.enabled = true,
  });

  @override
  State<ChatInput> createState() => _ChatInputState();
}

class _ChatInputState extends State<ChatInput> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final h = _controller.text.trim().isNotEmpty;
      if (h != _hasText) setState(() => _hasText = h);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _send() {
    final text = _controller.text.trim();
    if (text.isEmpty || widget.isSending) return;
    widget.onSend(text);
    _controller.clear();
    _focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 4, 12, 8),
        decoration: BoxDecoration(
          color: AppTheme.bgSurface,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: AppTheme.borderSubtle, width: 0.6),
        ),
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: _controller,
                focusNode: _focus,
                enabled: widget.enabled,
                maxLines: null,
                minLines: 1,
                textCapitalization: TextCapitalization.sentences,
                style: AppTheme.sansTextStyle(
                  color: AppTheme.textPrimary,
                  fontSize: 15,
                  height: 1.4,
                ),
                decoration: InputDecoration(
                  hintText: 'Envie uma mensagem para o QwenCoder…',
                  hintStyle: AppTheme.sansTextStyle(
                    color: AppTheme.textMuted,
                    fontSize: 15,
                  ),
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  isDense: true,
                ),
                textInputAction: TextInputAction.newline,
                onSubmitted: (_) => _send(),
              ),
            ),
            const SizedBox(width: 8),
            if (widget.isSending)
              _SendButton(
                onTap: widget.onStop,
                icon: Icons.stop,
                color: AppTheme.statusError,
              )
            else
              _SendButton(
                onTap: _hasText ? _send : null,
                icon: Icons.arrow_upward,
                color: AppTheme.claudeOrange,
              ),
          ],
        ),
      ),
    );
  }
}

class _SendButton extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData icon;
  final Color color;

  const _SendButton({required this.onTap, required this.icon, required this.color});

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Material(
      color: enabled ? color : color.withOpacity(0.4),
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: 36,
          height: 36,
          alignment: Alignment.center,
          child: Icon(icon, color: Colors.white, size: 20),
        ),
      ),
    );
  }
}
