#!/usr/bin/env sh
set -eu

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
POSTGRES_DB="${POSTGRES_DB:-umami}"
POSTGRES_USER="${POSTGRES_USER:-umami}"
UMAMI_APP_PORT="${UMAMI_APP_PORT:-3000}"
UMAMI_MCP_DIR="${UMAMI_MCP_DIR:-/opt/umami-mcp}"
UMAMI_MCP_PORT="${UMAMI_MCP_PORT:-7301}"
UMAMI_BASE_URL="${UMAMI_BASE_URL:-http://127.0.0.1:${UMAMI_APP_PORT}}"
UMAMI_MCP_SQLITE_PATH="${UMAMI_MCP_SQLITE_PATH:-/tmp/umami-mcp/sessions.db}"
OAUTH_CLIENT_ID="${OAUTH_CLIENT_ID:-umami-agent}"
OAUTH_REDIRECT_URI="${OAUTH_REDIRECT_URI:-http://127.0.0.1:${UMAMI_MCP_PORT}/oauth/callback}"
BUN_INSTALL="${BUN_INSTALL:-/opt/bun}"

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${APP_SECRET:?APP_SECRET is required}"
: "${MCP_SECRET:?MCP_SECRET is required}"

export PATH="${BUN_INSTALL}/bin:/root/.bun/bin:${PATH}"
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export APP_SECRET
export UMAMI_URL="${UMAMI_BASE_URL}"
export MCP_SECRET
export OAUTH_CLIENT_ID
export OAUTH_REDIRECT_URI
export SQLITE_PATH="${UMAMI_MCP_SQLITE_PATH}"
export PGPASSWORD="${POSTGRES_PASSWORD}"

mkdir -p "$(dirname "${UMAMI_MCP_SQLITE_PATH}")"

if [ ! -f "${UMAMI_MCP_DIR}/dist/index.js" ]; then
    echo "ERROR: ${UMAMI_MCP_DIR}/dist/index.js is missing from the umami-agent image." >&2
    exit 1
fi

if [ ! -f /app/server.js ]; then
    echo "ERROR: /app/server.js is missing from the umami-agent image." >&2
    exit 1
fi

mkdir -p "${PGDATA}"
chown -R postgres:postgres "${PGDATA}"
chmod 700 "${PGDATA}"
mkdir -p /run/postgresql
chown postgres:postgres /run/postgresql

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
    pwfile="$(mktemp)"
    printf '%s\n' "${POSTGRES_PASSWORD}" > "${pwfile}"
    chown postgres:postgres "${pwfile}"
    chmod 600 "${pwfile}"
    su-exec postgres initdb -D "${PGDATA}" -U "${POSTGRES_USER}" --pwfile="${pwfile}" --auth-host=scram-sha-256 --auth-local=trust
    rm -f "${pwfile}"
fi

su-exec postgres postgres -D "${PGDATA}" -c listen_addresses=127.0.0.1 -p 5432 &
postgres_pid="$!"

cleanup() {
    if [ -n "${agent_server_pid:-}" ]; then
        kill "${agent_server_pid}" 2>/dev/null || true
    fi
    if [ -n "${umami_mcp_pid:-}" ]; then
        kill "${umami_mcp_pid}" 2>/dev/null || true
    fi
    if [ -n "${umami_app_pid:-}" ]; then
        kill "${umami_app_pid}" 2>/dev/null || true
    fi
    if [ -n "${postgres_pid:-}" ]; then
        kill "${postgres_pid}" 2>/dev/null || true
    fi
}
trap cleanup INT TERM EXIT

ready=0
for _ in $(seq 1 60); do
    if pg_isready -h 127.0.0.1 -p 5432 -U "${POSTGRES_USER}" -d postgres >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "${postgres_pid}" 2>/dev/null; then
        echo "ERROR: postgres exited before becoming healthy." >&2
        wait "${postgres_pid}" || true
        exit 1
    fi
    sleep 1
done

if [ "${ready}" != "1" ]; then
    echo "ERROR: timed out waiting for postgres on 127.0.0.1:5432." >&2
    exit 1
fi

if ! psql -h 127.0.0.1 -p 5432 -U "${POSTGRES_USER}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}'" | grep -q 1; then
    createdb -h 127.0.0.1 -p 5432 -U "${POSTGRES_USER}" "${POSTGRES_DB}"
fi

unset NODE_OPTIONS

cd /app
node /usr/local/lib/node_modules/npm/bin/npm-cli.js run check-db
node scripts/update-tracker.js
PORT="${UMAMI_APP_PORT}" node server.js &
umami_app_pid="$!"

ready=0
for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${UMAMI_APP_PORT}/api/heartbeat" >/dev/null 2>&1 \
        || curl -fsS "http://127.0.0.1:${UMAMI_APP_PORT}/" >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "${umami_app_pid}" 2>/dev/null; then
        echo "ERROR: Umami app exited before becoming healthy." >&2
        wait "${umami_app_pid}" || true
        exit 1
    fi
    sleep 1
done

if [ "${ready}" != "1" ]; then
    echo "ERROR: timed out waiting for Umami app on port ${UMAMI_APP_PORT}." >&2
    exit 1
fi

cd "${UMAMI_MCP_DIR}"
PORT="${UMAMI_MCP_PORT}" bun run dist/index.js &
umami_mcp_pid="$!"

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

while kill -0 "${postgres_pid}" 2>/dev/null \
    && kill -0 "${umami_app_pid}" 2>/dev/null \
    && kill -0 "${umami_mcp_pid}" 2>/dev/null \
    && kill -0 "${agent_server_pid}" 2>/dev/null; do
    sleep 1
done

cleanup
wait "${agent_server_pid}" 2>/dev/null || true
wait "${umami_mcp_pid}" 2>/dev/null || true
wait "${umami_app_pid}" 2>/dev/null || true
wait "${postgres_pid}" 2>/dev/null || true
