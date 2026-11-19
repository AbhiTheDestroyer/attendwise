#!/usr/bin/env bash
# Single-command restart: installs the one dependency if the sandbox snapshot
# dropped node_modules, then boots the server with the existing seed database.
set -e
cd "$(dirname "$0")"
if [ ! -f node_modules/better-sqlite3/package.json ]; then
  echo "[run] node_modules missing — reinstalling better-sqlite3..."
  npm install --no-audit --no-fund
fi
exec node server.js
