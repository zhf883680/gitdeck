#!/bin/bash
# gitdeck 启动脚本：优先使用内置 Node，其次系统 Node
set -e
cd "$(dirname "$0")"

PORT="${GITDECK_PORT:-7317}"

find_node() {
  for c in \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2-6/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node ; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  command -v node
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  echo "没有找到 node，请先安装 Node.js 18+"
  exit 1
fi

# 已有实例在跑就直接开浏览器
if curl -s --noproxy '*' "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1; then
  open "http://127.0.0.1:${PORT}"
  exit 0
fi

( sleep 1.2; open "http://127.0.0.1:${PORT}" ) &
exec "$NODE" server.js
