import 'package:flutter/foundation.dart';

/// Modelo de uma conta Qwen conforme exposto pelo proxy em `/v1/accounts`.
/// Diferente do modelo local anterior, este NÃO armazena senha — apenas
/// metadados (id, email, status, cooldown) que o proxy retorna.
@immutable
class QwenAccount {
  final String id;
  final String email;
  final bool enabled;
  final int? cooldownUntil;
  final String? cooldownReason;
  final int? cooldownRemainingMs;
  final bool inCooldown;

  const QwenAccount({
    required this.id,
    required this.email,
    this.enabled = true,
    this.cooldownUntil,
    this.cooldownReason,
    this.cooldownRemainingMs,
    this.inCooldown = false,
  });

  factory QwenAccount.fromJson(Map<String, dynamic> j) => QwenAccount(
        id: j['id'] as String,
        email: j['email'] as String,
        enabled: (j['enabled'] as bool?) ?? true,
        cooldownUntil: (j['cooldown_until'] as num?)?.toInt(),
        cooldownReason: j['cooldown_reason'] as String?,
        cooldownRemainingMs: (j['cooldown_remaining_ms'] as num?)?.toInt(),
        inCooldown: (j['in_cooldown'] as bool?) ?? false,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'email': email,
        'enabled': enabled,
        'cooldown_until': cooldownUntil,
        'cooldown_reason': cooldownReason,
        'cooldown_remaining_ms': cooldownRemainingMs,
        'in_cooldown': inCooldown,
      };

  QwenAccount copyWith({
    String? id,
    String? email,
    bool? enabled,
    int? cooldownUntil,
    String? cooldownReason,
    int? cooldownRemainingMs,
    bool? inCooldown,
  }) =>
      QwenAccount(
        id: id ?? this.id,
        email: email ?? this.email,
        enabled: enabled ?? this.enabled,
        cooldownUntil: cooldownUntil ?? this.cooldownUntil,
        cooldownReason: cooldownReason ?? this.cooldownReason,
        cooldownRemainingMs: cooldownRemainingMs ?? this.cooldownRemainingMs,
        inCooldown: inCooldown ?? this.inCooldown,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) || other is QwenAccount && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

/// Snapshot retornado por `GET /v1/accounts`.
class AccountsSnapshot {
  final int total;
  final int active;
  final int inCooldown;
  final List<QwenAccount> accounts;

  const AccountsSnapshot({
    required this.total,
    required this.active,
    required this.inCooldown,
    required this.accounts,
  });

  factory AccountsSnapshot.fromJson(Map<String, dynamic> j) => AccountsSnapshot(
        total: (j['total'] as num?)?.toInt() ?? 0,
        active: (j['active'] as num?)?.toInt() ?? 0,
        inCooldown: (j['in_cooldown'] as num?)?.toInt() ?? 0,
        accounts: ((j['accounts'] as List?) ?? [])
            .map((e) => QwenAccount.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// Resultado de uma operação de add em batch (`POST /v1/accounts`).
class AddAccountsResult {
  final int added;
  final int skipped;
  final int failed;
  final List<AddAccountItemResult> results;

  const AddAccountsResult({
    required this.added,
    required this.skipped,
    required this.failed,
    required this.results,
  });

  factory AddAccountsResult.fromJson(Map<String, dynamic> j) => AddAccountsResult(
        added: (j['added'] as num?)?.toInt() ?? 0,
        skipped: (j['skipped'] as num?)?.toInt() ?? 0,
        failed: (j['failed'] as num?)?.toInt() ?? 0,
        results: ((j['results'] as List?) ?? [])
            .map((e) => AddAccountItemResult.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class AddAccountItemResult {
  final String email;
  final String status; // "ok" | "skip" | "fail"
  final String? id;
  final String? error;

  const AddAccountItemResult({
    required this.email,
    required this.status,
    this.id,
    this.error,
  });

  factory AddAccountItemResult.fromJson(Map<String, dynamic> j) => AddAccountItemResult(
        email: j['email'] as String,
        status: j['status'] as String,
        id: j['id'] as String?,
        error: j['error'] as String?,
      );
}
