#!/bin/bash
# -----------------------------------------------------------------------------
# supplier-service privilege split — now one case of the generic split (D-045).
#
#   pnpm db:supplier-privilege-split          (an existing local cluster)
#   bash .../supplier-privilege-split.bash [database]   (any cluster, as superuser)
#
# supplier-service was the first service whose runtime role was made to own
# nothing (Codex review of #120, findings 2 and round-2 1–2). The mechanism now
# lives in lib/service-privilege-split.bash, shared by every service in
# PRIVILEGE_SPLIT_SERVICES; supplier-service uses it in `migration` grants mode,
# because its own migration `20260926130000_supplier_runtime_privileges` grants
# each table exactly what the service needs — less than DML on its frozen,
# append-only and insert-only performance tables.
#
# This file keeps the entry points that already exist —
# `split_supplier_privileges` and `pnpm db:supplier-privilege-split` — and
# `scripts/supplier-privilege-split.pg.test.mjs`, which runs this upgrade on a
# database seeded the way main left it before the split.
#
# Upgrading an existing database, in this order:
#
#   1. this script (as the superuser);
#   2. `pnpm --filter @rasta/supplier-service db:migrate` with
#      DATABASE_URL_SUPPLIER_MIGRATOR set — it applies the grants.
#
# Between 1 and 2 the service has no table grants and cannot serve; it refuses
# to start as an owner either way (PrismaService.assertRuntimeRole).
# -----------------------------------------------------------------------------

# shellcheck source=service-privilege-split.bash
source "$(dirname "${BASH_SOURCE[0]}")/service-privilege-split.bash"

# split_supplier_privileges [database]
split_supplier_privileges() {
  split_service_privileges supplier "${1:-rasta_supplier}" migration
}

# Run directly (not sourced): resolve passwords exactly as the bootstrap does,
# then split the named database.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  : "${POSTGRES_USER:?POSTGRES_USER must name the superuser}"
  # shellcheck source=role-passwords.bash
  source "$(dirname "${BASH_SOURCE[0]}")/role-passwords.bash"
  resolve_role_passwords || exit 1
  echo "==> supplier-service privilege split"
  split_supplier_privileges "${1:-rasta_supplier}"
fi
