# ocr.ps1 - Windows built-in OCR (Windows.Media.Ocr) for screen word capture
#
# Usage:
#   powershell -File ocr.ps1 -Path <image> [-Langs "en-US,zh-Hans-CN"]
# Output (single JSON object on stdout):
#   {"ok":true,"text":"...","lines":[{"text":"..","words":[{"text":"..","x":..,"y":..,"w":..,"h":..}]}],"lang":"en-US","count":n}
#   {"ok":false,"error":"...","code":"NO_OCR_ENGINE"}
#
# Notes on the WinRT bridge (the tricky part under PowerShell 5.1):
#   * A WinRT async call returns a __ComObject that exposes no methods at all
#     (no GetResults, no Status), so it cannot be awaited or polled directly.
#   * We compile a tiny reflection helper that calls
#     WindowsRuntimeSystemExtensions.AsTask<T>(IAsyncOperation<T>). The type argument is
#     supplied by PowerShell as a closed generic interface type
#     (e.g. [Windows.Foundation.IAsyncOperation[Windows.Storage.StorageFile]]), which the
#     binder resolves natively; the raw ComObject is then passed straight through.
#
# IMPORTANT: keep this file ASCII-only and save it as UTF-8 with BOM; Windows PowerShell
# 5.1 otherwise decodes it as ANSI(GBK) and reports bogus syntax errors.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Langs = 'en-US,zh-Hans-CN'
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.Write($json)
  [Console]::Out.Flush()
}

try {
  Add-Type -ReferencedAssemblies 'System.Runtime.WindowsRuntime' -TypeDefinition @'
using System;
using System.Reflection;
using System.Threading.Tasks;

public static class PltWinRt
{
    static Type Ext()
    {
        return Type.GetType("System.WindowsRuntimeSystemExtensions, System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089");
    }

    static MethodInfo GenericAsTask()
    {
        Type ext = Ext();
        if (ext == null) return null;
        foreach (MethodInfo m in ext.GetMethods())
        {
            if (m.Name != "AsTask") continue;
            if (!m.IsGenericMethodDefinition) continue;
            if (m.GetGenericArguments().Length != 1) continue;
            if (m.GetParameters().Length != 1) continue;
            return m;
        }
        return null;
    }

    // Await a WinRT IAsyncOperation<T>. closedIface must be
    // Windows.Foundation.IAsyncOperation<T> built by the caller (PowerShell).
    public static object Await(object op, Type closedIface, int timeoutMs)
    {
        if (op == null) throw new ArgumentNullException("op");
        if (closedIface == null) throw new ArgumentNullException("closedIface");
        MethodInfo gm = GenericAsTask();
        if (gm == null) throw new InvalidOperationException("WindowsRuntimeSystemExtensions.AsTask<T> not found");
        Type[] args = closedIface.GetGenericArguments();
        if (args.Length != 1) throw new ArgumentException("closedIface must be a closed IAsyncOperation<T>");
        MethodInfo closed = gm.MakeGenericMethod(args[0]);
        Task task = (Task)closed.Invoke(null, new object[] { op });
        if (!task.Wait(timeoutMs)) throw new TimeoutException("WinRT operation timed out (" + timeoutMs + "ms)");
        PropertyInfo pi = task.GetType().GetProperty("Result");
        return pi == null ? null : pi.GetValue(task, null);
    }
}
'@
} catch {
  Write-Result @{ ok = $false; code = 'WINRT_BRIDGE_FAILED'; error = 'WinRT bridge compile failed: ' + $_.Exception.Message }
  exit 0
}

function Await-WinRt($op, $ClosedIface, [int]$TimeoutMs = 30000) {
  return [PltWinRt]::Await($op, $ClosedIface, $TimeoutMs)
}

try {
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Result @{ ok = $false; error = "file not found: $Path"; code = 'NO_FILE' }
    exit 0
  }

  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

  # closed generic interface types (result-type hints for the AsTask<T> overloads)
  $IfStorageFile = [Windows.Foundation.IAsyncOperation[Windows.Storage.StorageFile]]
  $IfStream = [Windows.Foundation.IAsyncOperation[Windows.Storage.Streams.IRandomAccessStream]]
  $IfDecoder = [Windows.Foundation.IAsyncOperation[Windows.Graphics.Imaging.BitmapDecoder]]
  $IfBitmap = [Windows.Foundation.IAsyncOperation[Windows.Graphics.Imaging.SoftwareBitmap]]
  $IfOcr = [Windows.Foundation.IAsyncOperation[Windows.Media.Ocr.OcrResult]]

  $engine = $null
  $usedLang = ''

  if ($Langs -and $Langs.Trim().Length -gt 0) {
    foreach ($tag in ($Langs -split ',')) {
      $tag = $tag.Trim()
      if (-not $tag) { continue }
      try {
        $lang = New-Object Windows.Globalization.Language($tag)
        $candidate = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
        if ($candidate -ne $null) { $engine = $candidate; $usedLang = $tag; break }
      } catch { }
    }
  }

  if ($engine -eq $null) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($engine -ne $null) { $usedLang = $engine.RecognizerLanguage.LanguageTag }
  }
  if ($engine -eq $null) {
    Write-Result @{ ok = $false; code = 'NO_OCR_ENGINE'; error = 'Windows OCR engine unavailable. Add the English language pack: Settings > Time & language > Language & region > Add a language > English (United States), and enable the Optical character recognition feature.' }
    exit 0
  }

  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $Path).Path)) $IfStorageFile
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) $IfStream
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) $IfDecoder
  $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) $IfBitmap
  $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) $IfOcr

  $lines = @()
  foreach ($line in $result.Lines) {
    $words = @()
    foreach ($w in $line.Words) {
      $words += @{
        text = $w.Text
        x    = [int]$w.BoundingRect.X
        y    = [int]$w.BoundingRect.Y
        w    = [int]$w.BoundingRect.Width
        h    = [int]$w.BoundingRect.Height
      }
    }
    $lines += @{ text = $line.Text; words = $words }
  }

  $stream.Dispose()
  $bitmap.Dispose()

  Write-Result @{
    ok    = $true
    text  = $result.Text
    lines = $lines
    lang  = $usedLang
    count = $lines.Count
  }
} catch {
  Write-Result @{ ok = $false; code = 'OCR_FAILED'; error = $_.Exception.Message }
}
