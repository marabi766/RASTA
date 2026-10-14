import { tryGetContext, type RequestContext } from '../context/request-context';
import {
  CORRELATION_ID_MAX_LENGTH,
  RequestContextMiddleware,
  isServiceCorrelationId,
  requestPath,
} from './request-context.middleware';

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

/**
 * `X-Correlation-Id` is the caller's to set, and the adopted value reaches the
 * response header, every error body and every log line of the request (S-09).
 * The middleware runs before authentication, so it holds every caller to the
 * external rule: exactly an id the platform hands out. A verified service
 * caller's looser id is the auth guard's to adopt (auth.guard.correlation.spec).
 */
describe('RequestContextMiddleware, correlation id', () => {
  const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  function correlationFor(header: string | undefined): { context: string; response: string } {
    const echoed: Record<string, string> = {};
    let seen: RequestContext | undefined;
    new RequestContextMiddleware().use(
      { headers: header === undefined ? {} : { 'x-correlation-id': header }, method: 'GET' },
      { setHeader: (name, value) => (echoed[name] = value) },
      () => {
        seen = tryGetContext();
      },
    );
    return { context: seen!.correlationId, response: echoed['x-correlation-id']! };
  }

  it.each([
    ['a ULID, as this middleware mints', '01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a UUID, as the web app mints', '3f2b8c1e-9d4a-4e6b-8a7c-1f0e2d3c4b5a'],
  ])('adopts %s', (_, id) => {
    expect(correlationFor(id)).toEqual({ context: id, response: id });
  });

  it.each([
    // Codex r4: a whole UUID behind a label used to be adopted.
    [
      'a credential labelling a UUID',
      'access_token_secret123-3f2b8c1e-9d4a-4e6b-8a7c-1f0e2d3c4b5a',
    ],
    ['a credential labelling a ULID', 'access_token_secret123-01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a labelled ULID', 'COR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a labelled UUID', 'e2e-refusal-3f2b8c1e-9d4a-4e6b-8a7c-1f0e2d3c4b5a'],
    ['a background-work id', 'maintenance-due-MSC_01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a UUID with a trailing label', '3f2b8c1e-9d4a-4e6b-8a7c-1f0e2d3c4b5a-secret'],
    ['a UUID without its dashes', '3f2b8c1e9d4a4e6b8a7c1f0e2d3c4b5a'],
    ['a credential', 'access_token=secret123'],
    ['a bare word', 'secret123'],
    ['a phone number', '09121234567'],
    ['an email address', 'someone@example.com'],
    ['free text', 'my name is Ali'],
    ['a short test id', 'corr-1'],
    ['a ULID in lower case', '01jbq8z4k7m2n5p8r1t3v6x9y2'],
    ['a ULID with a trailing label', '01JBQ8Z4K7M2N5P8R1T3V6X9Y2_secret'],
    ['a ULID with a line break after it', '01JBQ8Z4K7M2N5P8R1T3V6X9Y2\nforged log line'],
    ['a ULID behind a credential', 'token=abc_01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['an empty value', ''],
  ])('refuses %s and mints a fresh id instead', (_, header) => {
    const { context, response } = correlationFor(header);
    expect(context).toMatch(ULID_SHAPE);
    expect(context).not.toBe(header);
    expect(response).toBe(context);
  });

  it('mints one when there is no header', () => {
    expect(correlationFor(undefined).context).toMatch(ULID_SHAPE);
  });

  it("adopts what another service's middleware minted, so the id survives the hop", () => {
    const minted = correlationFor(undefined).context;
    expect(correlationFor(minted).context).toBe(minted);
  });
});

/** What a verified service caller may keep (applied by the auth guard). */
describe('isServiceCorrelationId', () => {
  it.each([
    ['a legacy id an order was placed under', 'corr-1'],
    ['a background-work id', 'maintenance-due-MSC_01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a scan id', 'scan-01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a labelled UUID', 'e2e-refusal-3f2b8c1e-9d4a-4e6b-8a7c-1f0e2d3c4b5a'],
    ['a bare ULID', '01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
  ])('keeps %s', (_, id) => {
    expect(isServiceCorrelationId(id)).toBe(true);
  });

  it.each([
    ['a credential with "="', 'access_token=secret123'],
    ['free text', 'my name is Ali'],
    ['an email address', 'someone@example.com'],
    ['a line break', 'corr-1\nforged log line'],
    ['an empty value', ''],
  ])('refuses %s', (_, id) => {
    expect(isServiceCorrelationId(id)).toBe(false);
  });

  it('holds the length bound exactly', () => {
    const atBound = 'a'.repeat(CORRELATION_ID_MAX_LENGTH);
    expect(isServiceCorrelationId(atBound)).toBe(true);
    expect(isServiceCorrelationId(`${atBound}a`)).toBe(false);
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
