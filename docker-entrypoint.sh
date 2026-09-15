#!/bin/bash
# 在同一容器内启动 FastAPI（内网 8000）与 Next.js（对外 PORT）。
set -u

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${PORT:-3000}"
BACKEND_ORIGIN="http://127.0.0.1:${BACKEND_PORT}"
export BACKEND_ORIGIN

echo "[entrypoint] backend  -> 0.0.0.0:${BACKEND_PORT}"
echo "[entrypoint] frontend -> 0.0.0.0:${FRONTEND_PORT} (proxy -> ${BACKEND_ORIGIN})"

cd /app/backend || exit 1
PORT="${BACKEND_PORT}" python main.py &
BACKEND_PID=$!

cd /app || exit 1

# 等后端就绪再起前端，避免平台健康检查期间 /health 返回 500
PROBE='import socket,sys;s=socket.socket();s.settimeout(1)
try:
    s.connect(("127.0.0.1",int(sys.argv[1])));sys.exit(0)
except Exception:
    sys.exit(1)'
i=0
while [ "${i}" -lt 60 ]; do
  if python -c "${PROBE}" "${BACKEND_PORT}" 2>/dev/null; then
    echo "[entrypoint] backend 已就绪（${i}00ms）"
    break
  fi
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "[entrypoint] 警告：backend 进程已退出，接口将不可用"
    break
  fi
  i=$((i + 1))
  sleep 0.5
done

PORT="${FRONTEND_PORT}" ./node_modules/.bin/next start -H 0.0.0.0 -p "${FRONTEND_PORT}" &
FRONTEND_PID=$!

shutdown() {
  echo "[entrypoint] 收到退出信号，正在停止子进程…"
  kill -TERM "${BACKEND_PID}" "${FRONTEND_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# 任一进程退出即整体退出，交给平台重启
wait -n "${BACKEND_PID}" "${FRONTEND_PID}"
echo "[entrypoint] 某个子进程已退出，容器随之退出"
kill -TERM "${BACKEND_PID}" "${FRONTEND_PID}" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
