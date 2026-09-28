import 'package:flutter/material.dart';
import 'package:podcasts_learning_tool/screens/home_screen.dart';

void main() {
  runApp(const PodcastsLearningToolApp());
}

class PodcastsLearningToolApp extends StatelessWidget {
  const PodcastsLearningToolApp({super.key});

  @override
  Widget build(BuildContext context) {
    // 平板与手机共用一套响应式布局（见 HomeScreen 的 LayoutBuilder）。
    return MaterialApp(
      title: 'Podcasts Learning Tool',
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF2E6CF6),
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF2E6CF6),
        brightness: Brightness.dark,
      ),
      themeMode: ThemeMode.system,
      home: const HomeScreen(),
    );
  }
}
