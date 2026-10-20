import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

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
 * it) and `psql` on the path. The URL is passed in the child's environment,
 * never on its command line, and nothing here is logged.
 */

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
  const url = new URL(requiredEnv('WEB_E2E_CONTRACT_DATABASE_URL'));
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
