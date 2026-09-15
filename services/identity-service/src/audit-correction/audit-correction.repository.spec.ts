import type { PrismaService } from '../prisma/prisma.service';
import {
  AuditCorrectionCommandRepository,
  COMMAND_LOCK_NAMESPACE,
  commandLockKey,
} from './audit-correction.repository';

/**
 * The command lock seam (AUD-003 correction): which lock, on which key, through
 * which client. The real lock is proven against PostgreSQL in
 * `test/audit-correction.int-spec.ts`.
 */

const ACTOR = 'USR-PLATFORM-ADMIN';
const KEY = 'corr-key-0001';
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A client whose every member throws unless the test names it. */
function strictClient(members: Record<string, unknown>): unknown {
  return new Proxy(members, {
    get(target, property) {
      if (typeof property === 'string' && property in target) return target[property];
      if (property === 'then') return undefined;
      throw new Error(`unexpected client member: ${String(property)}`);
    },
  });
}

function repositoryWith(client: unknown): AuditCorrectionCommandRepository {
  return new AuditCorrectionCommandRepository({ client } as unknown as PrismaService);
}

describe('commandLockKey', () => {
  it('is a stable, versioned signed 64-bit key', () => {
    expect(COMMAND_LOCK_NAMESPACE).toBe('identity-service:audit_correction_command:v1');
    // Pinned: instances on either side of a deploy must derive the same key to
    // exclude each other, so an encoding change must be a deliberate new version.
    expect(commandLockKey(ACTOR, KEY)).toBe(406633924392632648n);
    expect(commandLockKey('a', 'b')).toBe(5040188555954829833n);
    expect(commandLockKey(ACTOR, KEY)).toBe(commandLockKey(ACTOR, KEY));

    for (const [actor, key] of [
      [ACTOR, KEY],
      ['x', 'y'],
      ['USR-0000000000', '~'.repeat(255)],
    ] as const) {
      const lockKey = commandLockKey(actor, key);
      expect(typeof lockKey).toBe('bigint');
      expect(lockKey >= INT64_MIN && lockKey <= INT64_MAX).toBe(true);
    }
  });

  it.each<[string, [string, string], [string, string]]>([
    ['a moved separator', ['a:b', 'c'], ['a', 'b:c']],
    ['a moved boundary', ['ab', 'c'], ['a', 'bc']],
    ['swapped actor and key', ['alpha', 'beta'], ['beta', 'alpha']],
    ['an embedded JSON quote', ['a","b', 'c'], ['a', 'b","c']],
    ['an embedded NUL', ['a\u0000b', 'c'], ['a', 'b\u0000c']],
    ['an empty actor', ['', 'ab'], ['a', 'b']],
  ])('keeps tuples that differ only by %s apart', (_label, left, right) => {
    expect(commandLockKey(...left)).not.toBe(commandLockKey(...right));
  });
});

describe('AuditCorrectionCommandRepository.lockCommandKey', () => {
  it('takes a transaction-scoped advisory lock through the transaction, with the key bound', async () => {
    const executeRaw = jest.fn(async () => 1);
    const tx = strictClient({ $executeRaw: executeRaw });
    // The ambient client must not be touched: a lock outside the transaction
    // would not be released by its commit.
    const repository = repositoryWith(strictClient({}));

    await repository.lockCommandKey(tx as never, ACTOR, KEY);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    // A tagged template: the statement text and the key travel separately.
    expect(Array.isArray(strings) && 'raw' in strings).toBe(true);
    expect([...strings]).toEqual(['SELECT pg_advisory_xact_lock(', ')']);
    expect(values).toEqual([commandLockKey(ACTOR, KEY)]);
    expect(strings.join('')).not.toContain(ACTOR);
    expect(strings.join('')).not.toContain(KEY);
  });
});

describe('AuditCorrectionCommandRepository.find', () => {
  const row = {
    actorId: ACTOR,
    idempotencyKey: KEY,
    requestHash: 'a'.repeat(64),
    targetId: '01JAUDIT0000000000000001',
    eventId: '01JEVENT00000000000000C11',
    responseBody: { status: 'ACCEPTED' },
  };
  const where = { where: { actorId_idempotencyKey: { actorId: ACTOR, idempotencyKey: KEY } } };

  it('reads through the transaction it is given', async () => {
    const findUnique = jest.fn(async () => row);
    const tx = strictClient({ auditCorrectionCommand: { findUnique } });
    const repository = repositoryWith(strictClient({}));

    await expect(repository.find(ACTOR, KEY, tx as never)).resolves.toMatchObject({
      actorId: ACTOR,
      idempotencyKey: KEY,
    });
    expect(findUnique).toHaveBeenCalledWith(where);
  });

  it('reads through the ambient client when no transaction is given', async () => {
    const findUnique = jest.fn(async () => null);
    const repository = repositoryWith(strictClient({ auditCorrectionCommand: { findUnique } }));

    await expect(repository.find(ACTOR, KEY)).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledWith(where);
  });
});
