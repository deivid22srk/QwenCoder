import 'package:flutter/foundation.dart';

/// Modelo de uma conta Qwen configurada no app.
/// Cada conta representa credenciais que podem ser usadas pelo proxy
/// QwenBridge (via `QWEN_ACCOUNTS`).
@immutable
class QwenAccount {
  final String id;
  final String email;
  final String password;
  final String? label;
  final bool enabled;
  final DateTime createdAt;

  const QwenAccount({
    required this.id,
    required this.email,
    required this.password,
    this.label,
    this.enabled = true,
    required this.createdAt,
  });

  QwenAccount copyWith({
    String? id,
    String? email,
    String? password,
    String? label,
    bool? enabled,
    DateTime? createdAt,
  }) =>
      QwenAccount(
        id: id ?? this.id,
        email: email ?? this.email,
        password: password ?? this.password,
        label: label ?? this.label,
        enabled: enabled ?? this.enabled,
        createdAt: createdAt ?? this.createdAt,
      );

  /// Representação no formato que o proxy QwenBridge espera em
  /// `QWEN_ACCOUNTS=user1:senha1;user2:senha2`.
  String toWireFormat() => '$email:$password';

  factory QwenAccount.fromJson(Map<String, dynamic> j) => QwenAccount(
        id: j['id'] as String,
        email: j['email'] as String,
        password: j['password'] as String,
        label: j['label'] as String?,
        enabled: (j['enabled'] as bool?) ?? true,
        createdAt: DateTime.tryParse(j['createdAt'] as String? ?? '') ?? DateTime.now(),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'email': email,
        'password': password,
        'label': label,
        'enabled': enabled,
        'createdAt': createdAt.toIso8601String(),
      };
}
