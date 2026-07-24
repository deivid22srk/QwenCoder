import 'dart:convert';
import 'package:flutter/foundation.dart';

/// Papel de uma mensagem no histórico.
enum MessageRole {
  system,
  user,
  assistant,
  tool;

  String get wire => name;

  static MessageRole fromWire(String s) {
    switch (s.toLowerCase()) {
      case 'system':
        return MessageRole.system;
      case 'user':
        return MessageRole.user;
      case 'assistant':
        return MessageRole.assistant;
      case 'tool':
      case 'function':
        return MessageRole.tool;
      default:
        return MessageRole.user;
    }
  }
}

/// Uma chamada de ferramenta solicitada pelo modelo.
@immutable
class ToolCall {
  final String id;
  final String name;
  final Map<String, dynamic> arguments;

  const ToolCall({
    required this.id,
    required this.name,
    required this.arguments,
  });

  factory ToolCall.fromJson(Map<String, dynamic> j) => ToolCall(
        id: j['id'] as String? ?? '',
        name: (j['function']?['name'] ?? j['name'] ?? '') as String,
        arguments: _parseArgs(j['function']?['arguments'] ?? j['arguments'] ?? '{}'),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'type': 'function',
        'function': {
          'name': name,
          'arguments': arguments,
        },
      };

  static Map<String, dynamic> _parseArgs(dynamic raw) {
    if (raw is Map) return Map<String, dynamic>.from(raw);
    if (raw is String) {
      try {
        final decoded = _decodeJsonLoose(raw);
        if (decoded is Map) return Map<String, dynamic>.from(decoded);
      } catch (_) {}
    }
    return {};
  }

  /// Parser JSON tolerante (espelha o parser loose do QwenBridge).
  static dynamic _decodeJsonLoose(String s) {
    var sanitized = s.trim();
    if (sanitized.isEmpty) return <String, dynamic>{};
    try {
      return jsonDecode(sanitized);
    } catch (_) {}
    sanitized = sanitized.replaceAll(RegExp(r',\s*([}\]])'), r'$1');
    try {
      return jsonDecode(sanitized);
    } catch (_) {}
    sanitized = sanitized.replaceAll("'", '"');
    try {
      return jsonDecode(sanitized);
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ToolCall &&
          other.id == id &&
          other.name == name &&
          mapEquals(other.arguments, arguments);

  @override
  int get hashCode => Object.hash(id, name, arguments);

  @override
  String toString() => 'ToolCall($name, $arguments)';
}

bool mapEquals(Map a, Map b) {
  if (a.length != b.length) return false;
  for (final key in a.keys) {
    if (!b.containsKey(key)) return false;
    final av = a[key];
    final bv = b[key];
    if (av is Map && bv is Map) {
      if (!mapEquals(av, bv)) return false;
    } else if (av is List && bv is List) {
      if (av.length != bv.length) return false;
      for (var i = 0; i < av.length; i++) {
        if (av[i] is Map && bv[i] is Map) {
          if (!mapEquals(av[i] as Map, bv[i] as Map)) return false;
        } else if (av[i] != bv[i]) {
          return false;
        }
      }
    } else if (av != bv) {
      return false;
    }
  }
  return true;
}
