import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../models/app_settings.dart';
import '../models/qwen_account.dart';
import '../services/chat_provider.dart';
import '../theme/app_theme.dart';

/// Tela de configurações:
/// - Conexão com o proxy (URL + API key)
/// - Modelo padrão e parâmetros
/// - System prompt customizado
/// - Habilitar/desabilitar tools
/// - Gerenciar contas Qwen (adicionar, editar, remover)
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
                                      ? 'Proxy online — ${provider.models.length} modelos disponíveis.'
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
          const SizedBox(height: 8),
          if (provider.connectionError != null && !provider.proxyOnline)
            Padding(
              padding: const EdgeInsets.only(top: 4),
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
              'Permite que o modelo chame ferramentas locais (calculator, get_current_time, etc).',
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
            subtitle: const Text('Receber tokens incrementalmente.'),
            activeColor: AppTheme.claudeOrange,
          ),
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
          _SectionTitle('Contas Qwen'),
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 12),
            child: Text(
              'Contas usadas pelo proxy QwenBridge para autenticar no chat.qwen.ai. '
              'As credenciais ficam salvas apenas no device.',
              style: AppTheme.sansTextStyle(color: AppTheme.textSecondary,
                fontSize: 12,
                height: 1.4),
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
          const SizedBox(height: 12),
          if (provider.accounts.isNotEmpty)
            OutlinedButton.icon(
              onPressed: () => _showWireStringDialog(context, provider),
              icon: const Icon(Icons.copy, size: 18),
              label: const Text('Copiar QWEN_ACCOUNTS para .env do proxy'),
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
              'Fork: github.com/deivid22srk/QwenBridge-Custom-Version',
              style: AppTheme.sansTextStyle(color: AppTheme.textSecondary,
                fontSize: 12,
                height: 1.4),
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
    final labelCtrl = TextEditingController();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.bgSurface,
        title: const Text('Adicionar conta Qwen'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
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
              const SizedBox(height: 10),
              TextField(
                controller: labelCtrl,
                decoration: const InputDecoration(
                  labelText: 'Rótulo (opcional)',
                  hintText: 'ex: conta pessoal',
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
            onPressed: () {
              final email = emailCtrl.text.trim();
              final pass = passCtrl.text;
              if (email.isEmpty || pass.isEmpty) return;
              final acc = QwenAccount(
                id: 'acc_${DateTime.now().microsecondsSinceEpoch}',
                email: email,
                password: pass,
                label: labelCtrl.text.trim().isEmpty ? null : labelCtrl.text.trim(),
                enabled: true,
                createdAt: DateTime.now(),
              );
              provider.addAccount(acc);
              Navigator.of(ctx).pop();
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
        title: const Text('Adicionar contas em lote'),
        content: SizedBox(
          width: double.maxFinite,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Cole as contas abaixo. Formatos aceitos (misturáveis):',
                style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
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
            onPressed: () {
              final parsed = _parseBatch(ctrl.text);
              for (final p in parsed) {
                provider.addAccount(QwenAccount(
                  id: 'acc_${DateTime.now().microsecondsSinceEpoch}_${p.email.hashCode.abs()}',
                  email: p.email,
                  password: p.password,
                  enabled: true,
                  createdAt: DateTime.now(),
                ));
              }
              Navigator.of(ctx).pop();
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text('${parsed.length} conta(s) adicionada(s).')),
              );
            },
            child: const Text('Importar'),
          ),
        ],
      ),
    );
  }

  void _showWireStringDialog(BuildContext context, ChatProvider provider) {
    final wire = provider.buildWireString();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.bgSurface,
        title: const Text('QWEN_ACCOUNTS'),
        content: SizedBox(
          width: double.maxFinite,
          child: SelectableText(
            wire,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Fechar'),
          ),
          ElevatedButton.icon(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: wire));
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Copiado para a área de transferência.')),
                );
              }
              Navigator.of(ctx).pop();
            },
            icon: const Icon(Icons.copy, size: 18),
            label: const Text('Copiar'),
          ),
        ],
      ),
    );
  }

  /// Parser de lote — espelha os 4 formatos suportados pelo QwenBridge.
  List<_ParsedAccount> _parseBatch(String raw) {
    final result = <_ParsedAccount>[];
    final seen = <String>{};
    final lines = raw.split(RegExp(r'\r?\n'));
    // Formato .env em uma única linha
    if (lines.length == 1 && lines.first.contains(';')) {
      for (final part in lines.first.split(';')) {
        final p = _parseSingle(part);
        if (p != null && seen.add(p.email)) result.add(p);
      }
      return result;
    }
    // Demais formatos (linha a linha, ou par de linhas)
    for (var i = 0; i < lines.length; i++) {
      final line = lines[i].trim();
      if (line.isEmpty || line.startsWith('#')) continue;
      // Tenta email:senha
      var p = _parseSingle(line);
      if (p != null) {
        if (seen.add(p.email)) result.add(p);
        continue;
      }
      // Tenta "email senha"
      final sp = line.split(RegExp(r'\s+'));
      if (sp.length >= 2 && sp[0].contains('@')) {
        final email = sp[0];
        final pass = sp.sublist(1).join(' ');
        if (seen.add(email)) result.add(_ParsedAccount(email, pass));
        continue;
      }
      // Tenta par de linhas (email na atual, senha na próxima)
      if (line.contains('@') && i + 1 < lines.length) {
        final next = lines[i + 1].trim();
        if (next.isNotEmpty && !next.contains('@')) {
          if (seen.add(line)) result.add(_ParsedAccount(line, next));
          i++; // pula a próxima
        }
      }
    }
    return result;
  }

  _ParsedAccount? _parseSingle(String s) {
    final t = s.trim();
    if (t.isEmpty) return null;
    final idx = t.indexOf(':');
    if (idx <= 0) return null;
    final email = t.substring(0, idx).trim();
    final pass = t.substring(idx + 1).trim();
    if (!email.contains('@') || pass.isEmpty) return null;
    return _ParsedAccount(email, pass);
  }
}

class _ParsedAccount {
  final String email;
  final String password;
  _ParsedAccount(this.email, this.password);
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
        style: AppTheme.sansTextStyle(color: AppTheme.claudeOrange,
          fontWeight: FontWeight.w600,
          fontSize: 12,
          letterSpacing: 0.6),
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
          account.enabled ? Icons.check_circle : Icons.cancel,
          color: account.enabled ? AppTheme.statusSuccess : AppTheme.textMuted,
          size: 20,
        ),
        title: Text(
          account.email,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
        ),
        subtitle: Text(
          [
            if (account.label != null) account.label!,
            'adicionada em ${account.createdAt.day.toString().padLeft(2, '0')}/${account.createdAt.month.toString().padLeft(2, '0')}/${account.createdAt.year}',
          ].join(' • '),
          style: TextStyle(color: AppTheme.textMuted, fontSize: 11),
        ),
        trailing: PopupMenuButton<String>(
          icon: const Icon(Icons.more_vert, size: 18),
          onSelected: (v) {
            if (v == 'toggle') {
              provider.updateAccount(account.copyWith(enabled: !account.enabled));
            } else if (v == 'delete') {
              provider.removeAccount(account.id);
            }
          },
          itemBuilder: (ctx) => [
            PopupMenuItem(
              value: 'toggle',
              child: Text(account.enabled ? 'Desativar' : 'Ativar'),
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
}
