/// 毫秒 -> mm:ss（或 h:mm:ss）。
String formatMs(int ms) {
  final totalSec = (ms / 1000).round();
  final h = totalSec ~/ 3600;
  final m = (totalSec % 3600) ~/ 60;
  final s = totalSec % 60;
  final ss = s.toString().padLeft(2, '0');
  if (h > 0) {
    return '${h}:${m.toString().padLeft(2, '0')}:$ss';
  }
  return '${m.toString().padLeft(2, '0')}:$ss';
}
