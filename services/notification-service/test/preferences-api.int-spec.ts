import request from 'supertest';
import { cleanup, newOrganizationId, newUserId } from './helpers';
import { internalToken, startApi, userToken, type ApiHarness } from './api-helpers';

/**
 * The preference API against the real application (`NTF-003`, ADR-054 § 5).
 *
 * Three endpoints, all self-only, all behind the global guards. What is
 * asserted here is the behaviour a settings screen depends on and a unit test
 * cannot show: that the guards really are closed, that `PUT` is a replacement
 * rather than a merge, that a refusal is a refusal, and that `effective` names
 * the rung that decided.
 */
describe('notification preferences API (real application)', () => {
  let api: ApiHarness;
  const organizations: string[] = [];

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  beforeAll(async () => {
    api = await startApi();
  }, 120_000);

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  }, 120_000);

  const get = (path: string, token: string) =>
    request(api.server).get(path).set('authorization', `Bearer ${token}`);
  const put = (path: string, token: string) =>
    request(api.server).put(path).set('authorization', `Bearer ${token}`);

  it('starts empty, which means every channel is at its default', async () => {
    const org = organization();
    const response = await get('/v1/preferences', userToken(newUserId(), org)).expect(200);
    expect(response.body).toEqual({ preferences: [] });
  });

  it('stores what was sent and reads it back', async () => {
    const org = organization();
    const token = userToken(newUserId(), org);

    await put('/v1/preferences', token)
      .send({
        preferences: [
          { scope: 'GLOBAL', channel: 'IN_APP', enabled: false },
          { scope: 'CATEGORY', scopeKey: 'EXPIRY', channel: 'IN_APP', enabled: true },
        ],
      })
      .expect(200);

    const response = await get('/v1/preferences', token).expect(200);
    expect(response.body.preferences).toEqual(
      expect.arrayContaining([
        { scope: 'GLOBAL', scopeKey: null, channel: 'IN_APP', enabled: false },
        { scope: 'CATEGORY', scopeKey: 'EXPIRY', channel: 'IN_APP', enabled: true },
      ]),
    );
    expect(response.body.preferences).toHaveLength(2);
  });

  // `PUT` means "this is what I have now". A row the caller left out has to
  // disappear, or a settings screen cannot remove anything.
  it('replaces rather than merges', async () => {
    const org = organization();
    const token = userToken(newUserId(), org);

    await put('/v1/preferences', token)
      .send({
        preferences: [
          { scope: 'GLOBAL', channel: 'IN_APP', enabled: false },
          { scope: 'RULE', scopeKey: 'maintenance.due', channel: 'IN_APP', enabled: false },
        ],
      })
      .expect(200);

    await put('/v1/preferences', token)
      .send({ preferences: [{ scope: 'GLOBAL', channel: 'IN_APP', enabled: true }] })
      .expect(200);

    const response = await get('/v1/preferences', token).expect(200);
    expect(response.body.preferences).toEqual([
      { scope: 'GLOBAL', scopeKey: null, channel: 'IN_APP', enabled: true },
    ]);
  });

  it('accepts an empty list, which clears everything back to the defaults', async () => {
    const org = organization();
    const token = userToken(newUserId(), org);

    await put('/v1/preferences', token)
      .send({ preferences: [{ scope: 'GLOBAL', channel: 'IN_APP', enabled: false }] })
      .expect(200);
    await put('/v1/preferences', token).send({ preferences: [] }).expect(200);

    expect((await get('/v1/preferences', token).expect(200)).body.preferences).toEqual([]);
  });

  describe('the shapes the API refuses', () => {
    it.each([
      [
        'a GLOBAL row with a key',
        { scope: 'GLOBAL', scopeKey: 'EXPIRY', channel: 'IN_APP', enabled: false },
      ],
      ['a CATEGORY row with no key', { scope: 'CATEGORY', channel: 'IN_APP', enabled: false }],
      ['a RULE row with no key', { scope: 'RULE', channel: 'IN_APP', enabled: false }],
      [
        'an unknown category',
        { scope: 'CATEGORY', scopeKey: 'NOT_A_CATEGORY', channel: 'IN_APP', enabled: false },
      ],
      ['an unknown scope', { scope: 'EVERYTHING', channel: 'IN_APP', enabled: false }],
      [
        'a channel the platform cannot deliver on',
        { scope: 'GLOBAL', channel: 'EMAIL', enabled: false },
      ],
    ])('refuses %s with 400', async (_label, preference) => {
      const token = userToken(newUserId(), organization());
      await put('/v1/preferences', token)
        .send({ preferences: [preference] })
        .expect(400);
    });

    // A rule key that does not exist is a 404 rather than a 400: the shape was
    // right, the thing named was not.
    it('refuses a RULE row naming a rule that does not exist', async () => {
      const token = userToken(newUserId(), organization());
      await put('/v1/preferences', token)
        .send({
          preferences: [
            { scope: 'RULE', scopeKey: 'nothing.like.this', channel: 'IN_APP', enabled: false },
          ],
        })
        .expect(404);
    });

    // Nothing is written unless every entry is allowed, so a body with one bad
    // row cannot leave a settings screen disagreeing with what was submitted.
    it('writes nothing when one entry in the body is refused', async () => {
      const org = organization();
      const token = userToken(newUserId(), org);

      await put('/v1/preferences', token)
        .send({ preferences: [{ scope: 'GLOBAL', channel: 'IN_APP', enabled: true }] })
        .expect(200);

      await put('/v1/preferences', token)
        .send({
          preferences: [
            { scope: 'GLOBAL', channel: 'IN_APP', enabled: false },
            { scope: 'RULE', scopeKey: 'nothing.like.this', channel: 'IN_APP', enabled: false },
          ],
        })
        .expect(404);

      expect((await get('/v1/preferences', token).expect(200)).body.preferences).toEqual([
        { scope: 'GLOBAL', scopeKey: null, channel: 'IN_APP', enabled: true },
      ]);
    });
  });

  describe('effective', () => {
    it('falls to the channel default and says which layer decided', async () => {
      const token = userToken(newUserId(), organization());
      const response = await get(
        '/v1/preferences/effective?ruleKey=insurance.expiring&channel=IN_APP',
        token,
      ).expect(200);

      expect(response.body).toEqual({
        ruleKey: 'insurance.expiring',
        channel: 'IN_APP',
        enabled: true,
        decidedBy: 'CHANNEL_DEFAULT',
        overridable: true,
      });
    });

    it('names the narrowest rung that actually decided', async () => {
      const org = organization();
      const token = userToken(newUserId(), org);

      await put('/v1/preferences', token)
        .send({
          preferences: [
            { scope: 'GLOBAL', channel: 'IN_APP', enabled: false },
            { scope: 'CATEGORY', scopeKey: 'EXPIRY', channel: 'IN_APP', enabled: true },
          ],
        })
        .expect(200);

      const response = await get(
        '/v1/preferences/effective?ruleKey=insurance.expiring',
        token,
      ).expect(200);
      expect(response.body).toMatchObject({ enabled: true, decidedBy: 'CATEGORY' });

      // The same person, a rule in the other category, decided one rung lower.
      const other = await get('/v1/preferences/effective?ruleKey=maintenance.due', token).expect(
        200,
      );
      expect(other.body).toMatchObject({ enabled: false, decidedBy: 'GLOBAL' });
    });

    it('is a 404 for a rule that does not exist', async () => {
      const token = userToken(newUserId(), organization());
      await get('/v1/preferences/effective?ruleKey=nothing.like.this', token).expect(404);
    });

    it('refuses a query with no rule', async () => {
      const token = userToken(newUserId(), organization());
      await get('/v1/preferences/effective', token).expect(400);
    });
  });

  describe('who may call these at all', () => {
    it('refuses an unauthenticated caller', async () => {
      await request(api.server).get('/v1/preferences').expect(401);
      await request(api.server).put('/v1/preferences').send({ preferences: [] }).expect(401);
    });

    /**
     * A service has no preferences of its own.
     *
     * The internal token travels in its own header, not in `authorization` —
     * the same shape the inbox suite asserts. Refused by the guard because no
     * route here carries `@AllowService`, and again by `resolveActor()`: two
     * layers, because one decorator is one mistake away from opening the whole
     * surface.
     */
    it('refuses a service token', async () => {
      const response = await request(api.server)
        .get('/v1/preferences')
        .set('x-internal-token', await internalToken('marketplace-service', 'SERVICE'));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    });

    // An authenticated person with no active organization has no tenant to
    // hold preferences in, so there is nothing to read or write.
    it('refuses a caller with no active organization', async () => {
      const response = await get('/v1/preferences', userToken(newUserId(), undefined));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    });

    /**
     * Preferences are per tenant. The same human in another organization has a
     * separate set, which is the property ADR-054 § 5 calls out by name: one
     * person administering three dehyaris must be able to silence one of them.
     */
    it('keeps one person’s two organizations apart', async () => {
      const first = organization();
      const second = organization();
      const user = newUserId();

      await put('/v1/preferences', userToken(user, first))
        .send({ preferences: [{ scope: 'GLOBAL', channel: 'IN_APP', enabled: false }] })
        .expect(200);

      const other = await get('/v1/preferences', userToken(user, second)).expect(200);
      expect(other.body.preferences).toEqual([]);
    });

    it('keeps two people in one organization apart', async () => {
      const org = organization();
      const mine = newUserId();
      const theirs = newUserId();

      await put('/v1/preferences', userToken(mine, org))
        .send({ preferences: [{ scope: 'GLOBAL', channel: 'IN_APP', enabled: false }] })
        .expect(200);

      const other = await get('/v1/preferences', userToken(theirs, org)).expect(200);
      expect(other.body.preferences).toEqual([]);
    });
  });
});
