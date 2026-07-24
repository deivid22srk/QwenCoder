import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/app_settings.dart';
import '../models/qwen_account.dart';

/// Persistência local de configurações e contas Qwen.
/// Usa SharedPreferences para simplicidade — os dados ficam no sandbox do app.
class StorageService {
  static const _kSettings = 'qwencoder.settings.v1';
  static const _kAccounts = 'qwencoder.accounts.v1';

  static Future<AppSettings> loadSettings() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kSettings);
    if (raw == null) return const AppSettings();
    try {
      return AppSettings.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return const AppSettings();
    }
  }

  static Future<void> saveSettings(AppSettings s) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kSettings, jsonEncode(s.toJson()));
  }

  static Future<List<QwenAccount>> loadAccounts() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kAccounts);
    if (raw == null) return const [];
    try {
      final list = jsonDecode(raw) as List;
      return list
          .map((e) => QwenAccount.fromJson(e as Map<String, dynamic>))
          .toList(growable: true);
    } catch (_) {
      return const [];
    }
  }

  static Future<void> saveAccounts(List<QwenAccount> accounts) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(
      _kAccounts,
      jsonEncode(accounts.map((a) => a.toJson()).toList()),
    );
  }

  /// Limpa todas as credenciais — usado pelo botão "limpar tudo".
  static Future<void> clearAll() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kAccounts);
    await sp.remove(_kSettings);
  }
}
