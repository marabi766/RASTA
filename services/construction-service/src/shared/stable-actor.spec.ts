import { compareActors } from '@rasta/nest-common';
import { storedActor, storedIdentityOf } from './stable-actor';

describe('stable actor (#188)', () => {
  const ISSUER = 'http://test.invalid/realms/rasta';

  it('stores the issuer and subject together, or neither', () => {
    expect(storedIdentityOf({ userId: 'USR_1', issuer: ISSUER, subject: 'sub-1' })).toEqual({
      issuer: ISSUER,
      subject: 'sub-1',
    });
    expect(storedIdentityOf({ userId: 'USR_1', issuer: null, subject: 'sub-1' })).toEqual({
      issuer: null,
      subject: null,
    });
    expect(storedIdentityOf({ userId: 'USR_1', issuer: ISSUER, subject: null })).toEqual({
      issuer: null,
      subject: null,
    });
  });

  it('reads a row back as an actor the shared comparison understands', () => {
    const caller = { userId: 'USR_2', issuer: ISSUER, subject: 'sub-1' };
    // One person, two user ids.
    expect(compareActors(storedActor('USR_1', ISSUER, 'sub-1'), caller)).toBe('SAME');
    // Another person.
    expect(compareActors(storedActor('USR_1', ISSUER, 'sub-9'), caller)).toBe('DISTINCT');
    // A row older than the record: unknown, never "another person".
    expect(compareActors(storedActor('USR_1', null, null), caller)).toBe('UNKNOWN');
    expect(compareActors(storedActor('USR_1', undefined, undefined), caller)).toBe('UNKNOWN');
  });
});
