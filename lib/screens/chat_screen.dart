import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/chat_provider.dart';
import '../theme/app_theme.dart';
import '../widgets/chat_input.dart';
import '../widgets/message_bubble.dart';
import 'settings_screen.dart';

/// Tela principal de chat.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _scrollController = ScrollController();
  bool _autoScroll = true;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(() {
      final atBottom = _scrollController.position.pixels >=
          _scrollController.position.maxScrollExtent - 80;
      if (atBottom != _autoScroll) setState(() => _autoScroll = atBottom);
    });
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (!_autoScroll) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final messages = provider.messages;
    _scrollToBottom();

    return Scaffold(
      backgroundColor: AppTheme.bgBase,
      appBar: AppBar(
        backgroundColor: AppTheme.bgBase,
        surfaceTintColor: Colors.transparent,
        leading: _buildStatusDot(provider),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('QwenCoder'),
            Text(
              provider.proxyOnline
                  ? '${provider.settings.defaultModel}  •  ${provider.accounts.length} conta(s)'
                  : (provider.connectionError ?? 'Proxy offline'),
              style: AppTheme.sansTextStyle(color: provider.proxyOnline ? AppTheme.textMuted : AppTheme.statusError,
                fontSize: 11,
                fontWeight: FontWeight.w400),
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Modelos',
            icon: const Icon(Icons.memory),
            onPressed: () => _showModelsSheet(context, provider),
          ),
          IconButton(
            tooltip: 'Configurações',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const SettingsScreen()),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: messages.isEmpty
                ? _EmptyState(onPickSuggestion: (s) => _sendSuggestion(provider, s))
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    itemCount: messages.length,
                    itemBuilder: (context, i) {
                      final m = messages[i];
                      return MessageBubble(message: m, isLast: i == messages.length - 1);
                    },
                  ),
          ),
          if (provider.isSending)
            Padding(
              padding: const EdgeInsets.only(left: 16, bottom: 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'processando…',
                  style: AppTheme.sansTextStyle(color: AppTheme.textMuted,
                    fontSize: 11),
                ),
              ),
            ),
          ChatInput(
            onSend: provider.sendUserMessage,
            onStop: provider.stopGeneration,
            isSending: provider.isSending,
          ),
        ],
      ),
      floatingActionButton: !_autoScroll
          ? FloatingActionButton.small(
              onPressed: () {
                setState(() => _autoScroll = true);
                _scrollController.animateTo(
                  _scrollController.position.maxScrollExtent,
                  duration: const Duration(milliseconds: 200),
                  curve: Curves.easeOut,
                );
              },
              child: const Icon(Icons.arrow_downward, size: 18),
            )
          : null,
    );
  }

  Widget _buildStatusDot(ChatProvider provider) {
    final color = provider.proxyOnline
        ? AppTheme.statusSuccess
        : provider.isConnecting
            ? AppTheme.statusWarning
            : AppTheme.statusError;
    return Padding(
      padding: const EdgeInsets.only(left: 12, top: 10, bottom: 10),
      child: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          boxShadow: [BoxShadow(color: color.withValues(alpha: 0.5), blurRadius: 6)],
        ),
      ),
    );
  }

  void _sendSuggestion(ChatProvider provider, String s) {
    provider.sendUserMessage(s);
  }

  void _showModelsSheet(BuildContext context, ChatProvider provider) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppTheme.bgSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Row(
                  children: [
                    Text(
                      'Modelos disponíveis',
                      style: AppTheme.sansTextStyle(color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w600,
                        fontSize: 14),
                    ),
                    const Spacer(),
                    IconButton(
                      icon: const Icon(Icons.refresh, size: 18),
                      onPressed: () => provider.testConnection(),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              if (provider.models.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(
                    child: Text(
                      'Nenhum modelo carregado. Verifique a conexão com o proxy.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                )
              else
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: MediaQuery.of(context).size.height * 0.5,
                  ),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: provider.models.length,
                    itemBuilder: (ctx, i) {
                      final m = provider.models[i];
                      final selected = m == provider.settings.defaultModel;
                      return ListTile(
                        leading: Icon(
                          selected ? Icons.check_circle : Icons.circle_outlined,
                          size: 18,
                          color: selected ? AppTheme.claudeOrange : AppTheme.textMuted,
                        ),
                        title: Text(
                          m,
                          style: TextStyle(
                            fontFamily: 'monospace',
                            color: AppTheme.textPrimary,
                            fontSize: 13,
                          ),
                        ),
                        onTap: () {
                          provider.updateSettings(
                            provider.settings.copyWith(defaultModel: m),
                          );
                          Navigator.of(ctx).pop();
                        },
                      );
                    },
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _EmptyState extends StatelessWidget {
  final ValueChanged<String> onPickSuggestion;
  const _EmptyState({required this.onPickSuggestion});

  static const _suggestions = [
    'Que horas são agora no meu device?',
    'Calcule 2*(3+4)^2 - sqrt(16)',
    'Converta "QwenCoder" para base64',
    'Como funciona o tool call em LLMs?',
  ];

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: AppTheme.claudeOrange,
                borderRadius: BorderRadius.circular(16),
              ),
              child: const Icon(Icons.auto_awesome, color: Colors.white, size: 32),
            ),
            const SizedBox(height: 18),
            Text(
              'QwenCoder',
              style: AppTheme.serifTextStyle(color: AppTheme.textPrimary,
                fontSize: 26,
                fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Text(
              'Cliente Flutter para o proxy QwenBridge\ncom suporte a tool calls e contas múltiplas.',
              textAlign: TextAlign.center,
              style: AppTheme.sansTextStyle(color: AppTheme.textSecondary,
                fontSize: 13,
                height: 1.5),
            ),
            const SizedBox(height: 24),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              alignment: WrapAlignment.center,
              children: _suggestions
                  .map((s) => ActionChip(
                        label: Text(s),
                        labelStyle: AppTheme.sansTextStyle(color: AppTheme.textPrimary,
                          fontSize: 12),
                        backgroundColor: AppTheme.bgSurface,
                        side: BorderSide(color: AppTheme.borderSubtle, width: 0.5),
                        onPressed: () => onPickSuggestion(s),
                      ))
                  .toList(),
            ),
          ],
        ),
      ),
    );
  }
}
