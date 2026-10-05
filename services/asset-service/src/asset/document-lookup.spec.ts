import { RastaError } from '@rasta/nest-common';
import { DocumentLookupClient, UNCONFIGURED_DOCUMENT_LOOKUP } from './document-lookup';

/**
 * Asking document-service who owns a document (EXP-002 slice 7, Codex r1 on
 * #225): what is sent, and — the part that matters — that only a well-formed 200
 * about this document is an answer. Everything else is unavailable, and
 * unavailable never means "attach it anyway".
 */

const ORG = 'ORG-DEH-0001';
const DOC = 'DOC_01JDOCUMENT00000000000001';
const SECRET_URL = 'http://document-service.internal:3114';

const ANSWER = {
  id: DOC,
  organizationId: ORG,
  status: 'REGISTERED',
  ownerResourceType: 'Asset',
  ownerResourceId: 'AST_1',
  // Fields the lookup does not read stay out of what it returns.
  filename: 'secret.pdf',
  scanState: 'PENDING',
};

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

function client(
  respond: (call: Call) => Response | Promise<Response>,
  options: { timeoutMs?: number } = {},
) {
  const calls: Call[] = [];
  const issue = jest.fn(async () => 'service-token');
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call = {
      url: String(url),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return {
    calls,
    issue,
    lookup: new DocumentLookupClient({
      baseUrl: `${SECRET_URL}/`,
      timeoutMs: options.timeoutMs ?? 1000,
      tokens: { issue },
      fetch: impl,
    }),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('DocumentLookupClient', () => {
  it('asks GET /v1/documents/{id} with a service token minted for document-service and signed with the machine’s organization', async () => {
    const { lookup, calls, issue } = client(() => json(200, ANSWER));

    const found = await lookup.find(DOC, ORG);

    expect(found).toEqual({
      id: DOC,
      organizationId: ORG,
      status: 'REGISTERED',
      ownerResourceType: 'Asset',
      ownerResourceId: 'AST_1',
    });
    expect(issue).toHaveBeenCalledWith('asset-service', 'document-service', 'SERVICE', ORG);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${SECRET_URL}/v1/documents/${DOC}`,
      method: 'GET',
    });
    // The organization is in the token, never a header.
    expect(calls[0]!.headers['x-internal-token']).toBe('service-token');
    expect(Object.keys(calls[0]!.headers)).not.toContain('x-organization-id');
  });

  it('encodes the id into the path, so an id with a slash cannot address another endpoint', async () => {
    const { lookup, calls } = client(() => json(404, { code: 'NOT_FOUND', message: 'x' }));
    await lookup.find('../../health', ORG);
    expect(calls[0]!.url).toBe(`${SECRET_URL}/v1/documents/..%2F..%2Fhealth`);
  });

  it('says null for the service’s own 404, and only for that', async () => {
    const { lookup } = client(() =>
      json(404, { code: 'NOT_FOUND', message: 'Document not found' }),
    );
    expect(await lookup.find(DOC, ORG)).toBeNull();
  });

  it.each([
    [
      'a proxy’s 404 with no platform body',
      () => new Response('<html>nope</html>', { status: 404 }),
    ],
    ['a 404 with another code', () => json(404, { code: 'SOMETHING_ELSE', message: 'x' })],
    ['a 401', () => json(401, { code: 'TOKEN_INVALID', message: 'x' })],
    ['a 403', () => json(403, { code: 'FORBIDDEN', message: 'x' })],
    ['a 500', () => json(500, { code: 'INTERNAL', message: 'boom' })],
    ['a 503', () => json(503, { code: 'UPSTREAM_UNAVAILABLE', message: 'x' })],
    ['a 200 that is not JSON', () => new Response('not json', { status: 200 })],
    ['a 200 with the wrong shape', () => json(200, { id: DOC })],
    ['a 200 with an unknown status', () => json(200, { ...ANSWER, status: 'ARCHIVED' })],
    ['a 200 about another document', () => json(200, { ...ANSWER, id: 'DOC_OTHER' })],
    ['a 204', () => new Response(null, { status: 204 })],
  ])('is unavailable, never a pass, for %s', async (_what, respond) => {
    const { lookup } = client(respond);
    await expect(lookup.find(DOC, ORG)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('is unavailable when the transport fails, and the error carries nothing of the URL, the token or the cause', async () => {
    const { lookup } = client(() => {
      throw new Error(`connect ECONNREFUSED ${SECRET_URL} token=service-token`);
    });

    const error = (await lookup.find(DOC, ORG).catch((e: unknown) => e)) as RastaError;

    expect(error).toBeInstanceOf(RastaError);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify([error.message, error.details, error.internalContext])).not.toMatch(
      /document-service\.internal|service-token|ECONNREFUSED/,
    );
    expect(error.cause).toBeUndefined();
  });

  it('times out with the upstream timeout, even when the transport ignores the abort', async () => {
    const { lookup } = client(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(json(200, ANSWER)), 120);
        }),
      { timeoutMs: 20 },
    );

    await expect(lookup.find(DOC, ORG)).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });

  it('does not return an answer that arrived after the deadline', async () => {
    const { lookup } = client(
      async () => {
        await new Promise((done) => setTimeout(done, 80));
        return json(200, ANSWER);
      },
      { timeoutMs: 20 },
    );
    await expect(lookup.find(DOC, ORG)).rejects.toBeInstanceOf(RastaError);
  });
});

describe('UNCONFIGURED_DOCUMENT_LOOKUP', () => {
  it('never lets a document through: a missing dependency is not "the document is theirs"', async () => {
    await expect(UNCONFIGURED_DOCUMENT_LOOKUP.find(DOC, ORG)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});
