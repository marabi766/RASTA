// -----------------------------------------------------------------------------
// The database settings a script's refusal may name (#385 r4).
//
// A check that reads `.env`-style text meets names that came from that text. A
// refusal names one only when it is registered: a `DATABASE_URL_<SERVICE>`
// (or its migrator pair) of a service that owns a database — one with a
// `services/<name>-service/prisma` directory, the list `@rasta/config` keeps as
// DATABASE_SERVICES. Any other name is the input's own, and is replaced by a
// placeholder or a count.
// -----------------------------------------------------------------------------
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `ASSET`, `IDENTITY`, …: each service with a Prisma schema, as its variables spell it. */
export function databaseServiceStems(root = ROOT) {
  const services = join(root, 'services');
  return readdirSync(services)
    .filter((name) => name.endsWith('-service') && existsSync(join(services, name, 'prisma')))
    .map((name) => name.slice(0, -'-service'.length).replaceAll('-', '_').toUpperCase())
    .sort();
}

/** Every registered database setting name: runtime URL, migrator URL, migrator password. */
export function registeredDatabaseSettings(stems = databaseServiceStems()) {
  return new Set(
    stems.flatMap((stem) => [
      `DATABASE_URL_${stem}`,
      `DATABASE_URL_${stem}_MIGRATOR`,
      `POSTGRES_PASSWORD_${stem}_MIGRATOR`,
    ]),
  );
}

/** What a refusal says in place of a `DATABASE_URL_*` name no service owns. */
export const UNREGISTERED_DATABASE_URL = 'a DATABASE_URL_* named for no service';
