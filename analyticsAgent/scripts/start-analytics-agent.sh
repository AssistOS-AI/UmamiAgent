#!/usr/bin/env sh
set -eu

UMAMI_MCP_DIR="${UMAMI_MCP_DIR:-/opt/umami-mcp}"
UMAMI_MCP_PORT="${UMAMI_MCP_PORT:-7301}"
UMAMI_BASE_URL="${UMAMI_BASE_URL:-http://analytics-umami:3000}"
UMAMI_MCP_SQLITE_PATH="${UMAMI_MCP_SQLITE_PATH:-/tmp/umami-mcp/sessions.db}"
OAUTH_CLIENT_ID="${OAUTH_CLIENT_ID:-analytics-agent}"
OAUTH_REDIRECT_URI="${OAUTH_REDIRECT_URI:-http://127.0.0.1:${UMAMI_MCP_PORT}/oauth/callback}"
BUN_INSTALL="${BUN_INSTALL:-/opt/bun}"

: "${MCP_SECRET:?MCP_SECRET is required}"

export PATH="${BUN_INSTALL}/bin:/root/.bun/bin:${PATH}"
export UMAMI_URL="${UMAMI_BASE_URL}"
export MCP_SECRET
export OAUTH_CLIENT_ID
export OAUTH_REDIRECT_URI
export SQLITE_PATH="${UMAMI_MCP_SQLITE_PATH}"

mkdir -p "$(dirname "${UMAMI_MCP_SQLITE_PATH}")"

if [ ! -f "${UMAMI_MCP_DIR}/dist/index.js" ]; then
    echo "ERROR: ${UMAMI_MCP_DIR}/dist/index.js is missing. Run analyticsAgent install first." >&2
    exit 1
fi

cd "${UMAMI_MCP_DIR}"
PORT="${UMAMI_MCP_PORT}" bun run dist/index.js &
umami_mcp_pid="$!"

cleanup() {
    kill "${umami_mcp_pid}" 2>/dev/null || true
    if [ -n "${agent_server_pid:-}" ]; then
        kill "${agent_server_pid}" 2>/dev/null || true
    fi
}
trap cleanup INT TERM EXIT

ready=0
for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${UMAMI_MCP_PORT}/health" >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "${umami_mcp_pid}" 2>/dev/null; then
        echo "ERROR: umami-mcp exited before becoming healthy." >&2
        wait "${umami_mcp_pid}" || true
        exit 1
    fi
    sleep 1
done

if [ "${ready}" != "1" ]; then
    echo "ERROR: timed out waiting for umami-mcp on port ${UMAMI_MCP_PORT}." >&2
    exit 1
fi

export PORT="${PLOINKY_AGENT_SERVER_PORT:-7000}"
sh /Agent/server/AgentServer.sh &
agent_server_pid="$!"

while kill -0 "${umami_mcp_pid}" 2>/dev/null && kill -0 "${agent_server_pid}" 2>/dev/null; do
    sleep 1
done

cleanup
wait "${agent_server_pid}" 2>/dev/null || true
wait "${umami_mcp_pid}" 2>/dev/null || true
