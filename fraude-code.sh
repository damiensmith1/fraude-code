#!/bin/bash
#
# Resolves its own real location (even through a symlink, e.g. a global
# `fraude` command) so it works regardless of the caller's cwd.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null && pwd)"

bun run --env-file="$DIR/.env" "$DIR/app/main.ts" "$@"
