#!/usr/bin/env bash
# 双击（或在终端里执行）这个文件就能跑出报告。
# macOS / Linux 用；Windows 请用同目录的 run.bat。
set -u
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  这台电脑上没有找到 Node.js。"
  echo "  去 https://nodejs.org/ 装一个（LTS 版就行），再重新运行这个文件。"
  echo ""
  read -r -p "  按回车退出…" _
  exit 1
fi

node steam-family.js "$@"
code=$?

# 双击运行时终端窗口会立刻关掉，这里停一下让人看清结果
if [ -t 0 ]; then
  echo ""
  read -r -p "  按回车关闭…" _
fi
exit $code
