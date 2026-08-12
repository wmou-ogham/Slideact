#!/usr/bin/env sh
set -eu

project_name="slide-helper-ci"

ci_compose() {
  docker compose --file compose.yaml --file compose.ci.yaml --project-name "$project_name" "$@"
}

cleanup() {
  ci_compose --profile test down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM

docker build --file infra/docker/rust-ci.Dockerfile --tag slide-helper-rust-ci:dev .
PROTOCOL_GENERATOR_SKIP_BUILD=1 \
  PROTOCOL_GENERATOR_IMAGE=slide-helper-rust-ci:dev \
  ./scripts/generate-protocol-types.sh --check
docker build --file infra/docker/node-ci.Dockerfile --tag slide-helper-node-ci:dev .
ci_compose --profile test build smoke
ci_compose --profile test up --detach --build --wait \
  postgres redis migrate api worker web proxy
ci_compose exec --no-TTY postgres \
  psql --username slide_helper --dbname slide_helper --file /dev/stdin < tests/smoke/schema.sql
ci_compose exec --no-TTY postgres \
  psql --username slide_helper --dbname slide_helper --file /dev/stdin < tests/smoke/authorization.sql
ci_compose --profile test run --rm --no-deps smoke
