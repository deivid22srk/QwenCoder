/// Configurações de runtime que o app persiste entre sessões.
class AppSettings {
  /// URL base do proxy QwenBridge. Ex: `http://10.0.2.2:3000` (emulador)
  /// ou `http://192.168.0.10:3000` (device físico).
  final String proxyBaseUrl;

  /// API key opcional usada no header `Authorization: Bearer ...`
  /// caso o proxy tenha `API_KEY` configurado.
  final String apiKey;

  /// Modelo padrão selecionado.
  final String defaultModel;

  /// Temperatura padrão.
  final double temperature;

  /// Habilitar tool calls nas requisições.
  final bool enableTools;

  /// Habilitar streaming SSE.
  final bool streaming;

  /// System prompt opcional enviado no início do histórico.
  final String systemPrompt;

  /// Density: 0 = compacto, 1 = confortável (default).
  final int density;

  const AppSettings({
    this.proxyBaseUrl = 'http://10.0.2.2:3000',
    this.apiKey = '',
    this.defaultModel = 'qwen3-coder-plus',
    this.temperature = 0.7,
    this.enableTools = true,
    this.streaming = true,
    this.systemPrompt = '',
    this.density = 1,
  });

  AppSettings copyWith({
    String? proxyBaseUrl,
    String? apiKey,
    String? defaultModel,
    double? temperature,
    bool? enableTools,
    bool? streaming,
    String? systemPrompt,
    int? density,
  }) =>
      AppSettings(
        proxyBaseUrl: proxyBaseUrl ?? this.proxyBaseUrl,
        apiKey: apiKey ?? this.apiKey,
        defaultModel: defaultModel ?? this.defaultModel,
        temperature: temperature ?? this.temperature,
        enableTools: enableTools ?? this.enableTools,
        streaming: streaming ?? this.streaming,
        systemPrompt: systemPrompt ?? this.systemPrompt,
        density: density ?? this.density,
      );

  factory AppSettings.fromJson(Map<String, dynamic> j) => AppSettings(
        proxyBaseUrl: j['proxyBaseUrl'] as String? ?? 'http://10.0.2.2:3000',
        apiKey: j['apiKey'] as String? ?? '',
        defaultModel: j['defaultModel'] as String? ?? 'qwen3-coder-plus',
        temperature: (j['temperature'] as num?)?.toDouble() ?? 0.7,
        enableTools: (j['enableTools'] as bool?) ?? true,
        streaming: (j['streaming'] as bool?) ?? true,
        systemPrompt: j['systemPrompt'] as String? ?? '',
        density: (j['density'] as int?) ?? 1,
      );

  Map<String, dynamic> toJson() => {
        'proxyBaseUrl': proxyBaseUrl,
        'apiKey': apiKey,
        'defaultModel': defaultModel,
        'temperature': temperature,
        'enableTools': enableTools,
        'streaming': streaming,
        'systemPrompt': systemPrompt,
        'density': density,
      };
}
