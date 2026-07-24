import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../models/app_settings.dart';
import '../models/qwen_account.dart';
import '../services/chat_provider.dart';
import '../theme/app_theme.dart';

/// Tela de configurações.
/// - Conexão com o proxy (URL + API key)
/// - Modelo padrão e parâmetros
/// - System prompt customizado
/// - Lista de tools server-side disponíveis
/// - Gerenciamento de contas Qwen (adicionar/remover/limpar cooldown/warmup)
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late TextEditingController _urlCtrl;
  late TextEditingController _keyCtrl;
  late TextEditingController _systemPromptCtrl;
  late TextEditingController _tempCtrl;
  late bool _streaming;
  late bool _enableTools;
  bool _dirty = false;

  @override
  void initState() {
    super.initState();
    final s = context.read<ChatProvider>().settings;
    _urlCtrl = TextEditingController(text: s.proxyBaseUrl);
    _keyCtrl = TextEditingController(text: s.apiKey);
    _systemPromptCtrl = TextEditingController(text: s.systemPrompt);
    _tempCtrl = TextEditingController(text: s.temperature.toString());
    _streaming = s.streaming;
    _enableTools = s.enableTools;
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _keyCtrl.dispose();
    _systemPromptCtrl.dispose();
    _tempCtrl.dispose();
    super.dispose();
  }

  void _markDirty() {
    if (!_dirty) setState(() => _dirty = true);
  }

  Future<void> _save() async {
    final provider = context.read<ChatProvider>();
    final newSettings = AppSettings(
      proxyBaseUrl: _urlCtrl.text.trim().isEmpty
          ? 'http://10.0.2.2:3000'
          : _urlCtrl.text.trim(),
      apiKey: _keyCtrl.text.trim(),
      defaultModel: provider.settings.defaultModel,
      temperature: double.tryParse(_tempCtrl.text.trim()) ?? 0.7,
      enableTools: _enableTools,
      streaming: _streaming,
      systemPrompt: _systemPromptCtrl.text,
      density: provider.settings.density,
    );
    await provider.updateSettings(newSettings);
    setState(() => _dirty = false);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Configurações salvas.'), duration: Duration(seconds: 2)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    return Scaffold(
      backgroundColor: AppTheme.bgBase,
      appBar: AppBar(
        title: const Text('Configurações'),
        actions: [
          TextButton(
            onPressed: _dirty ? _save : null,
            child: Text(
              'Salvar',
              style: TextStyle(
                color: _dirty ? AppTheme.claudeOrange : AppTheme.textMuted,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _SectionTitle('Conexão com o Proxy QwenBridge'),
          TextField(
            controller: _urlCtrl,
            onChanged: (_) => _markDirty(),
            decoration: const InputDecoration(
              labelText: 'URL base do proxy',
              hintText: 'http://10.0.2.2:3000',
              prefixIcon: Icon(Icons.link),
            ),
            keyboardType: TextInputType.url,
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _keyCtrl,
            onChanged: (_) => _markDirty(),
            decoration: const InputDecoration(
              labelText: 'API key (opcional)',
              hintText: 'Bearer token se o proxy exigir',
              prefixIcon: Icon(Icons.key),
            ),
            obscureText: true,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: provider.isConnecting
                      ? null
                      : () async {
                          await _save();
                          await provider.testConnection();
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(
                                  provider.proxyOnline
                                      ? 'Proxy online — ${provider.models.length} modelos, ${provider.accounts.length} conta(s), ${provider.serverTools.length} tool(s).'
                                      : 'Proxy offline: ${provider.connectionError ?? "erro desconhecido"}',
                                ),
                                backgroundColor: provider.proxyOnline
                                    ? AppTheme.statusSuccess
                                    : AppTheme.statusError,
                                duration: const Duration(seconds: 4),
                              ),
                            );
                          }
                        },
                  icon: provider.isConnecting
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.wifi_protected_setup, size: 18),
                  label: const Text('Testar conexão'),
                ),
              ),
            ],
          ),
          if (provider.connectionError != null && !provider.proxyOnline)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                provider.connectionError!,
                style: TextStyle(color: AppTheme.statusError, fontSize: 12),
              ),
            ),
          const SizedBox(height: 24),
          _SectionTitle('Modelo e parâmetros'),
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.memory),
            title: const Text('Modelo padrão'),
            subtitle: Text(
              provider.settings.defaultModel,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _pickModel(context, provider),
          ),
          TextField(
            controller: _tempCtrl,
            onChanged: (_) => _markDirty(),
            decoration: const InputDecoration(
              labelText: 'Temperatura (0.0 — 2.0)',
              prefixIcon: Icon(Icons.thermostat),
            ),
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
          ),
          const SizedBox(height: 12),
          SwitchListTile(
            value: _enableTools,
            onChanged: (v) {
              setState(() => _enableTools = v);
              _markDirty();
            },
            title: const Text('Habilitar tool calls'),
            subtitle: const Text(
              'Permite que o modelo chame ferramentas server-side (calculator, '
              'get_current_time, list_qwen_accounts, http_request, etc).',
            ),
            activeColor: AppTheme.claudeOrange,
          ),
          SwitchListTile(
            value: _streaming,
            onChanged: (v) {
              setState(() => _streaming = v);
              _markDirty();
            },
            title: const Text('Streaming SSE'),
            subtitle: const Text('Receber tokens e tool calls incrementalmente.'),
            activeColor: AppTheme.claudeOrange,
          ),
          const SizedBox(height: 24),
          _SectionTitle('Tools server-side disponíveis'),
          if (provider.serverTools.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                provider.proxyOnline
                    ? 'Nenhuma tool carregada.'
                    : 'Conecte ao proxy para carregar.',
                style: AppTheme.sansTextStyle(color: AppTheme.textMuted, fontSize: 12),
              ),
            )
          else
            ...provider.serverTools.map((t) => ListTile(
                  dense: true,
                  contentPadding: const EdgeInsets.only(left: 4),
                  leading: Icon(Icons.build_circle, size: 18, color: AppTheme.claudeOrange),
                  title: Text(
                    t['name'] as String? ?? '',
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                  ),
                  subtitle: Text(
                    t['description'] as String? ?? '',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: AppTheme.textMuted, fontSize: 11),
                  ),
                )),
          const SizedBox(height: 24),
          _SectionTitle('System prompt'),
          TextField(
            controller: _systemPromptCtrl,
            onChanged: (_) => _markDirty(),
            minLines: 3,
            maxLines: 6,
            decoration: const InputDecoration(
              hintText: 'Você é um assistente útil…',
              alignLabelWithHint: true,
              labelText: 'Prompt de sistema (enviado no início do histórico)',
            ),
          ),
          const SizedBox(height: 24),
          _SectionTitle('Contas Qwen no proxy'),
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 12),
            child: Text(
              'As contas são gerenciadas pelo proxy QwenBridge (SQLite). '
              'As alterações abaixo são enviadas em runtime via /v1/accounts '
              'e refletem imediatamente no proxy. As senhas NÃO ficam no app.',
              style: AppTheme.sansTextStyle(
                color: AppTheme.textSecondary,
                fontSize: 12,
                height: 1.4,
              ),
            ),
          ),
          // Resumo de status
          if (provider.accounts.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  _StatusChip(
                    label: '${provider.accounts.length} conta(s)',
                    color: AppTheme.bgSurfaceAlt,
                  ),
                  const SizedBox(width: 6),
                  _StatusChip(
                    label: '${provider.accounts.where((a) => !a.inCooldown).length} ativa(s)',
                    color: AppTheme.statusSuccess.withOpacity(0.2),
                    textColor: AppTheme.statusSuccess,
                  ),
                  const SizedBox(width: 6),
                  if (provider.accounts.any((a) => a.inCooldown))
                    _StatusChip(
                      label: '${provider.accounts.where((a) => a.inCooldown).length} em cooldown',
                      color: AppTheme.statusWarning.withOpacity(0.2),
                      textColor: AppTheme.statusWarning,
                    ),
                ],
              ),
            ),
          ...provider.accounts.map((a) => _AccountTile(account: a)),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: () => _showAddAccountDialog(context, provider),
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('Adicionar conta'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => _showBatchAddDialog(context, provider),
                  icon: const Icon(Icons.paste, size: 18),
                  label: const Text('Colar em lote'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          _SectionTitle('Sobre'),
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.info_outline),
            title: const Text('QwenCoder v1.0.0'),
            subtitle: Text(
              'Cliente Flutter para o proxy QwenBridge.\n'
              'Fork: github.com/deivid22srk/QwenBridge-Custom-Version\n'
              'Repo: github.com/deivid22srk/QwenCoder',
              style: AppTheme.sansTextStyle(
                color: AppTheme.textSecondary,
                fontSize: 12,
                height: 1.4,
              ),
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  void _pickModel(BuildContext context, ChatProvider provider) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppTheme.bgSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.of(context).size.height * 0.6,
            ),
            child: ListView(
              shrinkWrap: true,
              children: provider.models.isEmpty
                  ? [
                      const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(
                          child: Text('Nenhum modelo carregado. Teste a conexão.'),
                        ),
                      ),
                    ]
                  : provider.models
                      .map((m) => ListTile(
                            leading: Icon(
                              m == provider.settings.defaultModel
                                  ? Icons.check_circle
                                  : Icons.circle_outlined,
                              size: 18,
                              color: m == provider.settings.defaultModel
                                  ? AppTheme.claudeOrange
                                  : AppTheme.textMuted,
                            ),
                            title: Text(
                              m,
                              style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                            ),
                            onTap: () {
                              provider.updateSettings(
                                provider.settings.copyWith(defaultModel: m),
                              );
                              Navigator.of(ctx).pop();
                            },
                          ))
                      .toList(),
            ),
          ),
        );
      },
    );
  }

  void _showAddAccountDialog(BuildContext context, ChatProvider provider) {
    final emailCtrl = TextEditingController();
    final passCtrl = TextEditingController();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.bgSurface,
        title: const Text('Adicionar conta Qwen no proxy'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'As credenciais são enviadas ao proxy e armazenadas lá '
                '(SQLite + Brotli encrypt). O app não guarda a senha.',
                style: AppTheme.sansTextStyle(color: AppTheme.textSecondary, fontSize: 11),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: emailCtrl,
                decoration: const InputDecoration(labelText: 'Email'),
                keyboardType: TextInputType.emailAddress,
              ),
              const SizedBox(height: 10),
              TextField(
                controller: passCtrl,
                decoration: const InputDecoration(labelText: 'Senha'),
                obscureText: true,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancelar'),
          ),
          ElevatedButton(
            onPressed: () async {
              final email = emailCtrl.text.trim();
              final pass = passCtrl.text;
              if (email.isEmpty || pass.isEmpty) return;
              Navigator.of(ctx).pop();
              try {
                final r = await provider.addAccount(email: email, password: pass);
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        r.added > 0
                            ? '✓ Conta adicionada.'
                            : r.skipped > 0
                                ? 'Conta já existe no proxy.'
                                : 'Falha: ${r.results.firstOrNull?.error ?? "erro"}',
                      ),
                      backgroundColor: r.added > 0 ? AppTheme.statusSuccess : AppTheme.statusError,
                    ),
                  );
                }
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Erro: $e'), backgroundColor: AppTheme.statusError),
                  );
                }
              }
            },
            child: const Text('Adicionar'),
          ),
        ],
      ),
    );
  }

  void _showBatchAddDialog(BuildContext context, ChatProvider provider) {
    final ctrl = TextEditingController();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.bgSurface,
        title: const Text('Adicionar contas em lote no proxy'),
        content: SizedBox(
          width: double.maxFinite,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Cole as contas abaixo. Formatos aceitos (misturáveis):',
                style: AppTheme.sansTextStyle(color: AppTheme.textSecondary, fontSize: 12),
              ),
              const SizedBox(height: 6),
              Text(
                '• email:senha por linha\n'
                '• email senha por linha\n'
                '• email\\nsenha (par de linhas)\n'
                '• email:senha;email:senha (estilo .env)',
                style: TextStyle(
                  color: AppTheme.textMuted,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: ctrl,
                maxLines: 10,
                minLines: 6,
                decoration: const InputDecoration(
                  hintText: 'user1@gmail.com:senha1\nuser2@gmail.com:senha2',
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancelar'),
          ),
          ElevatedButton(
            onPressed: () async {
              final wire = ctrl.text.trim();
              if (wire.isEmpty) return;
              Navigator.of(ctx).pop();
              try {
                final r = await provider.addAccountsFromWire(wire);
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        '${r.added} adicionada(s) · ${r.skipped} skip · ${r.failed} falha(s)',
                      ),
                      backgroundColor: r.failed > 0 ? AppTheme.statusWarning : AppTheme.statusSuccess,
                    ),
                  );
                }
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Erro: $e'), backgroundColor: AppTheme.statusError),
                  );
                }
              }
            },
            child: const Text('Importar'),
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String text;
  const _SectionTitle(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 8),
      child: Text(
        text,
        style: AppTheme.sansTextStyle(
          color: AppTheme.claudeOrange,
          fontWeight: FontWeight.w600,
          fontSize: 12,
          letterSpacing: 0.6,
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final String label;
  final Color color;
  final Color? textColor;
  const _StatusChip({required this.label, required this.color, this.textColor});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: AppTheme.sansTextStyle(
          color: textColor ?? AppTheme.textPrimary,
          fontSize: 11,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _AccountTile extends StatelessWidget {
  final QwenAccount account;
  const _AccountTile({required this.account});

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    return Card(
      child: ListTile(
        leading: Icon(
          account.inCooldown ? Icons.timer : Icons.check_circle,
          color: account.inCooldown ? AppTheme.statusWarning : AppTheme.statusSuccess,
          size: 20,
        ),
        title: Text(
          account.email,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
        ),
        subtitle: account.inCooldown
            ? Text(
                'em cooldown · ${account.cooldownReason ?? "—"} · ${_formatRemaining(account.cooldownRemainingMs)}',
                style: TextStyle(color: AppTheme.statusWarning, fontSize: 11),
              )
            : Text(
                'ativa',
                style: TextStyle(color: AppTheme.statusSuccess, fontSize: 11),
              ),
        trailing: PopupMenuButton<String>(
          icon: const Icon(Icons.more_vert, size: 18),
          onSelected: (v) async {
            switch (v) {
              case 'clear_cooldown':
                await provider.clearAccountCooldown(account.id);
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Cooldown limpo.')),
                  );
                }
                break;
              case 'warmup':
                await provider.warmupAccount(account.id);
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Warmup iniciado em background.')),
                  );
                }
                break;
              case 'delete':
                final ok = await provider.removeAccount(account.id);
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(ok ? 'Conta removida.' : 'Falha ao remover.'),
                      backgroundColor: ok ? AppTheme.statusSuccess : AppTheme.statusError,
                    ),
                  );
                }
                break;
            }
          },
          itemBuilder: (ctx) => [
            if (account.inCooldown)
              const PopupMenuItem(
                value: 'clear_cooldown',
                child: Text('Limpar cooldown'),
              ),
            const PopupMenuItem(
              value: 'warmup',
              child: Text('Forçar warmup'),
            ),
            const PopupMenuItem(
              value: 'delete',
              child: Text('Excluir'),
            ),
          ],
        ),
      ),
    );
  }

  String _formatRemaining(int? ms) {
    if (ms == null) return '';
    final sec = (ms / 1000).round();
    if (sec < 60) return '${sec}s';
    final min = sec ~/ 60;
    return '${min}min';
  }
}
