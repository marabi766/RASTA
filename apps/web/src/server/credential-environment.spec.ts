/**
 * @jest-environment node
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CredentialEnvironmentRefusedError, refusedBeforeSending } from '@rasta/config';

import { credentialFetch } from './credential-fetch';
import { putToSignedUrl } from './signed-url-upload';

/**
 * FU-249 over real HTTP: Node's fetch reads inherited members of the option
 * objects it builds, so a key on `Object.prototype` reached the request — a
 * `dispatcher` received it, bearer header or signed URL included, and a `body`
 * was sent as the body. Both portal transports now refuse before sending. Jest
 * sandboxes this module, so the pollution goes where Node's fetch reads: its
 * own realm.
 */
const BEARER = 'Bearer portal-sentinel-9d1c';
const SIGNATURE = 'X-Amz-Signature=signed-sentinel-77aa';
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
  dispatch(options: { path?: string; headers?: unknown }, handler: { onError(e: Error): void }) {
    captured.push([options.path, options.headers]);
    queueMicrotask(() => handler.onError(new Error('captured')));
    return true;
  },
};

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push(`${request.method} ${request.url} ${request.headers.authorization} ${body}`);
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  received.length = 0;
  captured.length = 0;
});

/** Each transport, sending its credential with the caller's own body (or none). */
const TRANSPORTS = {
  credentialFetch: (body?: string, fetchImpl?: typeof fetch) =>
    credentialFetch(
      `${origin}/api`,
      { method: 'POST', headers: { authorization: BEARER }, body },
      fetchImpl,
    ),
  putToSignedUrl: (body?: string, fetchImpl?: typeof fetch) =>
    putToSignedUrl(`${origin}/bucket/key?${SIGNATURE}`, { body }, fetchImpl),
};
const NAMES = Object.keys(TRANSPORTS) as (keyof typeof TRANSPORTS)[];

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

describe.each(NAMES)('%s in an altered runtime (FU-249)', (name) => {
  const send = TRANSPORTS[name];

  it.each([
    ['dispatcher', capturing],
    ['body', 'injected-body-sentinel'],
  ])('sends nothing while Object.prototype.%s is set', async (key, value) => {
    const outcome = await whilePolluted(key, value, () => send());
    expect(outcome).toBeInstanceOf(CredentialEnvironmentRefusedError);
    expect(captured).toEqual([]);
    expect(received).toEqual([]);
  });

  it('marks only its own refusal as unsent, never one escaping from its transport', async () => {
    /** A fresh refusal of this transport's own check: marked, nothing sent. */
    const ownRefusal = async () => {
      const own = await whilePolluted('fu249Probe', 1, () => send());
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
    for (const route of name === 'credentialFetch' ? routes : routes.slice(0, 1)) {
      const own = await ownRefusal();
      const escaped = await send(undefined, route(own)).catch((error: unknown) => error);
      expect(escaped).toBe(own);
      expect(refusedBeforeSending(escaped)).toBe(false);
    }
    expect(received).toEqual([]);
  });

  // A replaced global dispatcher: Node's slot is the host's under jest, so that
  // case is proven where it is real, in scripts/credential-fetch.test.mjs.
  it('still sends its credential and body through an unaltered runtime', async () => {
    const response = await send('own-body');
    expect(await response.text()).toBe('ok');
    expect(received).toEqual([
      name === 'credentialFetch'
        ? `POST /api ${BEARER} own-body`
        : `PUT /bucket/key?${SIGNATURE} undefined own-body`,
    ]);
  });
});
