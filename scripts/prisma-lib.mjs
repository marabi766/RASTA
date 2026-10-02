// -----------------------------------------------------------------------------
// The pure parts of scripts/prisma.mjs, kept here so they can be tested without
// running Prisma.
// -----------------------------------------------------------------------------

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The SQL that takes the migration ledger away from a service's runtime role
 * after a migration run (D-045), or null when there is nothing to take: no
 * migrator URL, no runtime URL, or both name the same role (a service not yet
 * split, whose runtime role owns the ledger anyway).
 *
 * The ledger is `_prisma_migrations` in the migrator URL's `schema` (Prisma's
 * own rule; `public` when absent). Identifiers are quoted, and refused unless
 * they are plain lowercase names — they come from configuration, and they are
 * interpolated into SQL.
 */
export function ledgerRevoke({ migratorUrl, runtimeUrl }) {
  if (!migratorUrl || !runtimeUrl) return null;
  const migrator = new URL(migratorUrl);
  const runtime = decodeURIComponent(new URL(runtimeUrl).username);
  if (decodeURIComponent(migrator.username) === runtime) return null;
  const schema = migrator.searchParams.get('schema') ?? 'public';
  for (const [what, name] of [
    ['runtime role', runtime],
    ['schema', schema],
  ]) {
    if (!IDENTIFIER.test(name)) throw new Error(`the ${what} "${name}" is not a plain identifier`);
  }
  return (
    'DO $$ BEGIN\n' +
    `  IF to_regclass('"${schema}"."_prisma_migrations"') IS NOT NULL THEN\n` +
    `    REVOKE ALL ON TABLE "${schema}"."_prisma_migrations" FROM "${runtime}";\n` +
    '  END IF;\n' +
    'END $$;\n'
  );
}
