import { runWithContext, type RequestContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';
import {
  assertDistinctActors,
  compareActors,
  currentActor,
  sameActor,
  type ActorComparison,
  type ActorIdentity,
} from './separation-of-duties';

/**
 * The comparison every separation-of-duties rule uses (#188).
 *
 * One person can carry two user ids — the platform id on one token, the IdP
 * subject (no `rasta_uid`) or a second platform id on another — so the rows
 * below are mostly about one person who looks like two. Each must come out
 * SAME, or UNKNOWN when the record cannot tell; never DISTINCT.
 */

const ISSUER = 'http://keycloak.test/realms/rasta';
const SUBJECT = 'kc-subject-alice';
const OTHER_ISSUER = 'https://auth.renamed.test/realms/rasta';

const actor = (
  userId: string,
  issuer: string | null = ISSUER,
  subject: string | null = SUBJECT,
): ActorIdentity => ({ userId, issuer, subject });

describe('compareActors', () => {
  const cases: [string, ActorIdentity, ActorIdentity, ActorComparison][] = [
    // One person, two tokens.
    ['two platform ids, one issuer+subject', actor('USR_U1'), actor('USR_U2'), 'SAME'],
    [
      'with rasta_uid vs without (the userId is the subject)',
      actor('USR_U1'),
      actor(SUBJECT),
      'SAME',
    ],
    ['the same platform id', actor('USR_U1'), actor('USR_U1'), 'SAME'],
    // A record written before issuer+subject were stored.
    [
      'an old row holding the subject as its userId',
      actor('USR_U1'),
      actor(SUBJECT, null, null),
      'SAME',
    ],
    [
      'an old row holding the same platform id',
      actor('USR_U1'),
      actor('USR_U1', null, null),
      'SAME',
    ],
    ['an old row with another userId', actor('USR_U1'), actor('USR_U9', null, null), 'UNKNOWN'],
    [
      'both rows old, different userIds',
      actor('USR_U1', null, null),
      actor('USR_U2', null, null),
      'UNKNOWN',
    ],
    ['issuer known, subject not', actor('USR_U1'), actor('USR_U2', ISSUER, null), 'UNKNOWN'],
    ['blank values count as absent', actor('USR_U1'), actor('USR_U2', ' ', ''), 'UNKNOWN'],
    // Two people.
    [
      'two people, both identities recorded',
      actor('USR_U1'),
      actor('USR_U2', ISSUER, 'kc-subject-bob'),
      'DISTINCT',
    ],
    // Across an issuer change (#192 review): a subject is unique only within its
    // issuer, and no alias mapping exists, so a different issuer is never proof.
    [
      'another issuer, the same subject (the issuer URL changed)',
      actor('USR_U1'),
      actor('USR_U2', OTHER_ISSUER, SUBJECT),
      'UNKNOWN',
    ],
    [
      'another issuer, another subject: still not provably another person',
      actor('USR_U1'),
      actor('USR_U2', OTHER_ISSUER, 'kc-subject-bob'),
      'UNKNOWN',
    ],
    [
      'another issuer, but the same platform id',
      actor('USR_U1'),
      actor('USR_U1', OTHER_ISSUER, 'kc-subject-bob'),
      'SAME',
    ],
    [
      'blank userId on one side is not provably distinct',
      actor('USR_U1'),
      actor('', ISSUER, 'kc-subject-bob'),
      'UNKNOWN',
    ],
  ];

  it.each(cases)('%s → %s', (_name, a, b, expected) => {
    expect(compareActors(a, b)).toBe(expected);
    // Symmetric: who is "a" never changes the answer.
    expect(compareActors(b, a)).toBe(expected);
    // sameActor fails closed: only DISTINCT is "not the same person".
    expect(sameActor(a, b)).toBe(expected !== 'DISTINCT');
  });
});

describe('assertDistinctActors', () => {
  it('passes two provably different people', () => {
    expect(() =>
      assertDistinctActors(actor('USR_U1'), actor('USR_U2', ISSUER, 'kc-subject-bob'), 'x'),
    ).not.toThrow();
  });

  it('SAME → 403 FORBIDDEN, in the rule’s own words and nothing else', () => {
    const error = catchError(() =>
      assertDistinctActors(actor('USR_U1'), actor('USR_U2'), 'the approver is not the proposer'),
    );
    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: 'Separation of duties: the approver is not the proposer',
    });
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/USR_U|kc-subject/);
  });

  it('UNKNOWN → 422 ACTOR_IDENTITY_UNKNOWN: refused, never assumed', () => {
    const error = catchError(() =>
      assertDistinctActors(
        actor('USR_U1'),
        actor('USR_U9', null, null),
        'the approver is not the author',
      ),
    );
    expect(error).toMatchObject({ code: 'ACTOR_IDENTITY_UNKNOWN', status: 422 });
    expect(error.message).toContain('the approver is not the author');
    expect(error.message).not.toMatch(/USR_U|kc-subject/);
  });
});

describe('currentActor', () => {
  const base: RequestContext = {
    correlationId: 'COR_1',
    requestId: 'REQ_1',
    organizationIds: [],
    roles: [],
    authType: 'USER',
    startedAt: 0,
  };

  it('reads the user id, issuer and subject from the context', () => {
    const read = runWithContext(
      { ...base, userId: 'USR_U1', issuer: ISSUER, subject: SUBJECT, platformUserId: true },
      () => currentActor({ requirePlatformUserId: true }),
    );
    expect(read).toEqual({ userId: 'USR_U1', issuer: ISSUER, subject: SUBJECT });
    expect(Object.isFrozen(read)).toBe(true);
  });

  it('records a missing issuer as unknown, not as a value', () => {
    const read = runWithContext({ ...base, userId: 'USR_U1', subject: SUBJECT }, () =>
      currentActor(),
    );
    expect(read).toEqual({ userId: 'USR_U1', issuer: null, subject: SUBJECT });
  });

  it('refuses a token without rasta_uid when asked to', () => {
    const error = catchError(() =>
      runWithContext(
        { ...base, userId: SUBJECT, issuer: ISSUER, subject: SUBJECT, platformUserId: false },
        () => currentActor({ requirePlatformUserId: true }),
      ),
    );
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(error.message).not.toContain(SUBJECT);
  });

  it.each([
    ['a service caller', { ...base, authType: 'SERVICE' as const, callerService: 'fleet-service' }],
    ['an anonymous request', { ...base, authType: 'ANONYMOUS' as const }],
    ['a user context with no userId', { ...base }],
  ])('refuses %s: a separation of duties is between people', (_name, context) => {
    expect(catchError(() => runWithContext(context, () => currentActor()))).toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

function catchError(fn: () => unknown): RastaError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RastaError) return error;
    throw error;
  }
  throw new Error('expected a RastaError');
}
