import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Tema do QwenCoder inspirado no visual do Claude (dark mode).
/// Cores principais:
///   - Background:        #0b0b0b (bg-bg-100)
///   - Surface:           #1e1e1e (bg-bg-300)
///   - Accent terracotta: #d97757 (Claude Orange)
///   - Text primary:      #f5f5f4
///   - Text secondary:    #a8a29e
class AppTheme {
  AppTheme._();

  // Brand colors
  static const Color claudeOrange = Color(0xFFD97757);
  static const Color claudeOrangeDark = Color(0xFFB45A3C);
  static const Color claudeOrangeLight = Color(0xFFE59076);

  // Backgrounds
  static const Color bgBase = Color(0xFF0b0b0b);
  static const Color bgSurface = Color(0xFF1e1e1e);
  static const Color bgSurfaceAlt = Color(0xFF262626);
  static const Color bgBubble = Color(0xFF2a2a2a);
  static const Color bgUserBubble = Color(0xFF323232);

  // Text
  static const Color textPrimary = Color(0xFFf5f5f4);
  static const Color textSecondary = Color(0xFFa8a29e);
  static const Color textMuted = Color(0xFF737373);
  static const Color textAccent = claudeOrange;

  // Borders / dividers
  static const Color borderSubtle = Color(0xFF2e2e2e);
  static const Color borderDefault = Color(0xFF3a3a3a);

  // Status
  static const Color statusSuccess = Color(0xFF10b981);
  static const Color statusError = Color(0xFFef4444);
  static const Color statusWarning = Color(0xFFf59e0b);

  /// Retorna o TextTheme sans (Inter) configurado com a paleta do app.
  static TextTheme _sansTextTheme(Brightness brightness) {
    final base = GoogleFonts.interTextTheme(
      brightness == Brightness.dark ? ThemeData.dark().textTheme : ThemeData.light().textTheme,
    );
    return base.copyWith(
      displayLarge: base.displayLarge?.copyWith(color: textPrimary),
      displayMedium: base.displayMedium?.copyWith(color: textPrimary),
      headlineMedium: base.headlineMedium?.copyWith(color: textPrimary, fontWeight: FontWeight.w600),
      titleLarge: base.titleLarge?.copyWith(color: textPrimary, fontWeight: FontWeight.w600),
      titleMedium: base.titleMedium?.copyWith(color: textPrimary, fontWeight: FontWeight.w500),
      bodyLarge: base.bodyLarge?.copyWith(color: textPrimary, fontSize: 15, height: 1.55),
      bodyMedium: base.bodyMedium?.copyWith(color: textPrimary, fontSize: 14, height: 1.5),
      bodySmall: base.bodySmall?.copyWith(color: textSecondary, fontSize: 12),
      labelLarge: base.labelLarge?.copyWith(color: textPrimary, fontWeight: FontWeight.w600),
    );
  }

  static ThemeData get darkTheme {
    final textTheme = _sansTextTheme(Brightness.dark);
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: bgBase,
      colorScheme: const ColorScheme.dark(
        primary: claudeOrange,
        onPrimary: Colors.white,
        secondary: claudeOrangeLight,
        onSecondary: Colors.white,
        surface: bgSurface,
        onSurface: textPrimary,
        surfaceContainerHighest: bgSurfaceAlt,
        error: statusError,
        onError: Colors.white,
        outline: borderDefault,
        outlineVariant: borderSubtle,
      ),
      dividerColor: borderSubtle,
      textTheme: textTheme,
      appBarTheme: AppBarTheme(
        backgroundColor: bgBase,
        foregroundColor: textPrimary,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: GoogleFonts.inter(
          fontSize: 18,
          fontWeight: FontWeight.w600,
          color: textPrimary,
        ),
      ),
      iconTheme: const IconThemeData(color: textSecondary, size: 22),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: bgSurface,
        hintStyle: GoogleFonts.inter(color: textMuted),
        labelStyle: GoogleFonts.inter(color: textSecondary),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: borderSubtle, width: 0.5),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: borderSubtle, width: 0.5),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: claudeOrange, width: 1.2),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: claudeOrange,
          foregroundColor: Colors.white,
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          textStyle: GoogleFonts.inter(fontWeight: FontWeight.w600, fontSize: 14),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: claudeOrange,
          textStyle: GoogleFonts.inter(fontWeight: FontWeight.w500),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: textPrimary,
          side: const BorderSide(color: borderDefault, width: 0.8),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      ),
      cardTheme: CardThemeData(
        color: bgSurface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: borderSubtle, width: 0.5),
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: bgSurfaceAlt,
        labelStyle: GoogleFonts.inter(color: textPrimary, fontSize: 12),
        side: const BorderSide(color: borderSubtle, width: 0.5),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
      dividerTheme: const DividerThemeData(
        color: borderSubtle,
        thickness: 0.5,
        space: 1,
      ),
      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: claudeOrange,
        foregroundColor: Colors.white,
        elevation: 2,
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: bgSurface,
        contentTextStyle: GoogleFonts.inter(color: textPrimary),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    );
  }

  /// Fonte serif para respostas da IA (estilo Claude) — Source Serif 4 via Google Fonts.
  static TextStyle serifTextStyle({
    double? fontSize,
    FontWeight? fontWeight,
    Color? color,
    double? height,
  }) =>
      GoogleFonts.sourceSerif4(
        fontSize: fontSize,
        fontWeight: fontWeight,
        color: color ?? textPrimary,
        height: height,
      );

  /// Fonte sans para mensagens do usuário / UI — Inter via Google Fonts.
  static TextStyle sansTextStyle({
    double? fontSize,
    FontWeight? fontWeight,
    Color? color,
    double? height,
  }) =>
      GoogleFonts.inter(
        fontSize: fontSize,
        fontWeight: fontWeight,
        color: color ?? textPrimary,
        height: height,
      );
}
