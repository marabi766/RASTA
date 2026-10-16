/**
 * @jest-environment node
 */

/**
 * `/auth/session`: the one authoritative answer a form gets about whether its
 * session has ended (PR 319 review 1, finding 4). Status only — no body, nothing
 * of the session — and never cached.
 */

const currentSession = jest.fn();
jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GET } = require('./route') as typeof import('./route');

it('answers 204 with no body while the session opens', async () => {
  currentSession.mockResolvedValue({ subject: 'user-1', accessToken: 'secret-token' });
  const response = await GET();
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  expect(response.headers.get('cache-control')).toBe('no-store');
});

it('answers 401 with no body once it has ended', async () => {
  currentSession.mockResolvedValue(null);
  const response = await GET();
  expect(response.status).toBe(401);
  expect(await response.text()).toBe('');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
