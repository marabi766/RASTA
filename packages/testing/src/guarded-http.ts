/**
 * The statuses fetch and Playwright would follow. 300 and 305 never navigate,
 * and 304 is cache revalidation: those stay the caller's to read (Q-155).
 */
export const REFUSED_REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

/**
 * What the E2E transport throws for a redirect: a transport failure, never an
 * answer. It carries no URL, Location, body or credential.
 */
export class RedirectRefusedError extends Error {
  constructor() {
    super('Redirect refused by the E2E transport');
    this.name = 'RedirectRefusedError';
  }
}

/** A request as `guardedFetch` takes it: the redirect policy is not the caller's. */
export type GuardedFetch = (
  input: string | URL | Request,
  init?: Omit<RequestInit, 'redirect'>,
) => Promise<Response>;

/**
 * The redirect policy over an explicit `sender` (PR #492 r2 F2): nothing is
 * followed, a redirect is refused before its body is read, and the caller's
 * `redirect` cannot change that. Everything else is the caller's request,
 * sent once on `sender`.
 */
export function guardFetch(sender: typeof fetch): GuardedFetch {
  return async (input, init = {}) => {
    // Set after init so even an untyped caller cannot override it.
    const response = await sender(input, { ...init, redirect: 'manual' });
    if (REFUSED_REDIRECT_STATUSES.includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      throw new RedirectRefusedError();
    }
    return response;
  };
}

/**
 * `fetch` for E2E helpers and specs (Q-155, PR #492 r1 F2). Their requests
 * carry real credentials — the Keycloak admin password, password grants, an
 * admin or user bearer — or a signed storage URL and its bytes, and a
 * following fetch resends a 307/308 body to whatever origin the Location names
 * and accepts that origin's answer. `guardFetch` over the global `fetch`, read
 * at call time.
 */
export const guardedFetch: GuardedFetch = guardFetch((input, init) => fetch(input, init));

/**
 * For a test that replaces the global `fetch` to intercept what the code under
 * test sends (the Keycloak live spec holds a `PUT` on a gate). `send` is
 * `guardFetch` over the global `fetch` as it was when this was called, so the
 * test's own credential-bearing requests never pass through its replacement
 * and never follow a redirect. `replace` installs a replacement, which
 * forwards on `send` (the caller's `redirect` is dropped there: nothing is
 * followed); `restore` puts the captured `fetch` back.
 */
export function globalFetchStub(): {
  send: GuardedFetch;
  replace(replacement: GuardedFetch): void;
  restore(): void;
} {
  const original = globalThis.fetch;
  return {
    send: guardFetch(original),
    replace(replacement) {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const { redirect: _dropped, ...rest } = init ?? {};
        return replacement(input, rest);
      }) as typeof fetch;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Playwright's `APIRequestContext`, structurally: this package does not depend on Playwright. */
const SENDERS = ['delete', 'fetch', 'get', 'head', 'patch', 'post', 'put'] as const;
interface ResponseLike {
  status(): number;
  dispose(): Promise<void>;
}
type Sender = (urlOrRequest: never, options?: never) => Promise<ResponseLike>;
export type GuardableRequestContext = Record<(typeof SENDERS)[number], Sender>;

/** A redirect status is refused before anything reads the response. */
function refusingRedirect(response: ResponseLike): ResponseLike {
  if (REFUSED_REDIRECT_STATUSES.includes(response.status())) {
    void response.dispose().catch(() => undefined);
    throw new RedirectRefusedError();
  }
  return response;
}

/**
 * A sending method with the redirect policy applied: `maxRedirects: 0` is set
 * after the caller's options (Playwright then answers the 3xx instead of
 * following it, and it keeps `authorization` on a same-origin hop), and a
 * redirect status is refused.
 */
function withoutRedirects(
  send: (this: unknown, urlOrRequest: unknown, options?: object) => unknown,
): (this: unknown, urlOrRequest: unknown, options?: object) => Promise<ResponseLike> {
  return async function (this: unknown, urlOrRequest, options) {
    return refusingRedirect(
      (await send.call(this, urlOrRequest, { ...options, maxRedirects: 0 })) as ResponseLike,
    );
  };
}

/**
 * The same policy for one Playwright `APIRequestContext`: every sending method
 * goes out with `maxRedirects: 0` and a redirect status is refused. The
 * caller's `maxRedirects` is overridden; every other method (`dispose`,
 * `storageState`) is the context's own. This guards the context it is given;
 * {@link guardEveryRequestContext} guards every other one.
 */
export function guardRequestContext<C extends GuardableRequestContext>(context: C): C {
  const senders: readonly string[] = SENDERS;
  return new Proxy(context, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property !== 'string' || !senders.includes(property)) return value.bind(target);
      return withoutRedirects(value as (urlOrRequest: unknown, options?: object) => unknown).bind(
        target,
      );
    },
  });
}

/** Guarded prototype methods: installation is idempotent across fixtures and global setup. */
const GUARDED_SENDERS = new WeakSet<object>();

/**
 * Guard the request class before specs/hooks run. All instances, including
 * page.request, context.request and factory-created contexts, share these
 * public senders. Language-level aliases therefore retain the same policy.
 * An incompatible Playwright shape aborts fixture setup instead of opening
 * an unguarded path. No private Playwright API is patched.
 */
export function guardEveryRequestContext(sample: GuardableRequestContext): void {
  for (const name of SENDERS) {
    if (Object.hasOwn(sample, name))
      throw new Error(`guardEveryRequestContext: own "${name}" sender is unsupported`);
    let owner: object | null = Object.getPrototypeOf(sample);
    while (owner !== null && owner !== Object.prototype && !Object.hasOwn(owner, name))
      owner = Object.getPrototypeOf(owner);
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
    const original: unknown = descriptor?.value;
    if (
      !owner ||
      owner === Object.prototype ||
      typeof original !== 'function' ||
      !descriptor?.configurable
    )
      throw new Error(`guardEveryRequestContext: "${name}" cannot be replaced`);
    if (GUARDED_SENDERS.has(original)) continue;
    const wrapper = withoutRedirects(
      original as (this: unknown, urlOrRequest: unknown, options?: object) => unknown,
    );
    Object.defineProperty(owner, name, { ...descriptor, value: wrapper });
    GUARDED_SENDERS.add(wrapper);
  }
}

/** Install from the factory without leaving a sample context alive. */
export async function installRequestContextGuard(factory: {
  newContext(): Promise<GuardableRequestContext & { dispose(): Promise<void> }>;
}): Promise<void> {
  const sample = await factory.newContext();
  try {
    guardEveryRequestContext(sample);
  } finally {
    await sample.dispose();
  }
}
