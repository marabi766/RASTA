import { storedActor, storedIdentityOf } from './stable-actor';

describe('what a row keeps of a person (#188)', () => {
  it('stores the verified issuer and subject together', () => {
    expect(
      storedIdentityOf({ userId: 'USR_1', issuer: 'http://issuer.invalid', subject: 'sub-1' }),
    ).toEqual({ issuer: 'http://issuer.invalid', subject: 'sub-1' });
  });

  it.each([
    ['neither', null, null],
    ['an issuer without a subject', 'http://issuer.invalid', null],
    ['a subject without an issuer', null, 'sub-1'],
  ])('stores neither for %s: half a pair proves nothing', (_label, issuer, subject) => {
    expect(storedIdentityOf({ userId: 'USR_1', issuer, subject })).toEqual({
      issuer: null,
      subject: null,
    });
  });

  it('reads a row back as a person, an unrecorded pair as unknown (null), never as a guess', () => {
    expect(storedActor('USR_1', 'http://issuer.invalid', 'sub-1')).toEqual({
      userId: 'USR_1',
      issuer: 'http://issuer.invalid',
      subject: 'sub-1',
    });
    expect(storedActor('USR_1', undefined, undefined)).toEqual({
      userId: 'USR_1',
      issuer: null,
      subject: null,
    });
    expect(storedActor('USR_1', null, 'sub-1')).toEqual({
      userId: 'USR_1',
      issuer: null,
      subject: 'sub-1',
    });
  });
});
