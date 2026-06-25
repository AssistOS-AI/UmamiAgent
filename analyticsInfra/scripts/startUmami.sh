#!/usr/bin/env sh
set -eu

: "${POSTGRES_DB:=umami}"
: "${POSTGRES_USER:=umami}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${APP_SECRET:?APP_SECRET is required}"

export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@analytics-db:5432/${POSTGRES_DB}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT="${PORT:-3000}"

exec pnpm start-docker
