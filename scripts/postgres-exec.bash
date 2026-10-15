#!/bin/bash
# -----------------------------------------------------------------------------
# Runs one of infrastructure/docker/postgres/lib/*.bash in the compose postgres
# container, handing it every POSTGRES_STATEMENT_TIMEOUT_MS_<SVC> the calling
# shell exports (Codex r4 on #268, F4).
#
#   bash scripts/postgres-exec.bash <lib script> [args…]
#
# `docker compose exec` starts the process with the container's environment —
# the compose file's and .env.migrator's values — and nothing of the shell's,
# so `POSTGRES_STATEMENT_TIMEOUT_MS_FLEET=70000 pnpm db:privilege-split fleet`
# found the variable unset in the container and did nothing, successfully. An
# exported value now wins over the container's; unset, the container's stands.
# -----------------------------------------------------------------------------
set -euo pipefail

script="${1:?usage: postgres-exec.bash <lib script> [args…]}"
shift

forwarded=()
for name in ${!POSTGRES_STATEMENT_TIMEOUT_MS_@}; do
  forwarded+=(--env "${name}=${!name}")
done

exec docker compose exec -T "${forwarded[@]}" postgres \
  bash "/docker-entrypoint-initdb.d/lib/${script}" "$@"
