import 'dart:convert';
import 'dart:math';
import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:intl/intl.dart';

/// Definição de uma ferramenta exposta ao modelo (formato OpenAI function calling).
class ToolDefinition {
  final String name;
  final String description;
  final Map<String, dynamic> parametersSchema;

  const ToolDefinition({
    required this.name,
    required this.description,
    required this.parametersSchema,
  });

  Map<String, dynamic> toApiJson() => {
        'type': 'function',
        'function': {
          'name': name,
          'description': description,
          'parameters': parametersSchema,
        },
      };
}

/// Resultado da execução de uma ferramenta.
class ToolResult {
  final String name;
  final String content;
  final bool isError;
  final Map<String, dynamic> meta;

  const ToolResult({
    required this.name,
    required this.content,
    this.isError = false,
    this.meta = const {},
  });
}

/// Executor de ferramentas locais.
/// Implementa ferramentas padrão que o modelo pode chamar no device:
/// - get_current_time
/// - calculator
/// - random_number
/// - text_transform
/// - device_info
/// - get_weather (mock — sem chamada externa por padrão)
class ToolExecutor {
  /// Lista todas as ferramentas disponíveis para enviar ao modelo.
  static List<ToolDefinition> allDefinitions() => const [
        ToolDefinition(
          name: 'get_current_time',
          description:
              'Retorna a data e hora atuais no device do usuário, em ISO-8601 e em formato amigável. Use para qualquer pergunta sobre "que horas são" ou "que dia é hoje".',
          parametersSchema: {
            'type': 'object',
            'properties': {
              'timezone': {
                'type': 'string',
                'description': 'Timezone opcional (ex: America/Sao_Paulo). Se omitido, usa o timezone local do device.',
              },
            },
          },
        ),
        ToolDefinition(
          name: 'calculator',
          description:
              'Avalia uma expressão matemática simples (4 operações, parênteses, potência com ^, funções sqrt, sin, cos, tan, log, ln, abs). Use sempre que precisar de cálculo exato em vez de estimar.',
          parametersSchema: {
            'type': 'object',
            'properties': {
              'expression': {
                'type': 'string',
                'description': 'Expressão matemática, ex: "2*(3+4)^2 - sqrt(16)"',
              },
            },
            'required': ['expression'],
          },
        ),
        ToolDefinition(
          name: 'random_number',
          description: 'Gera um número inteiro aleatório no intervalo [min, max] (inclusivos).',
          parametersSchema: {
            'type': 'object',
            'properties': {
              'min': {'type': 'integer', 'default': 0},
              'max': {'type': 'integer', 'default': 100},
            },
          },
        ),
        ToolDefinition(
          name: 'text_transform',
          description:
              'Transforma um texto: uppercase, lowercase, titlecase, reverse, base64_encode, base64_decode, length, word_count.',
          parametersSchema: {
            'type': 'object',
            'properties': {
              'text': {'type': 'string'},
              'operation': {
                'type': 'string',
                'enum': ['uppercase', 'lowercase', 'titlecase', 'reverse', 'base64_encode', 'base64_decode', 'length', 'word_count'],
              },
            },
            'required': ['text', 'operation'],
          },
        ),
        ToolDefinition(
          name: 'device_info',
          description: 'Retorna informações do device em uso (plataforma, locale, etc). Não expõe dados pessoais.',
          parametersSchema: {'type': 'object', 'properties': {}},
        ),
        ToolDefinition(
          name: 'get_weather',
          description:
              'Retorna uma estimativa de clima mockada para uma cidade. Não faz chamada de rede — use apenas para demonstração. Em produção, pode ser substituída por uma API real.',
          parametersSchema: {
            'type': 'object',
            'properties': {
              'city': {'type': 'string'},
            },
            'required': ['city'],
          },
        ),
      ];

  /// Executa uma ferramenta pelo nome com os argumentos fornecidos.
  static ToolResult execute(String name, Map<String, dynamic> args) {
    try {
      switch (name) {
        case 'get_current_time':
          return _getCurrentTime(args);
        case 'calculator':
          return _calculator(args);
        case 'random_number':
          return _randomNumber(args);
        case 'text_transform':
          return _textTransform(args);
        case 'device_info':
          return _deviceInfo(args);
        case 'get_weather':
          return _getWeather(args);
        default:
          return ToolResult(
            name: name,
            content: jsonEncode({'error': 'Tool "$name" not found'}),
            isError: true,
          );
      }
    } catch (e, st) {
      return ToolResult(
        name: name,
        content: jsonEncode({'error': e.toString(), 'stack': st.toString().split('\n').take(3).join(' | ')}),
        isError: true,
      );
    }
  }

