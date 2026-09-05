#!/bin/bash
# 一键启动 Yandex 并自动加载「视频实时翻译」扩展
# 注意：会先退出已运行的 Yandex（否则参数不生效）
EXT="/Users/y.y.xie/Desktop/deepseek/video-translator-extension"

if [ ! -d "$EXT" ]; then
  osascript -e 'display alert "找不到扩展文件夹" message "请确认文件夹存在：'$EXT'"'
  exit 1
fi

osascript -e 'quit app "Yandex"' 2>/dev/null
sleep 1
open -a Yandex --args --load-extension="$EXT"
osascript -e 'display notification "Yandex 已启动，扩展已自动加载" with title "视频实时翻译"'
