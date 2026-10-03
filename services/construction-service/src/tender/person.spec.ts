import { runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  comparePeople,
  currentPerson,
  personByUserId,
  storedIdentity,
  type PersonRef,
} from './person';

/**
 * The one place construction decides whether two user ids are one person (AWARDER_NOT_EVALUATOR
 * today). Each case is checked in both orders: a comparison that depends on which record is on
 * the left is a comparison that can be dodged.
 */

const ISSUER = 'https://idp.example/realms/rasta';

const full = (userId: string, subject: string, issuer = ISSUER): PersonRef => ({
  userId,
  issuer,
  subject,
});

function both(a: PersonRef, b: PersonRef) {
  return [comparePeople(a, b), comparePeople(b, a)];
}

describe('comparePeople', () => {
  it('is SAME for the same user id, however little else is known', () => {
    expect(both(personByUserId('U1'), personByUserId('U1'))).toEqual(['SAME', 'SAME']);
    expect(both(full('U1', 'sub-1'), personByUserId('U1'))).toEqual(['SAME', 'SAME']);
  });

  it('is SAME when one side’s user id is the other side’s subject: one person with two ids', () => {
    // The token that carries a platform id (U2) and the token that does not (userId = the subject).
    expect(both(full('U2', 'sub-1'), personByUserId('sub-1'))).toEqual(['SAME', 'SAME']);
    expect(both(personByUserId('sub-1'), full('U2', 'sub-1'))).toEqual(['SAME', 'SAME']);
  });

  it('is DISTINCT for two people of one issuer with different subjects', () => {
    expect(both(full('U1', 'sub-1'), full('U2', 'sub-2'))).toEqual(['DISTINCT', 'DISTINCT']);
  });

  it('is SAME for one subject of one issuer behind two platform ids', () => {
    expect(both(full('U1', 'sub-1'), full('U2', 'sub-1'))).toEqual(['SAME', 'SAME']);
  });

  it('is UNKNOWN across issuers: a subject is unique only within its issuer', () => {
    const other = 'https://idp.other/realms/rasta';
    expect(both(full('U1', 'sub-1'), full('U2', 'sub-1', other))).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(both(full('U1', 'sub-1'), full('U2', 'sub-2', other))).toEqual(['UNKNOWN', 'UNKNOWN']);
  });

  it('is UNKNOWN when user ids differ and a record holds a user id alone', () => {
    expect(both(personByUserId('U1'), personByUserId('U2'))).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(both(full('U1', 'sub-1'), personByUserId('U2'))).toEqual(['UNKNOWN', 'UNKNOWN']);
  });

  it('treats a half pair as no pair', () => {
    const half: PersonRef = { userId: 'U1', issuer: ISSUER, subject: null };
    expect(both(half, full('U2', 'sub-2'))).toEqual(['UNKNOWN', 'UNKNOWN']);
    const other: PersonRef = { userId: 'U1', issuer: null, subject: 'sub-1' };
    expect(both(other, full('U2', 'sub-2'))).toEqual(['UNKNOWN', 'UNKNOWN']);
  });
});

describe('currentPerson', () => {
  const as = <T>(extra: Record<string, unknown>, fn: () => T): T =>
    runWithContext(
      {
        requestId: 'req-1',
        correlationId: 'corr-1',
        authType: 'USER',
        roles: [],
        startedAt: 0,
        userId: 'U1',
        ...extra,
      } as unknown as RequestContext,
      fn,
    );

  it('carries the pair when the context has the issuer and the subject', () => {
    expect(as({ issuer: ISSUER, subject: 'sub-1' }, () => currentPerson('U1'))).toEqual({
      userId: 'U1',
      issuer: ISSUER,
      subject: 'sub-1',
    });
  });

  it('carries only the subject when the context has no issuer: an identity not known is never invented', () => {
    expect(as({ subject: 'sub-1' }, () => currentPerson('U1'))).toEqual({
      userId: 'U1',
      issuer: null,
      subject: 'sub-1',
    });
  });

  it('carries only the issuer when the context has no subject, and nothing for an empty one', () => {
    expect(as({ issuer: ISSUER }, () => currentPerson('U1'))).toEqual({
      userId: 'U1',
      issuer: ISSUER,
      subject: null,
    });
    expect(as({ issuer: ISSUER, subject: '' }, () => currentPerson('U1'))).toEqual({
      userId: 'U1',
      issuer: ISSUER,
      subject: null,
    });
  });
});

describe('storedIdentity', () => {
  it('keeps the pair when there is one', () => {
    expect(storedIdentity(full('U1', 'sub-1'))).toEqual({ issuer: ISSUER, subject: 'sub-1' });
  });

  it('keeps neither of a half pair: both or neither, as the database has it', () => {
    expect(storedIdentity({ userId: 'U1', issuer: ISSUER, subject: null })).toEqual({
      issuer: null,
      subject: null,
    });
    expect(storedIdentity({ userId: 'U1', issuer: null, subject: 'sub-1' })).toEqual({
      issuer: null,
      subject: null,
    });
    expect(storedIdentity(personByUserId('U1'))).toEqual({ issuer: null, subject: null });
  });
});
