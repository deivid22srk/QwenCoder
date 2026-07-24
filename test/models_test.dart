import 'package:flutter_test/flutter_test.dart';
import 'package:qwencoder/models/chat_message.dart';
import 'package:qwencoder/models/tool_call.dart';
import 'package:qwencoder/models/qwen_account.dart';
import 'package:qwencoder/models/app_settings.dart';
import 'package:qwencoder/models/streaming_tool_call.dart';

void main() {
  group('Models', () {
    test('ChatMessage.user has correct role and content', () {
      final m = ChatMessage.user('hello world');
      expect(m.role, MessageRole.user);
      expect(m.content, 'hello world');
      expect(m.id, isNotEmpty);
    });

    test('ChatMessage.toApiJson for user — sem tool_calls (proxy gerencia server-side)', () {
      final m = ChatMessage.user('hi');
      final j = m.toApiJson();
      expect(j['role'], 'user');
      expect(j['content'], 'hi');
      expect(j.containsKey('tool_calls'), isFalse);
    });

    test('ChatMessage.assistant com streamingToolCalls', () {
      final m = ChatMessage.assistant(content: 'hello')
          .copyWith(
            streamingToolCalls: [
              const StreamingToolCall(
                id: 'tc1',
                name: 'calculator',
                status: ToolCallStatus.completed,
                durationMs: 42,
              ),
            ],
          );
      expect(m.streamingToolCalls.length, 1);
      expect(m.streamingToolCalls.first.name, 'calculator');
      expect(m.streamingToolCalls.first.status, ToolCallStatus.completed);
    });

    test('ToolCall.fromJson parses OpenAI format', () {
      final j = {
        'id': 'call_abc',
        'type': 'function',
        'function': {
          'name': 'calculator',
          'arguments': '{"expression": "2+2"}',
        },
      };
      final tc = ToolCall.fromJson(j);
      expect(tc.id, 'call_abc');
      expect(tc.name, 'calculator');
      expect(tc.arguments['expression'], '2+2');
    });

    test('QwenAccount.fromJson parseia campos do proxy', () {
      final j = {
        'id': 'acc1',
        'email': 'foo@bar.com',
        'enabled': true,
        'cooldown_until': 1700000000000,
        'cooldown_reason': 'quota_exceeded',
        'cooldown_remaining_ms': 60000,
        'in_cooldown': true,
      };
      final a = QwenAccount.fromJson(j);
      expect(a.id, 'acc1');
      expect(a.email, 'foo@bar.com');
      expect(a.inCooldown, isTrue);
      expect(a.cooldownRemainingMs, 60000);
      expect(a.cooldownReason, 'quota_exceeded');
    });

    test('AccountsSnapshot.fromJson parseia lista', () {
      final j = {
        'total': 2,
        'active': 1,
        'in_cooldown': 1,
        'accounts': [
          {'id': 'a1', 'email': 'u1@x.com', 'in_cooldown': false},
          {'id': 'a2', 'email': 'u2@x.com', 'in_cooldown': true, 'cooldown_until': 1},
        ],
      };
      final snap = AccountsSnapshot.fromJson(j);
      expect(snap.total, 2);
      expect(snap.active, 1);
      expect(snap.inCooldown, 1);
      expect(snap.accounts.length, 2);
    });

    test('AddAccountsResult.fromJson parseia resultado de batch', () {
      final j = {
        'added': 2,
        'skipped': 1,
        'failed': 0,
        'results': [
          {'email': 'a@x.com', 'status': 'ok', 'id': '1'},
          {'email': 'b@x.com', 'status': 'ok', 'id': '2'},
          {'email': 'c@x.com', 'status': 'skip', 'error': 'already exists'},
        ],
      };
      final r = AddAccountsResult.fromJson(j);
      expect(r.added, 2);
      expect(r.skipped, 1);
      expect(r.failed, 0);
      expect(r.results.length, 3);
      expect(r.results.first.status, 'ok');
      expect(r.results.last.status, 'skip');
    });

    test('StreamingToolCall copyWith preserva imutabilidade', () {
      const tc = StreamingToolCall(id: 'tc1', name: 'calc');
      final tc2 = tc.copyWith(
        status: ToolCallStatus.executing,
        argsBuffer: '{"expr":"1+1"}',
      );
      expect(tc.status, ToolCallStatus.receivingArgs); // original intacto
      expect(tc2.status, ToolCallStatus.executing);
      expect(tc2.argsBuffer, '{"expr":"1+1"}');
    });

    test('AppSettings defaults são sensatos', () {
      const s = AppSettings();
      expect(s.proxyBaseUrl, 'http://10.0.2.2:3000');
      expect(s.streaming, isTrue);
      expect(s.enableTools, isTrue);
      expect(s.temperature, 0.7);
    });
  });
}
