/**
 * @jest-environment node
 */
import {
  checkCreateStamp,
  createReplayWindowSeconds,
  mintCreateStamp,
  mintCreateSubmission,
} from './project-create-replay';
import type { WebSession } from './session';

/**
 * The create form's replay deadline: the service's mirrored retention less the
 * margin, counted from when the page drew the form, on the server's clock.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'owner',
  organizationId: 'ORG_OWNER',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

const ENV = {
  WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: 2,
  WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS: 600,
};
const T0 = 1_900_000_000_000;

describe('the create replay window', () => {
  it('is the retention less the margin', () => {
    expect(createReplayWindowSeconds(ENV)).toBe(2 * 3600 - 600);
    // The defaults: 1 hour less 10 minutes, at or below the service's own floor.
    expect(createReplayWindowSeconds()).toBe(3000);
  });

  it('is OK up to the end of the window and EXPIRED after it', () => {
    const { id, replay } = mintCreateSubmission(SESSION, T0);
    const end = T0 + (2 * 3600 - 600) * 1000;
    expect(checkCreateStamp(SESSION, replay, id, T0, ENV)).toBe('OK');
    expect(checkCreateStamp(SESSION, replay, id, end, ENV)).toBe('OK');
    expect(checkCreateStamp(SESSION, replay, id, end + 1, ENV)).toBe('EXPIRED');
  });

  it('applies the window as configured now, not as it was when the page was drawn', () => {
    const { id, replay } = mintCreateSubmission(SESSION, T0);
    const shorter = { ...ENV, WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: 1 };
    expect(checkCreateStamp(SESSION, replay, id, T0 + 3000_000 + 1, shorter)).toBe('EXPIRED');
  });

  it('is still EXPIRED, not forged, a day after the window', () => {
    const { id, replay } = mintCreateSubmission(SESSION, T0);
    expect(checkCreateStamp(SESSION, replay, id, T0 + 24 * 3600_000, ENV)).toBe('EXPIRED');
  });

  it.each([undefined, null, '', 'x', 'a.b'])('has no answer for %j', (token) => {
    const { id } = mintCreateSubmission(SESSION, T0);
    expect(checkCreateStamp(SESSION, token, id, T0, ENV)).toBeNull();
  });

  it('has no answer for another id, another login, or another purpose', () => {
    const { id, replay } = mintCreateSubmission(SESSION, T0);
    expect(checkCreateStamp(SESSION, replay, `${id}x`, T0, ENV)).toBeNull();
    expect(checkCreateStamp({ ...SESSION, csrfToken: 'other' }, replay, id, T0, ENV)).toBeNull();
    expect(mintCreateStamp(SESSION, id, T0)).toBe(replay);
  });
});
