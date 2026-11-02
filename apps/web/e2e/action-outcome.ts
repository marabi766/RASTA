import { expect, type Locator, type Request } from './expect';

/**
 * What a Server Action answered, read off the wire — one assertion for every
 * spec that has to prove a submission **succeeded** (PR #541 r1 F1).
 *
 * A status below 500 proves nothing: a refused submission is a 4xx from the
 * gateway's way or, far more often, the action's own result — `REFUSED`,
 * `FORBIDDEN`, `UNCONFIRMED`, `INVALID` — rendered as HTTP 200. The only answer
 * this portal's write actions give for a write that went through is
 * `redirect(...)`, which Next 15 sends as a `303 See Other` naming the target:
 *
 * - a fetch action (the `Next-Action` header, JavaScript on): `x-action-redirect:
 *   <url>;<push|replace>` and no `Location` — the client router follows it;
 * - a native form post (no JavaScript): `Location: <url>`.
 *
 * So success is exactly a 303 whose target is the page the action redirects to
 * on `CREATED`, and the target's query carries the created resource's id where
 * the action puts one there (`/usage?created=USG_…`). Both are read from the
 * browser's own record of the exchange (`Request.response()`), never from what
 * a following fetch or the guarded `request` fixture would have turned the 303
 * into (the fixture refuses every redirect, Q-155: a resend through it could
 * not tell the success from anything else).
 */
export interface ActionSuccess {
  /** The redirect target's path, exactly. */
  readonly path: string;
  /** Query parameters the target must carry, each matching its pattern. */
  readonly query?: Readonly<Record<string, RegExp>>;
}

/** The redirect target's query (the created resource's id is the caller's to read). */
export async function expectActionSucceeded(
  sent: Request,
  expected: ActionSuccess,
): Promise<URLSearchParams> {
  const response = await sent.response();
  expect(response, `${sent.method()} ${sent.url()} got no answer`).not.toBeNull();
  const headers = await response!.allHeaders();
  const fetchAction = (await sent.allHeaders())['next-action'] !== undefined;
  const target = fetchAction
    ? (headers['x-action-redirect']?.split(';')[0] ?? null)
    : (headers.location ?? null);
  // One comparison, so a failure prints the status beside whether a target was
  // named: a 200 action result, a 4xx, a 303 with nothing to follow. A 303 to
  // the wrong page (the login page, an error page) fails on the path below.
  expect({ status: response!.status(), redirectsTo: target === null ? null : 'a target' }).toEqual({
    status: 303,
    redirectsTo: 'a target',
  });
  // A path of this portal, as `redirect('/wallet')` names it: an absolute URL fails here.
  const [path, search = ''] = target!.split('?', 2) as [string, string?];
  expect(path).toBe(expected.path);
  const query = new URLSearchParams(search);
  for (const [name, pattern] of Object.entries(expected.query ?? {})) {
    expect(query.get(name) ?? '', `the redirect's ${name}`).toMatch(pattern);
  }
  return query;
}

/** One POST the page sends: a captured request resent, or the form's own native payload. */
export type PagePost = { readonly resend: Request } | { readonly form: 'native' };

/**
 * Sends `posts` at once from the page `anchor` lives in — the browser's own
 * same-origin request with the session's cookie (`fetch` follows nothing it
 * can be told to: a fetch action's 303 has no `Location`, and a native post's
 * 303 is followed by the browser itself) — and returns the browser's record of
 * each, in no particular order, for {@link expectActionSucceeded}.
 *
 * `{ form: 'native' }` posts `anchor` (a `<form>`) as a browser without
 * JavaScript would: its action URL and its `FormData`. `{ resend }` sends the
 * captured request again byte for byte: its URL, its body and every header a
 * page may set (the browser adds `Cookie`, `Origin` and the rest itself).
 */
export async function postFromPage(
  anchor: Locator,
  posts: readonly PagePost[],
): Promise<Request[]> {
  const page = anchor.page();
  const wire = await Promise.all(
    posts.map(async (post) =>
      'resend' in post
        ? {
            url: post.resend.url(),
            headers: Object.fromEntries<string>(
              Object.entries(await post.resend.allHeaders()).filter(
                ([name]) => !name.startsWith(':'),
              ),
            ),
            body: post.resend.postData() ?? '',
          }
        : null,
    ),
  );
  const seen: Request[] = [];
  const watch = (request: Request) => {
    // The posts' first hops: a native post's redirect is followed by a GET.
    if (request.method() === 'POST' && request.resourceType() === 'fetch') seen.push(request);
  };
  page.on('request', watch);
  try {
    await anchor.evaluate(async (element, list) => {
      const send = async (post: (typeof list)[number]): Promise<void> => {
        const form = element as HTMLFormElement;
        // In the page, not the runner: the browser's own same-origin form post, a browser
        // flow outside the API transport (Q-155). The one pinned disable (raw-http tests).
        // eslint-disable-next-line internal/raw-http -- browser form replay
        const response = await fetch(post ? post.url : form.action, {
          method: 'POST',
          headers: post ? post.headers : undefined,
          body: post ? post.body : new FormData(form),
          credentials: 'same-origin',
        });
        await response.arrayBuffer();
      };
      await Promise.all(list.map(send));
    }, wire);
  } finally {
    page.off('request', watch);
  }
  expect(seen).toHaveLength(posts.length);
  return seen;
}

/**
 * One line in the job log, under the test's title (the `list` reporter prints a
 * test's stdout): the evidence that a live step ran, not skipped (PR #541 r1).
 */
export function logStep(line: string): void {
  process.stdout.write(`${line}\n`);
}
