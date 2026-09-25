#!/bin/bash
# -----------------------------------------------------------------------------
# The only way the development realm (rasta-realm.json) may be loaded (L1-05).
#
# That realm is a fixture, not a configuration: it enables the resource-owner
# password grant on two clients and seeds users — a SYSTEM_ADMIN among them —
# with permanent passwords that sit in this repository. Imported anywhere but a
# developer's machine or a throwaway CI job, it is a platform administrator
# account whose password is public.
#
# Two gates, both required:
#
#   1. Keycloak's development mode. `start-dev` is Keycloak's own "not for
#      production" mode (plain HTTP, relaxed hostname); `start` — production —
#      is refused here outright.
#   2. An explicit opt-in: RASTA_KEYCLOAK_DEV_REALM=allow. Nothing sets it by
#      default; docker-compose.yml and the CI jobs set it where they start
#      their disposable Keycloak.
#
# Only then is RASTA_DEV_REALM_GATE=true exported. The realm file's `enabled`
# field is the placeholder `${RASTA_DEV_REALM_GATE}`, so mounting the file into
# a Keycloak import directory by any other route leaves it unresolved, and
# Keycloak refuses to start ("only true or false recognized") instead of
# importing it.
#
# Usage (as the container command, with bash as the entrypoint):
#   bash /opt/keycloak/data/import/dev-realm-gate.sh start-dev --import-realm
# -----------------------------------------------------------------------------
set -euo pipefail

refuse() {
  echo "dev-realm-gate: refusing to start Keycloak — $1" >&2
  echo "dev-realm-gate: the development realm holds public passwords for a SYSTEM_ADMIN;" >&2
  echo "dev-realm-gate: it may only be loaded by a disposable development or CI Keycloak." >&2
  exit 64
}

if [[ "${1:-}" != "start-dev" ]]; then
  refuse "the command is '${1:-<none>}', not start-dev (Keycloak's development mode)"
fi

if [[ "${RASTA_KEYCLOAK_DEV_REALM:-}" != "allow" ]]; then
  refuse "RASTA_KEYCLOAK_DEV_REALM is not 'allow'"
fi

export RASTA_DEV_REALM_GATE=true
exec "${KEYCLOAK_LAUNCHER:-/opt/keycloak/bin/kc.sh}" "$@"
