import { resolve } from 'node:path';
import { findKeyReaders } from '@rasta/testing';

/**
 * Every read, compare and search of a username or an email goes through the login key (FU-084 r2,
 * #723 r1 F1): the unique indexes compare `user_login_key`, so a reader that compares anything else
 * misses a legacy `Ali` or a typed `ali۱`. A reader not listed here fails until it is reviewed and
 * listed with what makes it compare by the key.
 */
const READERS: Record<string, readonly string[]> = {
  'src/identity/identity.repository.ts#IdentityRepository.findUserByUsernameOrEmail#sql': [
    'user_login_key(username) = user_login_key(${username}::text)',
    'user_login_key(email) = user_login_key(${email}::text)',
  ],
  'src/identity/identity.repository.ts#IdentityRepository.findUserIdByUsername#sql': [
    'user_login_key(username) = user_login_key(${username}::text)',
  ],
  'src/identity/identity.repository.ts#userSearchArms#filter': [
    'uniqueTextSearchKey(q, { caseFold: true })',
    '{ username: { contains: login,',
    '{ email: { contains: login,',
    'const login = likeLiteral(loginKey);',
    '/^[!-~]+$/.test(loginKey)',
  ],
  'src/keycloak/keycloak.client.ts#KeycloakAdminClient.findAccountByUsername#compare': [
    'foldAsciiCase(account.username) === foldAsciiCase(username)',
  ],
};

describe('every reader of a login name compares its key (FU-084 r2)', () => {
  const sites = findKeyReaders({
    root: resolve(__dirname, '../..'),
    fields: ['username', 'email'],
    columns: ['username', 'email'],
  });

  it('finds exactly the reviewed readers', () => {
    expect(sites.map((site) => `${site.file}#${site.reader}#${site.kind}`)).toEqual(
      Object.keys(READERS).sort(),
    );
  });

  it.each(Object.entries(READERS))('%s compares by the key', (key, fragments) => {
    const site = sites.find(
      (candidate) => `${candidate.file}#${candidate.reader}#${candidate.kind}` === key,
    );
    for (const fragment of fragments) expect(site?.body).toContain(fragment);
  });
});
