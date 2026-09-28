//
//  plt-macos.swift — macOS 原生能力的小命令行工具
//
//  用途（全部离线、零费用）：
//    plt-macos ocr --path <image.png> [--langs en-US,zh-Hans]   Vision 文字识别
//    plt-macos selection                                        Accessibility 读取前台 app 选中文字
//    plt-macos version                                          版本号（构建/诊断用）
//
//  输入：命令行参数；输出：stdout 单行 JSON（永远是 JSON，便于 Node 侧解析）。
//  由 src/main/mac-helper.js 调用，首次使用时用 `xcrun swiftc` 就地编译。
//
//  需要的系统权限：
//    · selection → 「辅助功能」（系统设置 → 隐私与安全性 → 辅助功能）
//    · ocr       → 不需要额外权限（图片已在磁盘上）
//

import Foundation
import AppKit
import Vision
import ApplicationServices

let VERSION = "1"

// MARK: - JSON 输出

func emit(_ dict: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
        let s = String(data: data, encoding: .utf8) else {
    print("{\"ok\":false,\"code\":\"SERIALIZE_FAILED\"}")
    return
  }
  print(s)
  fflush(stdout)
}

func fail(_ code: String, _ error: String) {
  emit(["ok": false, "code": code, "error": error])
}

// 支持 escaping 的字符串取值（统一处理非 String 的 CFTypeRef）
func stringValue(_ value: Any?) -> String? {
  if let s = value as? String { return s }
  return nil
}

// MARK: - OCR

func cgImage(fromFile path: String) -> CGImage? {
  let url = URL(fileURLWithPath: path)
  guard let data = try? Data(contentsOf: url),
        let provider = CGDataProvider(data: data as CFData) else { return nil }
  // 直接交给 CGImage 解码（PNG / JPEG / BMP 都支持），避免依赖 NSImage 的加载线程要求
  if let direct = CGImage(pngDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) {
    return direct
  }
  if let jpeg = CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) {
    return jpeg
  }
  return nil
}

func runOCR(path: String, langs: [String]) {
  guard FileManager.default.fileExists(atPath: path) else {
    fail("NO_FILE", "图片不存在：\(path)")
    return
  }
  guard let cg = cgImage(fromFile: path) else {
    fail("BAD_IMAGE", "无法解码图片（仅支持 PNG / JPEG）")
    return
  }

  let request = VNRecognizeTextRequest()
  // revision 2 起支持中文简体 / 繁体；取系统支持的最高 revision 以便老系统也能跑
  request.revision = VNRecognizeTextRequest.supportedRevisions.last ?? 1
  request.recognitionLevel = .accurate
  // 关掉语言纠正：不然 Vision 会把生词「修正」成词典里已有的词，反而读到假词
  request.usesLanguageCorrection = false
  if !langs.isEmpty { request.recognitionLanguages = langs }

  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  do {
    try handler.perform([request])
  } catch {
    fail("VISION_ERROR", String(describing: error))
    return
  }

  guard let observations = request.results as? [VNRecognizedTextObservation] else {
    emit(["ok": true, "text": "", "lines": [], "lang": langs.first ?? "en-US"])
    return
  }
  let lines: [String] = observations.compactMap { $0.topCandidates(1).first?.string }
  let text = lines.joined(separator: "\n")
  emit(["ok": true, "text": text, "lines": lines, "lang": langs.first ?? "en-US", "revision": request.revision])
}

// MARK: - 前台 app 选中文字（Accessibility）

/// 从某个 AXUIElement 上读选中文本，必要时往子元素里浅挖几层。
/// 有些 App（Safari / Chrome / Preview）选中文本挂在 focused element 本身，
/// 有些（部分 PDF 阅读器、自定义视图）挂在它的子元素上，所以要往下找。
func selectedText(in element: AXUIElement, depth: Int = 0) -> (String?, Int32?) {
  var value: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &value)
  if err == .success {
    if let s = stringValue(value), !s.isEmpty { return (s, nil) }
    if let arr = value as? [Any], let first = arr.first, let s = stringValue(first), !s.isEmpty { return (s, nil) }
  }
  if depth >= 3 { return (nil, err.rawValue) }

  var children: CFTypeRef?
  let cErr = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
  guard cErr == .success, let kids = children as? [AXUIElement] else { return (nil, err.rawValue) }
  for kid in kids.prefix(40) {
    let (text, _) = selectedText(in: kid, depth: depth + 1)
    if let t = text, !t.isEmpty { return (t, nil) }
  }
  return (nil, err.rawValue)
}

func runSelection() {
  guard AXIsProcessTrusted() else {
    fail("AX_PERMISSION", "未获得「辅助功能」权限。请在 系统设置 → 隐私与安全性 → 辅助功能 中勾选本应用，然后重试。")
    return
  }

  let systemWide = AXUIElementCreateSystemWide()
  var focusedRef: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef)
  guard err == .success else {
    fail("NO_FOCUS", "读不到前台焦点元素（可能没有活动窗口），AXError=\(err.rawValue)")
    return
  }
  guard let focused = focusedRef, CFGetTypeID(focused) == AXUIElementGetTypeID() else {
    fail("NO_FOCUS", "焦点元素类型异常")
    return
  }

  let element = focused as! AXUIElement
  let (text, _) = selectedText(in: element)
  if let t = text, !t.isEmpty {
    emit(["ok": true, "text": t])
  } else {
    emit(["ok": false, "code": "NO_SELECTION", "text": ""])
  }
}

// MARK: - 参数解析

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "version"

var pathArg: String?
var langsArg: [String] = []
var i = 1
while i < args.count {
  switch args[i] {
  case "--path":
    if i + 1 < args.count { pathArg = args[i + 1] }
    i += 2
  case "--langs":
    if i + 1 < args.count {
      langsArg = args[i + 1].split(separator: ",").map(String.init).filter { !$0.isEmpty }
    }
    i += 2
  default:
    i += 1
  }
}

switch command {
case "ocr":
  guard let p = pathArg else {
    fail("NO_PATH", "缺少 --path")
    break
  }
  runOCR(path: p, langs: langsArg)
case "selection":
  runSelection()
case "version":
  emit(["ok": true, "version": VERSION, "macos": ProcessInfo.processInfo.operatingSystemVersionString])
default:
  fail("BAD_COMMAND", "未知子命令：\(command)")
}
