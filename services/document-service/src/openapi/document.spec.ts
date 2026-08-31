import type { OpenAPIObject } from '@nestjs/swagger';
import { enrichOpenApiDocument } from './document';

/**
 * What the published contract says, as opposed to what the code does.
 *
 * The failure this guards is not a crash. It is a document a client generates
 * a typed SDK from that disagrees with the running service — a request body
 * missing from the spec, a success status a client checks for and never sees,
 * or a signed-URL lifetime stated as a constant while the deployment uses a
 * different one. Every one of those is discovered by whoever integrates,
 * not by whoever changed it.
 */

const OPTIONS = { signedUrlTtlSeconds: 300, uploadIntentTtlSeconds: 900 };

/** A skeleton shaped the way Nest hands one over: paths, methods, no bodies. */
function nestDocument(): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 'Rasta — Document Service', version: '0.1.0' },
    paths: {
      '/v1/documents/upload-url': {
        post: { summary: 'Request a short-lived signed URL', description: 'Base text.' },
      },
      '/v1/documents': {
        post: { summary: 'Register a document' },
        get: { summary: 'List documents' },
      },
      '/v1/documents/{id}': {
        get: { summary: 'Read metadata' },
        delete: { summary: 'Delete a document' },
      },
      '/v1/documents/{id}/download-url': {
        post: { summary: 'Issue a signed download URL', description: 'Base text.' },
      },
    },
  } as unknown as OpenAPIObject;
}

// JUSTIFIED-ANY: OpenAPIObject's path-item type is a union of every HTTP
// method, and narrowing it here would restate the spec's own types without
// making a single assertion below safer. `no-explicit-any` is already off for
// spec files (eslint.config.mjs), so no directive is needed — the reason is
// recorded because AGENTS.md § 3 asks for one wherever `any` appears.
type Operation = any;

const op = (document: OpenAPIObject, path: string, method: string): Operation =>
  (document.paths as Record<string, Record<string, Operation>>)[path][method];

describe('request bodies', () => {
  it('publishes a body for every write endpoint that takes one', () => {
    // Without this the document showed a summary and no request body, which is
    // a contract nobody can generate a client from.
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);

    for (const [path, method] of [
      ['/v1/documents/upload-url', 'post'],
      ['/v1/documents', 'post'],
      ['/v1/documents/{id}', 'delete'],
    ] as const) {
      const body = op(document, path, method).requestBody;
      expect(body?.required).toBe(true);
      expect(body?.content['application/json'].schema.type).toBe('object');
    }
  });

  it('publishes no body for a read', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    expect(op(document, '/v1/documents', 'get').requestBody).toBeUndefined();
  });

  it('publishes the upload body closed, so a client cannot send an object key', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    const schema = op(document, '/v1/documents/upload-url', 'post').requestBody.content[
      'application/json'
    ].schema;

    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).not.toContain('objectKey');
  });
});

describe('query parameters', () => {
  it('publishes the listing filters as query parameters', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    const parameters = op(document, '/v1/documents', 'get').parameters as Array<{
      name: string;
      in: string;
      required: boolean;
    }>;

    const names = parameters.map((parameter) => parameter.name);
    expect(names).toEqual(
      expect.arrayContaining(['documentClass', 'includeDeleted', 'limit', 'cursor']),
    );
    for (const parameter of parameters) expect(parameter.in).toBe('query');
  });

  it('marks a filter with a default as not required', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    const parameters = op(document, '/v1/documents', 'get').parameters as Array<{
      name: string;
      required: boolean;
    }>;

    expect(parameters.find((p) => p.name === 'limit')?.required).toBe(false);
  });
});

