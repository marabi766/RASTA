import { tryGetContext, type RequestContext } from '../context/request-context';
import { RequestContextMiddleware, requestPath } from './request-context.middleware';

/**
 * The context records which endpoint answered, never what the client put in
 * the query (S-09): `path` reaches every error body and its log line.
 */

function contextFor(request: { originalUrl?: string; url?: string }): RequestContext | undefined {
  let seen: RequestContext | undefined;
  new RequestContextMiddleware().use(
    { headers: {}, method: 'GET', ...request },
    { setHeader: () => undefined },
    () => {
      seen = tryGetContext();
    },
  );
  return seen;
}

describe('RequestContextMiddleware, path', () => {
  it('records the path without the query', () => {
    expect(contextFor({ originalUrl: '/v1/x?secret=abc', url: '/x?secret=abc' })?.path).toBe(
      '/v1/x',
    );
  });

  it('falls back to url, held to the same rule', () => {
    expect(contextFor({ url: '/v1/x?cursor=abc' })?.path).toBe('/v1/x');
  });

  it('a target with no query is recorded as it came', () => {
    expect(contextFor({ originalUrl: '/v1/assets/AST_1/status' })?.path).toBe(
      '/v1/assets/AST_1/status',
    );
  });

  it('no target, no path', () => {
    expect(contextFor({})?.path).toBeUndefined();
  });
});

describe('requestPath', () => {
  it.each([
    ['/v1/x', '/v1/x'],
    ['/v1/x?secret=abc', '/v1/x'],
    ['/v1/x?', '/v1/x'],
    ['/v1/x#secret', '/v1/x'],
    ['/v1/x#a?b', '/v1/x'],
    ['/v1/x?a=1#b', '/v1/x'],
    ['/v1/x%3Fnot-a-query', '/v1/x%3Fnot-a-query'],
    ['?secret=abc', ''],
    ['', ''],
  ])('%p → %p', (target, path) => {
    expect(requestPath(target)).toBe(path);
  });
});
