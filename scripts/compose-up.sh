#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "slide-helper: missing .env — copy .env.example to .env first" >&2
  exit 1
fi

for _ in $(seq 1 120); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker info >/dev/null 2>&1; then
  echo "slide-helper: Docker daemon not ready after 120s" >&2
  exit 1
fi

exec docker compose up --detach --wait --remove-orphans
