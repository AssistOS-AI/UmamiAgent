#!/usr/bin/env sh
set -eu

: "${POSTGRES_DB:=umami}"
: "${POSTGRES_USER:=umami}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${APP_SECRET:?APP_SECRET is required}"

export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@analytics-db:5432/${POSTGRES_DB}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT="${PORT:-3000}"
export PATH="/app/node_modules/.bin:${PATH}"
unset NODE_OPTIONS

cd /app

node /usr/local/lib/node_modules/npm/bin/npm-cli.js run check-db
node scripts/update-tracker.js
exec node server.js
