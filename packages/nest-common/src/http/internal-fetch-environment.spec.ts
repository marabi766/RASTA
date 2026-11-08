import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CredentialEnvironmentRefusedError, refusedBeforeSending } from '@rasta/config';
import { internalFetch } from './internal-fetch';

/**
 * FU-249 over real HTTP: Node's fetch reads inherited members of the option
 * objects it builds, so a key on `Object.prototype` reached the request — a
 * `dispatcher` received it, internal token included, and a `body` was sent as
 * the body. internalFetch now refuses before sending. Jest sandboxes this
 * module, so the pollution goes where Node's fetch reads: its own realm.
 */
const TOKEN = 'internal-token-sentinel-4b2e';
const HOST_OBJECT_PROTOTYPE = Object.getPrototypeOf(Object.getPrototypeOf(fetch)) as Record<
  string,
  unknown
>;

let server: Server;
let origin: string;
const received: string[] = [];
const captured: unknown[] = [];
/** Receives the request instead of the network, the way a polluted `dispatcher` would. */
const capturing = {
  dispatch(options: { headers?: unknown }, handler: { onError(error: Error): void }) {
    captured.push(options.headers);
    queueMicrotask(() => handler.onError(new Error('captured')));
    return true;
  },
};

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push(`${request.method} ${request.headers['x-internal-token']} ${body}`);
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  received.length = 0;
  captured.length = 0;
});

/** The outcome of `send` while Node's own `Object.prototype[key]` is `value`. */
async function whilePolluted(key: string, value: unknown, send: () => Promise<Response>) {
  HOST_OBJECT_PROTOTYPE[key] = value;
  try {
    return await send().then(
      () => 'sent',
      (error: unknown) => error,
    );
  } finally {
    delete HOST_OBJECT_PROTOTYPE[key];
  }
}

describe('internalFetch in an altered runtime (FU-249)', () => {
  it.each([
    ['dispatcher', capturing, 'GET'],
    ['body', 'injected-body-sentinel', 'POST'],
  ])('sends nothing while Object.prototype.%s is set', async (key, value, method) => {
    const outcome = await whilePolluted(key, value, () =>
      internalFetch(origin, { method, headers: { 'x-internal-token': TOKEN } }),
    );
    expect(outcome).toBeInstanceOf(CredentialEnvironmentRefusedError);
    expect(captured).toEqual([]);
    expect(received).toEqual([]);
  });

  it('marks only its own refusal as unsent, never one escaping from its transport', async () => {
    /** A fresh refusal of internalFetch's own check: marked, nothing sent. */
    const ownRefusal = async () => {
      const own = await whilePolluted('fu249Probe', 1, () =>
        internalFetch(origin, { method: 'GET' }),
      );
      expect(own).toBeInstanceOf(CredentialEnvironmentRefusedError);
      expect(refusedBeforeSending(own)).toBe(true);
      return own;
    };
    // Thrown by the transport, or by the answer it returned: either way after the check.
    const routes: ((own: unknown) => typeof fetch)[] = [
      (own) => async () => {
        throw own;
      },
      (own) => async () =>
        ({
          get status(): number {
            throw own;
          },
        }) as Response,
    ];
    for (const route of routes) {
      const own = await ownRefusal();
      const escaped = await internalFetch(origin, { method: 'GET' }, route(own)).catch(
        (error: unknown) => error,
      );
      expect(escaped).toBe(own);
      expect(refusedBeforeSending(escaped)).toBe(false);
    }
    expect(received).toEqual([]);
  });

  // A replaced global dispatcher: Node's slot is the host's under jest, so that
  // case is proven where it is real, in scripts/credential-fetch.test.mjs.
  it('still sends, token and body, through an unaltered runtime', async () => {
    const response = await internalFetch(origin, {
      method: 'POST',
      headers: { 'x-internal-token': TOKEN },
      body: 'own-body',
    });
    expect(await response.text()).toBe('ok');
    expect(received).toEqual([`POST ${TOKEN} own-body`]);
  });
});
