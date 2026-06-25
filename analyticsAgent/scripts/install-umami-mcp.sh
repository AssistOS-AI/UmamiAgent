#!/usr/bin/env sh
set -eu

UMAMI_MCP_DIR="${UMAMI_MCP_DIR:-/opt/umami-mcp}"
UMAMI_MCP_REPO="${UMAMI_MCP_REPO:-https://github.com/MadsNyl/umami-mcp.git}"
UMAMI_MCP_REF="${UMAMI_MCP_REF:-}"
BUN_INSTALL="${BUN_INSTALL:-/opt/bun}"
export BUN_INSTALL
export PATH="${BUN_INSTALL}/bin:/root/.bun/bin:${PATH}"

if ! command -v git >/dev/null 2>&1 \
    || ! command -v curl >/dev/null 2>&1 \
    || ! command -v bash >/dev/null 2>&1 \
    || ! command -v unzip >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update
        apt-get install -y --no-install-recommends bash git curl ca-certificates unzip
        rm -rf /var/lib/apt/lists/*
    else
        echo "ERROR: git and curl are required to install umami-mcp." >&2
        exit 1
    fi
fi

if ! command -v bun >/dev/null 2>&1; then
    echo "[analyticsAgent/install] Installing Bun runtime"
    curl -fsSL https://bun.sh/install | bash
fi

if [ ! -d "${UMAMI_MCP_DIR}/.git" ]; then
    rm -rf "${UMAMI_MCP_DIR}"
    git clone --depth 1 "${UMAMI_MCP_REPO}" "${UMAMI_MCP_DIR}"
fi

cd "${UMAMI_MCP_DIR}"

if [ -n "${UMAMI_MCP_REF}" ]; then
    git fetch --depth 1 origin "${UMAMI_MCP_REF}"
    git checkout FETCH_HEAD
fi

bun install --frozen-lockfile
bun run build
