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

/**
 * `fetch` for E2E helpers and specs (Q-155, PR #492 r1 F2). Their requests
 * carry real credentials — the Keycloak admin password, password grants, an
 * admin or user bearer — or a signed storage URL and its bytes, and a
 * following fetch resends a 307/308 body to whatever origin the Location names
 * and accepts that origin's answer. Here nothing is followed: a redirect is
 * refused before its body is read, and the caller's `redirect` cannot change
 * that. Everything else is the caller's request, sent once.
 */
export async function guardedFetch(
  input: string | URL | Request,
  init: Omit<RequestInit, 'redirect'> = {},
): Promise<Response> {
  // Set after init so even an untyped caller cannot override it.
  const response = await fetch(input, { ...init, redirect: 'manual' });
  if (REFUSED_REDIRECT_STATUSES.includes(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    throw new RedirectRefusedError();
  }
  return response;
}

/** Playwright's `APIRequestContext`, structurally: this package does not depend on Playwright. */
const SENDERS = ['delete', 'fetch', 'get', 'head', 'patch', 'post', 'put'] as const;
interface ResponseLike {
  status(): number;
  dispose(): Promise<void>;
}
type Sender = (urlOrRequest: never, options?: never) => Promise<ResponseLike>;
export type GuardableRequestContext = Record<(typeof SENDERS)[number], Sender>;

/**
 * The same policy for a Playwright `APIRequestContext`: every sending method
 * goes out with `maxRedirects: 0` (Playwright then answers the 3xx instead of
 * following it, and it keeps `authorization` on a same-origin hop) and a
 * redirect status is refused. The caller's `maxRedirects` is overridden; every
 * other method (`dispose`, `storageState`) is the context's own.
 */
export function guardRequestContext<C extends GuardableRequestContext>(context: C): C {
  const senders: readonly string[] = SENDERS;
  return new Proxy(context, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property !== 'string' || !senders.includes(property)) return value.bind(target);
      return async (urlOrRequest: unknown, options?: object) => {
        const response = (await value.call(target, urlOrRequest, {
          ...options,
          maxRedirects: 0,
        })) as ResponseLike;
        if (REFUSED_REDIRECT_STATUSES.includes(response.status())) {
          void response.dispose().catch(() => undefined);
          throw new RedirectRefusedError();
        }
        return response;
      };
    },
  });
}