  static ToolResult _getCurrentTime(Map<String, dynamic> args) {
    final now = DateTime.now();
    final friendly = DateFormat('dd/MM/yyyy HH:mm:ss').format(now);
    final weekday = DateFormat('EEEE', 'pt_BR').format(now);
    return ToolResult(
      name: 'get_current_time',
      content: jsonEncode({
        'iso8601': now.toUtc().toIso8601String(),
        'local_friendly': friendly,
        'weekday': weekday,
        'timezone_offset_minutes': now.timeZoneOffset.inMinutes,
      }),
    );
  }

  static ToolResult _calculator(Map<String, dynamic> args) {
    final expr = (args['expression'] as String?)?.trim() ?? '';
    if (expr.isEmpty) {
      return const ToolResult(
        name: 'calculator',
        content: '{"error":"expression is required"}',
        isError: true,
      );
    }
    final allowed = RegExp(r'^[\d\s+\-*/().^,_a-zA-Z]+$');
    if (!allowed.hasMatch(expr)) {
      return ToolResult(
        name: 'calculator',
        content: jsonEncode({'error': 'invalid characters in expression'}),
        isError: true,
      );
    }
    try {
      final result = _evalMath(expr);
      return ToolResult(
        name: 'calculator',
        content: jsonEncode({'expression': expr, 'result': result}),
      );
    } catch (e) {
      return ToolResult(
        name: 'calculator',
        content: jsonEncode({'error': e.toString()}),
        isError: true,
      );
    }
  }

  static ToolResult _randomNumber(Map<String, dynamic> args) {
    final min = (args['min'] as num?)?.toInt() ?? 0;
    final max = (args['max'] as num?)?.toInt() ?? 100;
    if (min > max) {
      return ToolResult(
        name: 'random_number',
        content: jsonEncode({'error': 'min > max'}),
        isError: true,
      );
    }
    final rng = Random();
    final value = min + rng.nextInt(max - min + 1);
    return ToolResult(
      name: 'random_number',
      content: jsonEncode({'min': min, 'max': max, 'value': value}),
    );
  }

  static ToolResult _textTransform(Map<String, dynamic> args) {
    final text = (args['text'] as String?) ?? '';
    final op = (args['operation'] as String?) ?? 'uppercase';
    String out;
    switch (op) {
      case 'uppercase':
        out = text.toUpperCase();
        break;
      case 'lowercase':
        out = text.toLowerCase();
        break;
      case 'titlecase':
        out = text.split(' ').map((w) {
          if (w.isEmpty) return w;
          return w[0].toUpperCase() + w.substring(1).toLowerCase();
        }).join(' ');
        break;
      case 'reverse':
        out = text.split('').reversed.join('');
        break;
      case 'base64_encode':
        out = base64Encode(utf8.encode(text));
        break;
      case 'base64_decode':
        out = utf8.decode(base64Decode(text), allowMalformed: true);
        break;
      case 'length':
        out = text.length.toString();
        break;
      case 'word_count':
        out = text.split(RegExp(r'\s+')).where((s) => s.isNotEmpty).length.toString();
        break;
      default:
        out = 'unknown operation: $op';
    }
    return ToolResult(
      name: 'text_transform',
      content: jsonEncode({'operation': op, 'input': text, 'output': out}),
    );
  }

  static ToolResult _deviceInfo(Map<String, dynamic> args) {
    String platform;
    if (kIsWeb) {
      platform = 'web';
    } else if (Platform.isAndroid) {
      platform = 'android';
    } else if (Platform.isIOS) {
      platform = 'ios';
    } else if (Platform.isLinux) {
      platform = 'linux';
    } else if (Platform.isMacOS) {
      platform = 'macos';
    } else if (Platform.isWindows) {
      platform = 'windows';
    } else {
      platform = 'unknown';
    }
    return ToolResult(
      name: 'device_info',
      content: jsonEncode({
        'platform': platform,
        'locale': Intl.getCurrentLocale(),
        'is_web': kIsWeb,
      }),
    );
  }

  static ToolResult _getWeather(Map<String, dynamic> args) {
    final city = (args['city'] as String?) ?? 'unknown';
    final rng = Random(city.toLowerCase().hashCode.abs());
    final conditions = ['Ensolarado', 'Parcialmente nublado', 'Nublado', 'Chuvoso', 'Tempestade', 'Neblina'];
    final temp = 15 + rng.nextInt(20);
    final cond = conditions[rng.nextInt(conditions.length)];
    return ToolResult(
      name: 'get_weather',
      content: jsonEncode({
        'city': city,
        'temperature_c': temp,
        'condition': cond,
        'humidity_pct': 40 + rng.nextInt(50),
        'note': 'Mock data — não chama serviço externo. Substitua por API real em produção.',
      }),
    );
  }

