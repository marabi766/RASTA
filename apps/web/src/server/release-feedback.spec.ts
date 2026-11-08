/** @jest-environment node */
import { CSRF_FIELD } from '@/lib/form-fields';
import { RELEASE_FIELD, RELEASE_QUERY, RELEASE_SURFACES } from '@/lib/release-messages';
import { feedbackFor } from '@/test/release-query';
import { actingAccessToken } from '@/test/session-token';
import type { WebSession } from './session';
import { handOver, pageContext } from './page-context';
import {
  readReleaseFeedback,
  releaseFeedback,
  settleRelease,
  type ReleaseSubject,
} from './release-feedback';
import { ReleaseScope } from './release-scope';
import * as store from './unresolved-request';
import { CONTEXT_PARAM } from '@/lib/page-context';

jest.mock('./unresolved-request', () => ({
  ...jest.requireActual('./unresolved-request'),
  releaseUnresolved: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

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
        (other) => feedbackFor(SESSION, other, token, true) !== undefined,
      );
      expect(readers.map(label)).toEqual([label(subject)]);
      expect(feedbackFor(SESSION, subject, token, true)).toBe('STALE');
    },
  );
  it('does not let the surface name or the target stand in for each other', () => {
    // The old subject strings were '/assets' and '/drivers' (route literals) vs the wallet's raw id.
    const crafted = releaseFeedback(
      SESSION,
      { surface: 'wallet', target: '/assets' },
      'CSRF_REFUSED',
    );
    expect(feedbackFor(SESSION, { surface: 'asset-registration' }, crafted, true)).toBeUndefined();
    const route = releaseFeedback(SESSION, { surface: 'asset-registration' }, 'CSRF_REFUSED');
    expect(
      feedbackFor(SESSION, { surface: 'wallet', target: '/assets' }, route, true),
    ).toBeUndefined();
  });
  it.each([undefined, null, '', 'garbage', {}, 7])('reads nothing from the token %j', (token) => {
    expect(feedbackFor(SESSION, { surface: 'wallet' }, token, true)).toBeUndefined();
  });
  it('reads an unknown signed word as not done, never as a success', () => {
    const token = releaseFeedback(SESSION, { surface: 'project-creation' }, 'SOMETHING_NEW');
    expect(feedbackFor(SESSION, { surface: 'project-creation' }, token, true)).toBe('NOT_DONE');
  });
  it('hides a replayed success or GONE while a newer hold exists, shows refusals', () => {
    const subject: ReleaseSubject = { surface: 'demand-submission' };
    for (const outcome of ['RELEASED', 'GONE'] as const) {
      const token = releaseFeedback(SESSION, subject, outcome);
      expect(feedbackFor(SESSION, subject, token, false)).toBeUndefined();
      expect(feedbackFor(SESSION, subject, token, true)).toBe(outcome);
    }
    for (const outcome of ['STALE', 'IN_PROGRESS', 'UNAVAILABLE', 'CSRF_REFUSED'] as const) {
      const token = releaseFeedback(SESSION, subject, outcome);
      expect(feedbackFor(SESSION, subject, token, false)).toBe(outcome);
    }
  });
});

describe('review 2 F1: the boundary is in the code, not in a spelling', () => {
  const token = () => releaseFeedback(SESSION, { surface: 'wallet' }, 'STALE');
  const query = (extra: Record<string, string>) => ({
    [CONTEXT_PARAM]: pageContext(SESSION),
    ...extra,
  });

  it('the params a page gets carry no release key, whatever it spells the key as', () => {
    const params = handOver(SESSION, query({ [RELEASE_QUERY]: token(), status: 'open' }));
    expect(params).toEqual({ status: 'open' });
    const computed = ['rel', 'ease'].join('');
    expect((params as Record<string, unknown>)[computed]).toBeUndefined();
    expect((params as Record<string, unknown>)[RELEASE_FIELD]).toBeUndefined();
    expect(Object.entries(params).flat()).not.toContain(token());
    expect(JSON.stringify({ ...params })).not.toContain(token());
  });
  it('the signed outcome is reachable through readReleaseFeedback and nothing else', () => {
    const params = handOver(SESSION, query({ [RELEASE_QUERY]: token() }));
    expect(readReleaseFeedback(SESSION, { surface: 'wallet' }, params, true)).toBe('STALE');
    // A look-alike object (copied, or built by hand) was not handed over by pageParams: it reads nothing.
    expect(
      readReleaseFeedback(SESSION, { surface: 'wallet' }, { ...params }, true),
    ).toBeUndefined();
    expect(
      readReleaseFeedback(SESSION, { surface: 'wallet' }, { release: token() }, true),
    ).toBeUndefined();
  });
  it('a query for another organization hands over neither the keys nor the outcome', () => {
    const params = handOver(SESSION, { [CONTEXT_PARAM]: 'someone-else', [RELEASE_QUERY]: token() });
    expect(params).toEqual({});
    expect(readReleaseFeedback(SESSION, { surface: 'wallet' }, params, true)).toBeUndefined();
  });
  it('a repeated release parameter reads as its first value', () => {
    const params = handOver(SESSION, {
      [CONTEXT_PARAM]: pageContext(SESSION),
      [RELEASE_QUERY]: [token(), 'x'],
    });
    expect(readReleaseFeedback(SESSION, { surface: 'wallet' }, params, true)).toBe('STALE');
  });

  it('settleRelease lets go of nothing for a scope server/ did not build', async () => {
    const release = jest.mocked(store.releaseUnresolved).mockClear();
    const form = new FormData();
    form.set(CSRF_FIELD, SESSION.csrfToken);
    form.set('confirmDuplicate', 'yes');
    const forged = {
      scope: { purpose: 'wallet-top-up', target: 'WLT_1' },
    } as unknown as ReleaseScope;
    const error = await settleRelease({
      session: SESSION,
      form,
      back: '/wallet',
      subject: { surface: 'wallet', target: 'WLT_1' },
      scope: forged,
    }).catch((e: Error) => e);
    const url = new URL(
      (error as Error).message.slice('NEXT_REDIRECT:'.length),
      'http://localhost',
    );
    expect(release).not.toHaveBeenCalled();
    const outcome = handOver(SESSION, Object.fromEntries(url.searchParams));
    expect(
      readReleaseFeedback(SESSION, { surface: 'wallet', target: 'WLT_1' }, outcome, true),
    ).toBe('NOT_DONE');
  });
  it('a scope built in server/ is released through the shared tail', async () => {
    const release = jest.mocked(store.releaseUnresolved).mockClear().mockResolvedValue('GONE');
    const form = new FormData();
    form.set(CSRF_FIELD, SESSION.csrfToken);
    form.set('confirmDuplicate', 'yes');
    form.set(RELEASE_FIELD, 'named');
    const error = await settleRelease({
      session: SESSION,
      form,
      back: '/wallet',
      subject: { surface: 'wallet' },
      scope: ReleaseScope.of({ purpose: 'p' }),
    }).catch((e: Error) => e);
    expect(release).toHaveBeenCalledWith(SESSION, { purpose: 'p' }, 'named');
    expect((error as Error).message).toContain(`${RELEASE_QUERY}=`);
  });
});
