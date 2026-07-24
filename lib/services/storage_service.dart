import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/app_settings.dart';

/// Persistência local de configurações do app.
///
/// IMPORTANTE: as contas Qwen não são mais persistidas localmente —
/// elas vivem no banco SQLite do proxy QwenBridge. O app apenas consulta
/// via `/v1/accounts` e recebe updates em tempo real via `/v1/accounts/stream`.
class StorageService {
  static const _kSettings = 'qwencoder.settings.v1';

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

  /// Limpa todas as configurações locais. Não afeta as contas no proxy.
  static Future<void> clearAll() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kSettings);
  }
}
