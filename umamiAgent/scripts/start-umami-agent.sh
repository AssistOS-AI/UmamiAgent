#!/usr/bin/env sh
set -eu

PGDATA="${PGDATA:-/root/postgres}"
POSTGRES_DB="${POSTGRES_DB:-umami}"
POSTGRES_USER="${POSTGRES_USER:-admin}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-admin}"
UMAMI_APP_PORT="${UMAMI_APP_PORT:-3000}"
UMAMI_UPSTREAM_PORT=3001
UMAMI_MCP_DIR="${UMAMI_MCP_DIR:-/opt/umami-mcp}"
UMAMI_MCP_PORT="${UMAMI_MCP_PORT:-7301}"
UMAMI_BASE_URL="${UMAMI_BASE_URL:-http://127.0.0.1:${UMAMI_APP_PORT}}"
UMAMI_MCP_SQLITE_PATH="${UMAMI_MCP_SQLITE_PATH:-/tmp/umami-mcp/sessions.db}"
OAUTH_CLIENT_ID="${OAUTH_CLIENT_ID:-umami-agent}"
OAUTH_REDIRECT_URI="${OAUTH_REDIRECT_URI:-http://127.0.0.1:${UMAMI_MCP_PORT}/oauth/callback}"
BUN_INSTALL="${BUN_INSTALL:-/opt/bun}"

: "${APP_SECRET:?APP_SECRET is required}"
: "${MCP_SECRET:?MCP_SECRET is required}"

export PATH="${BUN_INSTALL}/bin:/root/.bun/bin:${PATH}"
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export APP_SECRET
export BASE_PATH='/base-agent-additional-server/umamiAgent/3000'
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

if [ "${UMAMI_APP_PORT}" != "3000" ]; then
    echo "ERROR: this Umami image is built for the Router publication on port 3000." >&2
    exit 1
fi
NODE_OPTIONS= node /code/scripts/umami-ingress.mjs --check-build

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
    if [ -n "${umami_ingress_pid:-}" ]; then
        kill "${umami_ingress_pid}" 2>/dev/null || true
    fi
    if [ -n "${postgres_pid:-}" ]; then
        kill "${postgres_pid}" 2>/dev/null || true
    fi
}
trap cleanup INT TERM EXIT

start_agent_server() {
    PORT="${PLOINKY_AGENT_SERVER_PORT:-7000}" sh /Agent/server/AgentServer.sh &
    agent_server_pid="$!"
}

# A Ploinky replacement (reinstall, image update) starts the new runtime while
# its predecessor still serves, and both mount the same agent storage. Two
# PostgreSQL servers on one data directory can corrupt it, and the
# predecessor's shutdown deletes the successor's postmaster.pid, which stops
# the successor a minute later. An exclusive flock on the shared storage keeps
# one database owner. A successor that finds the lock held starts only
# AgentServer, so its MCP readiness succeeds and Ploinky retires the
# predecessor; the lock is released when that container exits, and the
# successor then starts the Umami stack. The lock fd stays open for the whole
# runtime, and child processes inherit it.
UMAMI_DATA_LOCK="${UMAMI_DATA_LOCK:-$(dirname "${PGDATA}")/umami-postgres.lock}"
exec 9>>"${UMAMI_DATA_LOCK}"
if ! flock -n 9; then
    echo "umamiAgent: another runtime still owns ${PGDATA}; starting AgentServer and waiting for it to exit." >&2
    start_agent_server
    flock 9
    echo "umamiAgent: data directory released; starting the Umami stack." >&2
fi

mkdir -p "${PGDATA}"
chown -R postgres:postgres "${PGDATA}"
chmod 700 "${PGDATA}"

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
    pwfile="$(mktemp)"
    printf '%s\n' "${POSTGRES_PASSWORD}" > "${pwfile}"
    chown postgres:postgres "${pwfile}"
    chmod 600 "${pwfile}"
    su-exec postgres initdb -D "${PGDATA}" -U "${POSTGRES_USER}" --pwfile="${pwfile}" --auth-host=scram-sha-256 --auth-local=trust
    rm -f "${pwfile}"
fi

# The credentials are fixed configuration, not a secret derived from the
# Ploinky master key, so re-apply them to whatever data directory is present.
# A data directory created by an earlier workspace (different role or
# password) then keeps working. Single-user mode needs no authentication and
# opens no socket; it runs before the server starts.
sql_literal() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }
sql_ident() { printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"; }
pg_role_literal="$(sql_literal "${POSTGRES_USER}")"
pg_role_ident="$(sql_ident "${POSTGRES_USER}")"
pg_password_literal="$(sql_literal "${POSTGRES_PASSWORD}")"
printf '%s\n%s\n' \
    "DO \$do\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${pg_role_literal}) THEN CREATE ROLE ${pg_role_ident} SUPERUSER LOGIN; END IF; END \$do\$;" \
    "ALTER ROLE ${pg_role_ident} WITH SUPERUSER LOGIN PASSWORD ${pg_password_literal};" \
    | su-exec postgres postgres --single -D "${PGDATA}" postgres >/dev/null

# Ploinky bind-mounts its router descriptor and edge topology under /run, so
# /run stays on the container's overlay rootfs instead of a tmpfs. PostgreSQL
# chmods its Unix-domain socket after binding it, and that chmod returns
# EPERM there, which is fatal to startup. Every client below connects over
# loopback TCP, so serve TCP only rather than depending on a socket directory
# whose permissions this runtime cannot grant.
su-exec postgres postgres -D "${PGDATA}" -c listen_addresses=127.0.0.1 -p 5432 -c unix_socket_directories='' &
postgres_pid="$!"

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
HOSTNAME=127.0.0.1 PORT="${UMAMI_UPSTREAM_PORT}" node server.js &
umami_app_pid="$!"
node /code/scripts/umami-ingress.mjs &
umami_ingress_pid="$!"

ready=0
for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${UMAMI_APP_PORT}/api/heartbeat" >/dev/null 2>&1 \
        || curl -fsS "http://127.0.0.1:${UMAMI_APP_PORT}/" >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "${umami_app_pid}" 2>/dev/null || ! kill -0 "${umami_ingress_pid}" 2>/dev/null; then
        echo "ERROR: Umami app or ingress exited before becoming healthy." >&2
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

if [ -z "${agent_server_pid:-}" ]; then
    start_agent_server
fi

while kill -0 "${postgres_pid}" 2>/dev/null \
    && kill -0 "${umami_app_pid}" 2>/dev/null \
    && kill -0 "${umami_ingress_pid}" 2>/dev/null \
    && kill -0 "${umami_mcp_pid}" 2>/dev/null \
    && kill -0 "${agent_server_pid}" 2>/dev/null; do
    sleep 1
done

cleanup
wait "${agent_server_pid}" 2>/dev/null || true
wait "${umami_mcp_pid}" 2>/dev/null || true
wait "${umami_app_pid}" 2>/dev/null || true
wait "${umami_ingress_pid}" 2>/dev/null || true
wait "${postgres_pid}" 2>/dev/null || true
