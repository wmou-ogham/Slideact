#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
image_name=${PROTOCOL_GENERATOR_IMAGE:-slide-helper-protocol-generator:dev}
mode=${1:---write}
destination="$root_dir/packages/protocol/src/generated.ts"
temporary_file=$(mktemp)

cleanup() {
  rm -f "$temporary_file"
}

trap cleanup EXIT INT TERM

case "$mode" in
  --write | --check) ;;
  *)
    echo "usage: $0 [--write|--check]" >&2
    exit 2
    ;;
esac

if [ "${PROTOCOL_GENERATOR_SKIP_BUILD:-0}" != "1" ]; then
  docker build \
    --file "$root_dir/infra/docker/rust-ci.Dockerfile" \
    --tag "$image_name" \
    "$root_dir"
fi

docker run --rm "$image_name" \
  cargo run --locked --quiet --package slide-helper-protocol --bin export-types \
  > "$temporary_file"

if [ "$mode" = "--check" ]; then
  if ! cmp -s "$temporary_file" "$destination"; then
    echo "generated TypeScript protocol is stale; run ./scripts/generate-protocol-types.sh" >&2
    diff -u "$destination" "$temporary_file" || true
    exit 1
  fi
  echo "generated TypeScript protocol is current"
else
  mkdir -p "$(dirname -- "$destination")"
  mv "$temporary_file" "$destination"
  echo "updated packages/protocol/src/generated.ts"
fi
