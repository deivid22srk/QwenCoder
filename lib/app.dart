import 'package:flutter/material.dart';
import 'theme/app_theme.dart';
import 'screens/chat_screen.dart';

class QwenCoderApp extends StatelessWidget {
  const QwenCoderApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'QwenCoder',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.darkTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ThemeMode.dark,
      home: const ChatScreen(),
    );
  }
}
