import { ID_PREFIXES, type IdPrefix } from '@rasta/contracts';

/**
 * Assertions that encode platform invariants, so a test reads as the rule it
 * is protecting rather than as a comparison.
 */

const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface LedgerEntryLike {
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: string | bigint;
  currency: string;
  journalId?: string;
}

export interface ApiErrorLike {
  code?: string;
  correlationId?: string;
  message?: string;
}

/**
 * Asserts a set of ledger entries balances per currency.
 *
 * The single most important invariant in the platform: an unbalanced journal
 * means money was created or destroyed.
 */
export function expectBalancedJournal(entries: readonly LedgerEntryLike[]): void {
  const byCurrency = new Map<string, bigint>();

  for (const entry of entries) {
    const amount = BigInt(entry.amountMinor);
    if (amount <= 0n) {
      throw new Error(
        `Ledger entry amount must be positive (direction carries the sign); got ${amount}`,
      );
    }
    const signed = entry.direction === 'DEBIT' ? amount : -amount;
    byCurrency.set(entry.currency, (byCurrency.get(entry.currency) ?? 0n) + signed);
  }

  const unbalanced = [...byCurrency.entries()].filter(([, delta]) => delta !== 0n);
  if (unbalanced.length > 0) {
    const detail = unbalanced.map(([currency, delta]) => `${currency}: ${delta}`).join(', ');
    throw new Error(
      `Journal does not balance. Debits minus credits should be zero per currency; got ${detail}`,
    );
  }
}

/** Asserts an identifier is a well-formed prefixed ULID for the given type. */
export function expectValidId(value: string, prefix: IdPrefix): void {
  const [head, ...rest] = value.split('_');
  const body = rest.join('_');

  if (head !== prefix) {
    throw new Error(`Expected identifier prefix "${prefix}" but got "${head}" in "${value}"`);
  }
  if (!ULID_BODY.test(body)) {
    throw new Error(`Identifier "${value}" does not carry a valid ULID body`);
  }
}

/**
 * Asserts an identifier carries no organizational or geographic marker.
 *
 * ADR-012: an asset transferred between organizations keeps its identity, so
 * an id that encodes its owner is a design error, not a cosmetic one.
 */
export function expectOrganizationAgnosticId(value: string): void {
  const forbidden = ['YAZD', 'DEHYARI', 'IRAN', 'PROVINCE', 'ORG-', 'VILLAGE'];
  const upper = value.toUpperCase();

  const prefixes = Object.values(ID_PREFIXES) as string[];
  const body = prefixes.includes(upper.split('_')[0] ?? '')
    ? upper.slice((upper.split('_')[0] ?? '').length + 1)
    : upper;

  for (const marker of forbidden) {
    if (body.includes(marker)) {
      throw new Error(
        `Identifier "${value}" encodes "${marker}". Identifiers must be organization-agnostic (ADR-012).`,
      );
    }
  }
}

/**
 * Asserts an error response carries the platform shape and leaks nothing.
 *
 * The negative checks matter as much as the positive one: a stack trace or a
 * table name in a client-facing error is an information disclosure.
 */
export function expectApiError(body: ApiErrorLike, expectedCode: string): void {
  if (body.code !== expectedCode) {
    throw new Error(`Expected error code "${expectedCode}" but got "${body.code}"`);
  }
  if (!body.correlationId) {
    throw new Error('Error response must carry a correlationId so support can trace it');
  }

  const message = body.message ?? '';
  const leaks = [
    { pattern: /\bat\s+\w+\s+\(/, what: 'a stack trace' },
    { pattern: /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i, what: 'SQL' },
    { pattern: /prisma|postgres|postgresql:\/\//i, what: 'database internals' },
    { pattern: /[A-Za-z]:\\|\/home\/|\/usr\/src/, what: 'a filesystem path' },
  ];

  for (const leak of leaks) {
    if (leak.pattern.test(message)) {
      throw new Error(`Error message leaks ${leak.what}: "${message}"`);
    }
  }
}

/**
 * Asserts a cross-tenant read returned 404 rather than 403.
 *
 * A 403 confirms the resource exists, which lets an attacker enumerate another
 * organization's assets by identifier. See docs/09-security-architecture.md.
 */
export function expectTenantIsolated(status: number, body?: ApiErrorLike): void {
  if (status === 403) {
    throw new Error(
      'Cross-tenant access returned 403, which confirms the resource exists. ' +
        'It must return 404 so identifiers cannot be enumerated.',
    );
  }
  if (status !== 404) {
    throw new Error(`Cross-tenant access returned ${status}; expected 404`);
  }
  if (body?.code && body.code !== 'NOT_FOUND') {
    throw new Error(`Cross-tenant access returned code "${body.code}"; expected NOT_FOUND`);
  }
}
