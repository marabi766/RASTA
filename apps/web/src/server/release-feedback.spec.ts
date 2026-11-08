/** @jest-environment node */
import { RELEASE_SURFACES } from '@/lib/release-messages';
import { actingAccessToken } from '@/test/session-token';
import type { WebSession } from './session';
import { readReleaseFeedback, releaseFeedback, type ReleaseSubject } from './release-feedback';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = {
  subject: 'USER_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: actingAccessToken('ORG_1', ['FLEET_MANAGER']),
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'unused',
  csrfToken: 'csrf',
  issuedAt: 1,
} satisfies WebSession;

/** Every subject a release surface can sign, plus the ids a client could bind an action to. */
const SUBJECTS: ReleaseSubject[] = [
  ...RELEASE_SURFACES.map((surface): ReleaseSubject => ({ surface })),
  ...RELEASE_SURFACES.flatMap((surface) =>
    ['WLT_1', '/assets', '/drivers', 'asset-registration', 'driver-creation', 'wallet', ''].map(
      (target): ReleaseSubject => ({ surface, target }),
    ),
  ),
];
const label = (subject: ReleaseSubject) => JSON.stringify(subject);

describe('FU-254 L1 release feedback is namespaced per surface and target', () => {
  it('has no two subjects the same', () => {
    expect(new Set(SUBJECTS.map(label)).size).toBe(SUBJECTS.length);
  });
  it.each(SUBJECTS.map((subject) => [label(subject), subject] as const))(
    'a token for %s is read by that subject and by no other',
    (_name, subject) => {
      const token = releaseFeedback(SESSION, subject, 'STALE');
      const readers = SUBJECTS.filter(
        (other) => readReleaseFeedback(SESSION, other, token, true) !== undefined,
      );
      expect(readers.map(label)).toEqual([label(subject)]);
      expect(readReleaseFeedback(SESSION, subject, token, true)).toBe('STALE');
    },
  );
  it('does not let the surface name or the target stand in for each other', () => {
    // The old subject strings were '/assets' and '/drivers' (route literals) vs the wallet's raw id.
    const crafted = releaseFeedback(
      SESSION,
      { surface: 'wallet', target: '/assets' },
      'CSRF_REFUSED',
    );
    expect(
      readReleaseFeedback(SESSION, { surface: 'asset-registration' }, crafted, true),
    ).toBeUndefined();
    const route = releaseFeedback(SESSION, { surface: 'asset-registration' }, 'CSRF_REFUSED');
    expect(
      readReleaseFeedback(SESSION, { surface: 'wallet', target: '/assets' }, route, true),
    ).toBeUndefined();
  });
  it.each([undefined, null, '', 'garbage', {}, 7])('reads nothing from the token %j', (token) => {
    expect(readReleaseFeedback(SESSION, { surface: 'wallet' }, token, true)).toBeUndefined();
  });
  it('reads an unknown signed word as not done, never as a success', () => {
    const token = releaseFeedback(SESSION, { surface: 'project-creation' }, 'SOMETHING_NEW');
    expect(readReleaseFeedback(SESSION, { surface: 'project-creation' }, token, true)).toBe(
      'NOT_DONE',
    );
  });
  it('hides a replayed success or GONE while a newer hold exists, shows refusals', () => {
    const subject: ReleaseSubject = { surface: 'demand-submission' };
    for (const outcome of ['RELEASED', 'GONE'] as const) {
      const token = releaseFeedback(SESSION, subject, outcome);
      expect(readReleaseFeedback(SESSION, subject, token, false)).toBeUndefined();
      expect(readReleaseFeedback(SESSION, subject, token, true)).toBe(outcome);
    }
    for (const outcome of ['STALE', 'IN_PROGRESS', 'UNAVAILABLE', 'CSRF_REFUSED'] as const) {
      const token = releaseFeedback(SESSION, subject, outcome);
      expect(readReleaseFeedback(SESSION, subject, token, false)).toBe(outcome);
    }
  });
});