describe('success statuses', () => {
  it('publishes 201 for the calls that create something', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    expect(op(document, '/v1/documents/upload-url', 'post').responses['201']).toBeDefined();
    expect(op(document, '/v1/documents', 'post').responses['201']).toBeDefined();
  });

  it('publishes 200 for issuing a download URL, which creates nothing', () => {
    // The controller answers 200 (`@HttpCode`). Publishing 201 would be a
    // contract that disagrees with the service, and a client checking for 201
    // would read every successful request as a failure.
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    const responses = op(document, '/v1/documents/{id}/download-url', 'post').responses;

    expect(responses['200']).toBeDefined();
    expect(responses['201']).toBeUndefined();
  });

  it('publishes 200 for reads and for deletion', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    expect(op(document, '/v1/documents', 'get').responses['200']).toBeDefined();
    expect(op(document, '/v1/documents/{id}', 'delete').responses['200']).toBeDefined();
  });
});

describe('error responses', () => {
  it('gives every operation the platform error shape', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);

    for (const status of ['400', '401', '403', '404', '409', '422', '500']) {
      const response = op(document, '/v1/documents', 'get').responses[status];
      expect(response.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/ApiError',
      );
    }
  });

  it('registers the error schema once, in components', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    expect(document.components?.schemas?.ApiError).toMatchObject({ type: 'object' });
  });

  it('says what a 404 means here, because it is not only absence', () => {
    // A document owned by another organization is reported as not found so its
    // existence is never disclosed. A client that read 404 as "deleted" would
    // build the wrong retry.
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    expect(op(document, '/v1/documents/{id}', 'get').responses['404'].description).toMatch(
      /another organization/i,
    );
  });

  it('names the scan state among the reasons a 422 happens', () => {
    const document = enrichOpenApiDocument(nestDocument(), OPTIONS);
    expect(op(document, '/v1/documents/{id}/download-url', 'post').responses['422']).toMatchObject({
      description: expect.stringMatching(/scan state/i) as unknown as string,
    });
  });
});

describe('the durations a client has to plan around', () => {
  it('states the configured signed-URL and intent lifetimes on the upload endpoint', () => {
    const document = enrichOpenApiDocument(nestDocument(), {
      signedUrlTtlSeconds: 120,
      uploadIntentTtlSeconds: 600,
    });

    const description = op(document, '/v1/documents/upload-url', 'post').description as string;
    expect(description).toContain('Base text.');
    expect(description).toContain('120 seconds');
    expect(description).toContain('600 seconds');
  });

  it('states the configured lifetime on the download endpoint', () => {
    const document = enrichOpenApiDocument(nestDocument(), {
      signedUrlTtlSeconds: 120,
      uploadIntentTtlSeconds: 600,
    });

    expect(op(document, '/v1/documents/{id}/download-url', 'post').description).toContain(
      '120 seconds',
    );
  });

  it('takes them from configuration rather than a constant', () => {
    // Two deployments, two documents. A constant here would be a second source
    // of truth that silently disagrees with the deployment being read.
    const first = enrichOpenApiDocument(nestDocument(), OPTIONS);
    const second = enrichOpenApiDocument(nestDocument(), {
      signedUrlTtlSeconds: 900,
      uploadIntentTtlSeconds: 3600,
    });

    expect(op(first, '/v1/documents/upload-url', 'post').description).toContain('300 seconds');
    expect(op(second, '/v1/documents/upload-url', 'post').description).toContain('900 seconds');
  });
});

describe('a document with nothing in it', () => {
  it('is enriched without throwing', () => {
    // Nest hands over whatever the decorators produced. An empty or partial
    // document must not take the service down at bootstrap.
    const empty = { openapi: '3.0.0', info: { title: 't', version: '1' } } as OpenAPIObject;
    expect(() => enrichOpenApiDocument(empty, OPTIONS)).not.toThrow();
  });

  it('ignores a path entry that is not an operation', () => {
    const document = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: { '/v1/documents': { parameters: [] } },
    } as unknown as OpenAPIObject;

    expect(() => enrichOpenApiDocument(document, OPTIONS)).not.toThrow();
  });
});
