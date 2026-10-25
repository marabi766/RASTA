import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
// The repository's one reader of configured URLs (#385): its refusal is a
// fixed text, never the value. Imported from source, as the scripts do — a
// plain CommonJS file, so the fixture needs no build of @rasta/config.
import { readUrl } from '../../../packages/config/src/url-reader.js';

/**
 * A fresh contract for one live scenario — `fixtures/contract-draft.sql`, run
 * with ids chosen here, for this attempt (PR 342 review 1, finding 2).
 *
 * contract-service has no route that creates a contract (one is drafted only
 * from TENDER_AWARDED, ADR-068 § 3), so a scenario cannot ask the stack for one
 * the way `provisioned-people.ts` asks identity-service for a person. Instead
 * each test writes its own rows, as contract-service's **runtime role**, through
 * every guard its database keeps — the same route the "Portal in a browser" job
 * loads `contract-statements.sql` by. A retry of a test writes new ids, so it
 * runs against new state and never meets what an earlier attempt signed or
 * cancelled.
 *
 * Needs `WEB_E2E_CONTRACT_DATABASE_URL` (the runtime role's URL; the job sets
 * it, and README.md says how to run it locally) and `psql` on the path. The URL
 * is passed in the child's environment, never on its command line, and nothing
 * here is logged. Neither refusal repeats anything of it (#385 r6): a URL that
 * does not parse is refused by the shared reader, and a psql that fails is
 * reported by its exit code alone — its stderr, which names the connection's
 * user, is captured and dropped.
 */

const DATABASE_URL = 'WEB_E2E_CONTRACT_DATABASE_URL';

/** What a failed psql is reported with: a fixed text and its exit code. */
export const PSQL_FAILED = (code: number | string): string =>
  `psql could not write the contract fixture with ${DATABASE_URL} (exit ${code}); ` +
  'its output is withheld, it may repeat the connection';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`The live contract command scenarios require ${name}`);
  return value;
}

export interface ContractParties {
  readonly employer: string;
  readonly contractor: string;
  /** Minor units (rials), a decimal string. */
  readonly amountMinor: string;
}

function write(parties: ContractParties, signed: boolean): string {
  const id = `CTR_E2E_${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
  const url = readUrl(requiredEnv(DATABASE_URL), {
    refusal: `${DATABASE_URL} cannot be read as a URL; its value is not repeated`,
  });
  let failed: number | string | undefined;
  try {
    execFileSync(
      'psql',
      [
        '-X',
        '-q',
        '-v',
        `id=${id}`,
        '-v',
        `employer=${parties.employer}`,
        '-v',
        `contractor=${parties.contractor}`,
        '-v',
        `amount=${parties.amountMinor}`,
        '-v',
        `signed=${signed}`,
        '-f',
        join(__dirname, 'fixtures', 'contract-draft.sql'),
      ],
      {
        env: {
          ...process.env,
          PGHOST: url.hostname,
          PGPORT: url.port || '5432',
          PGDATABASE: url.pathname.replace(/^\//, ''),
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
  } catch (error) {
    // Nothing of the error is kept: its message and `stderr` carry psql's text.
    const status = (error as { status?: unknown }).status;
    failed = typeof status === 'number' ? status : 'unknown';
  }
  if (failed !== undefined) throw new Error(PSQL_FAILED(failed));
  return id;
}

/** A draft nobody has signed yet; its id. */
export function draftContract(parties: ContractParties): string {
  return write(parties, false);
}

/** A contract both sides have signed (the employer under POL_E2E_SIGNATURE); its id. */
export function signedContract(parties: ContractParties): string {
  return write(parties, true);
}
