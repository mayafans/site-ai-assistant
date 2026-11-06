#!/usr/bin/env bash
# 一键安装到 Linux 服务器（Node 18+ 已就绪）
# 用法：sudo bash deploy/install.sh [安装目录，默认 /opt/site-ai-assistant]
set -euo pipefail

APP_DIR="${1:-/opt/site-ai-assistant}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"

[ -n "$NODE_BIN" ] || { echo "找不到 node，请先安装 Node 18+"; exit 1; }
"$NODE_BIN" -e 'const v=+process.versions.node.split(".")[0]; if(v<18){console.error("Node 版本过低:",process.versions.node);process.exit(1)}'

echo "==> 安装到 $APP_DIR"
mkdir -p "$APP_DIR"
if command -v rsync >/dev/null; then
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'data/users.json' \
    --exclude 'data/sites.json' --exclude '*.log' --exclude '.local-pids' \
    --exclude 'deploy/gateway.config.local.json' \
    "$SRC_DIR"/ "$APP_DIR"/
else
  cp -a "$SRC_DIR"/. "$APP_DIR"/
  rm -rf "$APP_DIR/.git" "$APP_DIR/node_modules"
fi

echo "==> 构建前端产物"
cd "$APP_DIR" && "$NODE_BIN" build-widget.mjs

echo "==> 安装 systemd 服务"
if [ -d /run/systemd/system ]; then
  sed "s#/usr/bin/node#$NODE_BIN#g; s#/opt/site-ai-assistant#$APP_DIR#g" \
    "$APP_DIR/deploy/systemd/site-ai-assistant.service" > /etc/systemd/system/site-ai-assistant.service
  sed "s#/usr/bin/node#$NODE_BIN#g; s#/opt/site-ai-assistant#$APP_DIR#g" \
    "$APP_DIR/deploy/systemd/site-ai-gateway.service" > /etc/systemd/system/site-ai-gateway.service
  systemctl daemon-reload
  systemctl enable --now site-ai-assistant.service
  echo "==> 助手已启动：http://127.0.0.1:8820"
  echo "    需要反向代理网关时再执行： systemctl enable --now site-ai-gateway"
else
  echo "==> 没有 systemd，手动启动："
  echo "    cd $APP_DIR && HOST=127.0.0.1 PORT=8820 $NODE_BIN server.mjs"
fi

echo
echo "完成。首次启动日志里的初始管理员口令请立即修改。"
