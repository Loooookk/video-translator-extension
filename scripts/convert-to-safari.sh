#!/bin/bash
# 将本扩展转换为 Safari Web Extension（macOS 与 iOS 通用，需 Xcode）
# 用法：bash scripts/convert-to-safari.sh
set -e
cd "$(dirname "$0")/.."
OUT="safari-project"

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "❌ 未找到 safari-web-extension-converter，请先安装 Xcode（App Store 免费下载）"
  exit 1
fi

rm -rf "$OUT"

# 生成 Safari 专用副本：去掉 Chrome 专属的 CSP（wasm-unsafe-eval，Safari 校验器不识别）
STAGE=".safari-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R icons popup content offscreen background.js "$STAGE/"
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
delete m.content_security_policy;   // Safari 不识别 wasm-unsafe-eval；Safari 走字幕模式，无需 WASM
delete m.offscreen;                 // Safari 无 offscreen API
m.permissions = (m.permissions || []).filter(p => p !== 'offscreen' && p !== 'tabCapture');
fs.writeFileSync('$STAGE/manifest.json', JSON.stringify(m, null, 2));
"

echo "正在转换（Safari 副本）→ $OUT ..."
xcrun safari-web-extension-converter \
  --project-location "$OUT" \
  --app-name "视频实时翻译" \
  --bundle-identifier "com.dsh.videotranslator" \
  --force \
  --no-open \
  "$STAGE" 2>&1 | grep -v "warning: .*minimum_chrome_version" || true
rm -rf "$STAGE"

echo ""
echo "✅ 转换完成。接下来："
echo "   1. open $OUT/视频实时翻译.xcodeproj"
echo "   2. Xcode → Signing & Capabilities 选择你的 Apple ID（免费账号即可）"
echo "   3. macOS：选择「视频实时翻译 (macOS)」scheme 直接 Run"
echo "   4. iOS：选择「视频实时翻译 (iOS)」scheme，连接 iPhone 后 Run，"
echo "      然后在 设置 → Safari → 扩展 里开启本扩展"
echo "   提示：iOS 上 Safari 扩展不支持音频捕获，请使用「字幕识别」模式。"
