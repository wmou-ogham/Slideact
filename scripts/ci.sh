#!/usr/bin/env sh
set -eu

project_name="slide-helper-ci"
export SLIDE_HELPER_PORT=18080

cleanup() {
  docker compose --project-name "$project_name" --profile test down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM

docker build --file infra/docker/rust-ci.Dockerfile --tag slide-helper-rust-ci:dev .
docker build --file infra/docker/node-ci.Dockerfile --tag slide-helper-node-ci:dev .
docker compose --project-name "$project_name" --profile test build smoke
docker compose --project-name "$project_name" --profile test up --detach --build --wait \
  postgres redis migrate api worker web proxy
docker compose --project-name "$project_name" --profile test run --rm --no-deps smoke
