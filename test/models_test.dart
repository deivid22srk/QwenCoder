import 'package:flutter_test/flutter_test.dart';
import 'package:qwencoder/models/chat_message.dart';
import 'package:qwencoder/models/tool_call.dart';
import 'package:qwencoder/models/qwen_account.dart';
import 'package:qwencoder/models/app_settings.dart';
import 'package:qwencoder/services/tool_executor.dart';

void main() {
  group('Models', () {
    test('ChatMessage.user has correct role and content', () {
      final m = ChatMessage.user('hello world');
      expect(m.role, MessageRole.user);
      expect(m.content, 'hello world');
      expect(m.id, isNotEmpty);
    });

    test('ChatMessage.toApiJson for user', () {
      final m = ChatMessage.user('hi');
      final j = m.toApiJson();
      expect(j['role'], 'user');
      expect(j['content'], 'hi');
      expect(j.containsKey('tool_calls'), isFalse);
    });

    test('ChatMessage.toApiJson for tool result', () {
      final m = ChatMessage.tool(
        toolCallId: 'call_123',
        toolName: 'calculator',
        content: '{"result": 42}',
      );
      final j = m.toApiJson();
      expect(j['role'], 'tool');
      expect(j['content'], '{"result": 42}');
      expect(j['tool_call_id'], 'call_123');
    });

    test('ChatMessage.toApiJson for assistant with tool calls', () {
      final m = ChatMessage.assistant(
        content: '',
        toolCalls: [
          ToolCall(id: 'call_1', name: 'get_time', arguments: {}),
        ],
      );
      final j = m.toApiJson();
      expect(j['role'], 'assistant');
      expect(j['tool_calls'], isA<List>());
      expect((j['tool_calls'] as List).length, 1);
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

    test('QwenAccount.toWireFormat produces email:senha', () {
      final a = QwenAccount(
        id: 'acc_1',
        email: 'foo@bar.com',
        password: 'pass123',
        enabled: true,
        createdAt: DateTime(2026, 1, 1),
      );
      expect(a.toWireFormat(), 'foo@bar.com:pass123');
    });

    test('AppSettings defaults are sensible', () {
      const s = AppSettings();
      expect(s.proxyBaseUrl, 'http://10.0.2.2:3000');
      expect(s.streaming, isTrue);
      expect(s.enableTools, isTrue);
      expect(s.temperature, 0.7);
    });
  });

  group('ToolExecutor', () {
    test('calculator computes simple expression', () {
      final r = ToolExecutor.execute('calculator', {'expression': '2+3*4'});
      expect(r.isError, isFalse);
      // result must contain 14 (2+12)
      expect(r.content, contains('14'));
    });

    test('calculator supports parentheses and power', () {
      final r = ToolExecutor.execute('calculator', {'expression': '(2+3)^2'});
      expect(r.isError, isFalse);
      expect(r.content, contains('25'));
    });

    test('calculator supports sqrt', () {
      final r = ToolExecutor.execute('calculator', {'expression': 'sqrt(16)'});
      expect(r.isError, isFalse);
      expect(r.content, contains('4'));
    });

    test('calculator rejects invalid characters', () {
      final r = ToolExecutor.execute('calculator', {'expression': 'print("x")'});
      expect(r.isError, isTrue);
    });

    test('get_current_time returns ISO-8601', () {
      final r = ToolExecutor.execute('get_current_time', {});
      expect(r.isError, isFalse);
      expect(r.content, contains('iso8601'));
    });

    test('random_number respects range', () {
      for (var i = 0; i < 50; i++) {
        final r = ToolExecutor.execute('random_number', {'min': 10, 'max': 20});
        expect(r.isError, isFalse);
        // parse value
        final valueRegex = RegExp(r'"value":\s*(\d+)');
        final m = valueRegex.firstMatch(r.content);
        expect(m, isNotNull);
        final v = int.parse(m!.group(1)!);
        expect(v, greaterThanOrEqualTo(10));
        expect(v, lessThanOrEqualTo(20));
      }
    });

    test('text_transform uppercase', () {
      final r = ToolExecutor.execute('text_transform', {'text': 'hello', 'operation': 'uppercase'});
      expect(r.isError, isFalse);
      expect(r.content, contains('HELLO'));
    });

    test('text_transform base64 round-trip', () {
      final enc = ToolExecutor.execute('text_transform', {'text': 'QwenCoder', 'operation': 'base64_encode'});
      expect(enc.isError, isFalse);
      final encodedRegex = RegExp(r'"output":\s*"([^"]+)"');
      final encoded = encodedRegex.firstMatch(enc.content)!.group(1)!;
      final dec = ToolExecutor.execute('text_transform', {'text': encoded, 'operation': 'base64_decode'});
      expect(dec.isError, isFalse);
      expect(dec.content, contains('QwenCoder'));
    });

    test('device_info returns platform', () {
      final r = ToolExecutor.execute('device_info', {});
      expect(r.isError, isFalse);
      // In test environment platform is one of: linux, macos, windows
      expect(r.content, contains('platform'));
    });

    test('get_weather returns mock data', () {
      final r = ToolExecutor.execute('get_weather', {'city': 'São Paulo'});
      expect(r.isError, isFalse);
      expect(r.content, contains('São Paulo'));
      expect(r.content, contains('temperature_c'));
    });

    test('unknown tool returns error', () {
      final r = ToolExecutor.execute('foobar', {});
      expect(r.isError, isTrue);
    });

    test('allDefinitions returns non-empty list with proper schema', () {
      final defs = ToolExecutor.allDefinitions();
      expect(defs.length, greaterThan(3));
      for (final d in defs) {
        final j = d.toApiJson();
        expect(j['type'], 'function');
        expect((j['function'] as Map)['name'], d.name);
        expect((j['function'] as Map)['parameters'], isNotNull);
      }
    });
  });
}
