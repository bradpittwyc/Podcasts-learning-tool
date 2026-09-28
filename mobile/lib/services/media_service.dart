import 'package:file_picker/file_picker.dart';

/// 本地媒体与字幕选择（安卓：触发系统文件选择器，需 READ_MEDIA_VIDEO 等权限）。
class MediaService {
  const MediaService._();

  /// 选一个媒体文件（视频/音频），返回路径；取消则返回 null。
  static Future<String?> pickMedia() async {
    final res = await FilePicker.pickFiles(type: FileType.media);
    return res.isNotEmpty ? res.first.path : null;
  }

  /// 选字幕文件（srt/vtt/txt）。
  static Future<String?> pickSubtitle() async {
    final res = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['srt', 'vtt', 'txt'],
    );
    return res.isNotEmpty ? res.first.path : null;
  }

  /// 同时选「媒体 + 字幕」两个文件。
  static Future<(String? media, String? subtitle)> pickBoth() async {
    final res = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: [
        'mp4', 'mkv', 'mov', 'webm', 'mp3', 'm4a', 'wav', 'srt', 'vtt'
      ],
    );
    String? media;
    String? subtitle;
    for (final f in res) {
      final p = f.path;
      if (p == null) continue;
      final ext = f.extension?.toLowerCase();
      if (['srt', 'vtt', 'txt'].contains(ext)) {
        subtitle ??= p;
      } else {
        media ??= p;
      }
    }
    return (media, subtitle);
  }
}
