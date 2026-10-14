import { tryGetContext, type RequestContext } from '../context/request-context';
import {
  CORRELATION_ID_MAX_LENGTH,
  RequestContextMiddleware,
  isWellFormedCorrelationId,
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
 * Only an identifier the platform could have minted is adopted.
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
    ['a labelled ULID', 'COR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a labelled UUID', 'e2e-refusal-3f2b8c1e-9d4a-4e6b-8a7c-1f0e2d3c4b5a'],
    ['a label naming a domain id', 'maintenance-due-MSC_01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a run-tagged id', 'COR_7M2N5P8R1T_01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
  ])('adopts %s', (_, id) => {
    expect(correlationFor(id)).toEqual({ context: id, response: id });
  });

  it.each([
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
    ['an id past the length bound', `${'A'.repeat(120)}_01JBQ8Z4K7M2N5P8R1T3V6X9Y2`],
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

  it('holds the length bound exactly', () => {
    const tail = '_01JBQ8Z4K7M2N5P8R1T3V6X9Y2';
    const atBound = `${'A'.repeat(CORRELATION_ID_MAX_LENGTH - tail.length)}${tail}`;
    expect(isWellFormedCorrelationId(atBound)).toBe(true);
    expect(isWellFormedCorrelationId(`A${atBound}`)).toBe(false);
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
