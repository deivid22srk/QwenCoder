import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'services/chat_provider.dart';
import 'theme/app_theme.dart';
import 'app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ChatProvider()),
      ],
      child: const QwenCoderApp(),
    ),
  );
}