  /// Avaliador matemático seguro (parser de precedência, sem dart:mirrors/eval).
  /// Suporta: + - * / ^ ( ) e funções sqrt, sin, cos, tan, log, ln, abs, pi, e.
  static double _evalMath(String expr) {
    final normalized = expr.replaceAll('^', '**').replaceAll(',', '.');
    final tokens = _tokenize(normalized);
    final parser = _MathParser(tokens);
    final value = parser.parseExpression();
    if (!parser.atEnd) throw FormatError('Unexpected token at ${parser.pos}');
    return value;
  }

  static List<_Token> _tokenize(String s) {
    final tokens = <_Token>[];
    final numberRe = RegExp(r'\d+(\.\d+)?');
    final identRe = RegExp(r'[a-zA-Z_]+');
    var i = 0;
    while (i < s.length) {
      final c = s[i];
      if (c == ' ' || c == '\t') {
        i++;
        continue;
      }
      if ('+-*/()'.contains(c)) {
        tokens.add(_Token(_TokType.op, c));
        i++;
      } else if (c == '*' && i + 1 < s.length && s[i + 1] == '*') {
        tokens.add(_Token(_TokType.op, '^'));
        i += 2;
      } else if (numberRe.hasMatch(s.substring(i))) {
        final m = numberRe.firstMatch(s.substring(i))!;
        tokens.add(_Token(_TokType.number, m[0]!));
        i += m[0]!.length;
      } else if (identRe.hasMatch(s.substring(i))) {
        final m = identRe.firstMatch(s.substring(i))!;
        tokens.add(_Token(_TokType.ident, m[0]!));
        i += m[0]!.length;
      } else {
        throw FormatError('Invalid char "$c" at $i');
      }
    }
    return tokens;
  }
}

enum _TokType { number, ident, op }

class _Token {
  final _TokType type;
  final String value;
  const _Token(this.type, this.value);
}

class _MathParser {
  final List<_Token> tokens;
  int pos = 0;
  _MathParser(this.tokens);

  bool get atEnd => pos >= tokens.length;
  _Token? get peek => atEnd ? null : tokens[pos];

  double parseExpression() {
    var v = parseTerm();
    while (peek?.type == _TokType.op && (peek!.value == '+' || peek!.value == '-')) {
      final op = tokens[pos++].value;
      final r = parseTerm();
      v = op == '+' ? v + r : v - r;
    }
    return v;
  }

  double parseTerm() {
    var v = parseFactor();
    while (peek?.type == _TokType.op && (peek!.value == '*' || peek!.value == '/')) {
      final op = tokens[pos++].value;
      final r = parseFactor();
      v = op == '*' ? v * r : v / r;
    }
    return v;
  }

  double parseFactor() {
    var v = parseUnary();
    while (peek?.type == _TokType.op && peek!.value == '^') {
      pos++;
      final r = parseUnary();
      v = pow(v, r).toDouble();
    }
    return v;
  }

  double parseUnary() {
    if (peek?.type == _TokType.op && peek!.value == '-') {
      pos++;
      return -parseUnary();
    }
    if (peek?.type == _TokType.op && peek!.value == '+') {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  }

  double parsePrimary() {
    final t = peek;
    if (t == null) throw FormatError('Unexpected end');
    if (t.type == _TokType.number) {
      pos++;
      return double.parse(t.value);
    }
    if (t.type == _TokType.op && t.value == '(') {
      pos++;
      final v = parseExpression();
      if (peek?.value != ')') throw FormatError('Expected )');
      pos++;
      return v;
    }
    if (t.type == _TokType.ident) {
      pos++;
      if (peek?.value == '(') {
        pos++;
        final arg = parseExpression();
        if (peek?.value != ')') throw FormatError('Expected ) after function arg');
        pos++;
        return _applyFunction(t.value, arg);
      }
      switch (t.value) {
        case 'pi':
          return pi;
        case 'e':
          return e;
        default:
          throw FormatError('Unknown identifier ${t.value}');
      }
    }
    throw FormatError('Unexpected token ${t.value}');
  }

  double _applyFunction(String name, double arg) {
    switch (name) {
      case 'sqrt':
        return sqrt(arg);
      case 'sin':
        return sin(arg);
      case 'cos':
        return cos(arg);
      case 'tan':
        return tan(arg);
      case 'log':
        return log(arg) / ln10;
      case 'ln':
        return log(arg);
      case 'abs':
        return arg.abs();
      default:
        throw FormatError('Unknown function $name');
    }
  }
}

class FormatError implements Exception {
  final String message;
  FormatError(this.message);
  @override
  String toString() => 'FormatError: $message';
}
