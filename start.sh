#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

if [ -f venv/bin/activate ]; then
  source venv/bin/activate
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "ERRO: Node.js 18+ e npm sao necessarios para o modulo Social Publisher." >&2
  exit 1
fi

if ! command -v python >/dev/null 2>&1; then
  echo "ERRO: Python nao foi encontrado no ambiente do Workspace." >&2
  exit 1
fi

if [ ! -d social-publisher/node_modules ]; then
  (cd social-publisher && npm install --omit=dev --no-audit --no-fund)
fi

# O FastAPI nao precisa usar uma porta fixa. Se WORKSPACE_INTERNAL_PORT nao
# estiver configurada, escolhemos automaticamente uma porta loopback livre.
# Isso evita conflito com outros servicos locais (como ocorreu com a 8001).
WORKSPACE_INTERNAL_PORT="${WORKSPACE_INTERNAL_PORT:-}"
if [ -z "$WORKSPACE_INTERNAL_PORT" ]; then
  WORKSPACE_INTERNAL_PORT="$(python - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
fi

PUBLIC_PORT="${PORT:-8000}"
export WORKSPACE_UPSTREAM="http://127.0.0.1:${WORKSPACE_INTERNAL_PORT}"
export SOCIAL_BASE_PATH="${SOCIAL_BASE_PATH:-/social}"
export PORT="$PUBLIC_PORT"

echo "Workspace FastAPI interno: http://127.0.0.1:${WORKSPACE_INTERNAL_PORT}"
echo "Gateway Workspace/Social Publisher: 0.0.0.0:${PUBLIC_PORT}"

uvicorn main:app --host 127.0.0.1 --port "$WORKSPACE_INTERNAL_PORT" &
PY_PID=$!

cleanup() {
  kill "$PY_PID" "${NODE_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# O gateway Node fica na porta publica e encaminha todas as rotas antigas
# para o FastAPI, exceto /social, que pertence ao Social Publisher.
node social-publisher/src/server.js &
NODE_PID=$!

set +e
wait -n "$PY_PID" "$NODE_PID"
STATUS=$?
set -e
cleanup
wait "$PY_PID" "$NODE_PID" 2>/dev/null || true
exit "$STATUS"
