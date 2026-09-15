#!/bin/sh
# PocketBay 启动钩子（由 package.json 的 "start" 调用）。
#
# 同一个容器里起两个进程：
#   - FastAPI  绑 127.0.0.1:8000（内网，不对外）
#   - Next.js  绑 0.0.0.0:$PORT（对外，平台注入 PORT）
# Next.js 通过 next.config.ts 的 rewrites 把接口路径反代给 FastAPI。
set -u

PYROOT=/app/.pysys
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${PORT:-3000}"

export PYTHONPATH="${PYROOT}/site"
export PYTHONHOME="${PYROOT}/usr"
export LD_LIBRARY_PATH="${PYROOT}/usr/lib:${PYROOT}/site${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
export PYTHONUNBUFFERED=1
export PYTHONDONTWRITEBYTECODE=1
# next.config.ts 的 rewrites 读这个变量
export BACKEND_ORIGIN="http://127.0.0.1:${BACKEND_PORT}"

if [ ! -x "${PYROOT}/usr/bin/python3" ]; then
  echo "[pb-start] 错误：找不到自带 Python（${PYROOT}/usr/bin/python3），构建阶段可能失败"
fi

echo "[pb-start] backend  -> 127.0.0.1:${BACKEND_PORT}"
cd /app/backend || exit 1
PORT="${BACKEND_PORT}" "${PYROOT}/usr/bin/python3" main.py &
BACKEND_PID=$!
cd /app || exit 1

# 等后端就绪再起前端，避免平台健康检查期间 /health 返回 500
i=0
while [ "${i}" -lt 60 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${BACKEND_PORT}/health" 2>/dev/null; then
    echo "[pb-start] backend 已就绪（${i}00ms）"
    break
  fi
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "[pb-start] 警告：backend 进程已退出，接口将不可用"
    break
  fi
  i=$((i + 1))
  sleep 0.5
done

echo "[pb-start] frontend -> 0.0.0.0:${FRONTEND_PORT}  (proxy -> ${BACKEND_ORIGIN})"
exec ./node_modules/.bin/next start -H 0.0.0.0 -p "${FRONTEND_PORT}"
