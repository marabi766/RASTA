import { z } from 'zod';
import { RastaError } from '../errors/rasta-error';
import { validateRequestInput } from '../pipes/zod-validation.pipe';
import { publishedApiErrorSchema } from './api-error';
import {
  PROBE_CONTEXTS,
  PROBE_TRACEPARENT,
  httpErrorBodyProblems,
  publishedPathOf,
  errorEnvelopeProblems,
  publishedErrorResponses,
  realFilterResponse,
  validatePublishedBody,
  type PublishedDocument,
} from './published-body';
import { toJsonSchema } from './zod-schema';

/**
 * The conformance check itself (audit 10-26 F3): the published envelope accepts what the real
 * filter writes, and the check fails for a document that does not.
 */

/** A document with one operation answering `statuses` with `schema` (a component, or inline). */
function documentOf(
  envelope: z.ZodTypeAny,
  statuses: string[],
  inline?: z.ZodTypeAny,
): PublishedDocument {
  const responses = Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: status,
        content: {
          'application/json': {
            schema: inline ? toJsonSchema(inline) : { $ref: '#/components/schemas/ApiError' },
          },
        },
      },
    ]),
  );
  return {
    paths: { '/v1/things': { post: { responses } } },
    components: { schemas: { ApiError: toJsonSchema(envelope) } },
  };
}

const STATUSES = ['400', '401', '403', '404', '409', '422', '500', '503'];

describe('the published error envelope', () => {
  it('accepts every body the real filter writes, with and without trace and path', () => {
    const document = documentOf(publishedApiErrorSchema, STATUSES);
    expect(errorEnvelopeProblems(document)).toEqual([]);
  });

  it('is closed: an unknown field and a missing timestamp are refused', () => {
    const document = documentOf(publishedApiErrorSchema, ['404']);
    const schema = publishedErrorResponses(document)[0]!.schema!;
    const { body } = realFilterResponse(
      RastaError.notFound('Thing'),
      PROBE_CONTEXTS['trace and path known'],
    );
    expect(validatePublishedBody(document, schema, body)).toEqual([]);
    expect(validatePublishedBody(document, schema, { ...(body as object), extra: 1 })).not.toEqual(
      [],
    );
    const { timestamp: _t, ...without } = body as Record<string, unknown>;
    expect(validatePublishedBody(document, schema, without)).not.toEqual([]);
  });

  it('writes the optional fields only when the request context has them', () => {
    const known = PROBE_CONTEXTS['trace and path known'];
    const withBoth = realFilterResponse(RastaError.notFound('Thing'), known).body as object;
    expect(Object.keys(withBoth).sort()).toEqual(
      ['code', 'correlationId', 'message', 'path', 'timestamp', 'traceId'].sort(),
    );
    const without = realFilterResponse(RastaError.notFound('Thing')).body as object;
    expect(Object.keys(without).sort()).toEqual(['code', 'correlationId', 'message', 'timestamp']);
  });

  it('carries a validation failure from the shared pipe as typed details', () => {
    const document = documentOf(publishedApiErrorSchema, ['400']);
    const schema = publishedErrorResponses(document)[0]!.schema!;
    const failure = (() => {
      try {
        return validateRequestInput(z.object({ quantity: z.number().int().min(1) }).strict(), {
          quantity: 0,
          extra: true,
        });
      } catch (error) {
        return error;
      }
    })();
    const { status, body } = realFilterResponse(failure, PROBE_CONTEXTS['trace and path known']);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((body as { details: unknown[] }).details.length).toBeGreaterThan(0);
    expect(validatePublishedBody(document, schema, body)).toEqual([]);
  });

  describe('fails for a document that does not match', () => {
    it('the strict local copy without timestamp, traceId and path (the audit finding)', () => {
      const local = z
        .object({
          code: z.string(),
          message: z.string(),
          correlationId: z.string().optional(),
          details: z.array(z.unknown()).optional(),
        })
        .strict();
      const problems = errorEnvelopeProblems(documentOf(local, ['404', '500']));
      expect(problems).not.toEqual([]);
      expect(problems.join('\n')).toContain('timestamp: not allowed');
    });

    it('a schema that lost a field the filter sends only with a trace', () => {
      const withoutTrace = publishedApiErrorSchema.omit({ traceId: true }).strict();
      const problems = errorEnvelopeProblems(documentOf(withoutTrace, ['404']));
      expect(problems.join('\n')).toContain('traceId: not allowed');
    });

    it('an open schema, which would accept a field nobody sends', () => {
      const open = publishedApiErrorSchema.loose();
      const problems = errorEnvelopeProblems(documentOf(open, ['404']));
      expect(problems.join('\n')).toContain('a field the platform never sends was accepted');
    });

    it('a schema that no longer requires timestamp', () => {
      const optional = publishedApiErrorSchema
        .extend({ timestamp: z.string().optional() })
        .strict();
      const problems = errorEnvelopeProblems(documentOf(optional, ['404']));
      expect(problems.join('\n')).toContain('a body without timestamp was accepted');
    });

    it('an error response that documents no JSON body', () => {
      const document: PublishedDocument = {
        paths: { '/v1/things': { get: { responses: { '404': { description: 'x' } } } } },
      };
      expect(errorEnvelopeProblems(document)).toEqual([
        'GET /v1/things 404: documents no JSON body',
      ]);
    });
  });

  describe('typed refusals', () => {
    const typed = publishedApiErrorSchema.extend({
      details: z
        .array(
          z
            .object({
              path: z.literal('stock'),
              code: z.enum(['ON_HAND_WOULD_BE_NEGATIVE', 'QUANTITY_OUT_OF_RANGE']),
              message: z.string(),
            })
            .strict(),
        )
        .optional(),
    });
    const refusal = (area: string, code: string) =>
      new RastaError('BUSINESS_RULE_VIOLATION', 'Refused', {
        details: [{ path: area, code, message: `${area}: ${code}` }],
      });

    it('accepts the body of every listed reason', () => {
      expect(errorEnvelopeProblems(documentOf(typed, ['422'], typed), { refusal })).toEqual([]);
    });

    it('needs a producer for a document that lists reasons', () => {
      expect(errorEnvelopeProblems(documentOf(typed, ['422'], typed)).join('\n')).toContain(
        'no refusal producer was given',
      );
    });

    it('fails when the service answers a reason under another status', () => {
      const conflict = (area: string, code: string) =>
        new RastaError('INVALID_STATE_TRANSITION', 'Refused', {
          details: [{ path: area, code, message: 'm' }],
        });
      expect(
        errorEnvelopeProblems(documentOf(typed, ['422'], typed), { refusal: conflict }).join('\n'),
      ).toContain('is answered 409, not 422');
    });
  });
});

describe('httpErrorBodyProblems', () => {
  const document = documentOf(publishedApiErrorSchema, ['404']);
  const traceId = PROBE_TRACEPARENT.split('-')[1]!;
  const sent = (traced: boolean) =>
    realFilterResponse(RastaError.notFound('Thing'), {
      correlationId: 'c-1',
      path: '/v1/things/x',
      ...(traced ? { traceId } : {}),
    }).body;
  const at = { method: 'POST', url: '/v1/things', status: 404 };

  it('accepts a traced and an untraced answer', () => {
    expect(httpErrorBodyProblems(document, { ...at, body: sent(true), traced: true })).toEqual([]);
    expect(httpErrorBodyProblems(document, { ...at, body: sent(false), traced: false })).toEqual(
      [],
    );
  });

  it('notices a traceparent that did not come back, and a traceId nobody sent', () => {
    expect(
      httpErrorBodyProblems(document, { ...at, body: sent(false), traced: true }).join(),
    ).toContain('did not come back');
    expect(
      httpErrorBodyProblems(document, { ...at, body: sent(true), traced: false }).join(),
    ).toContain('traceId without a traceparent');
  });

  it('notices an answer with no path, an unknown field and an undocumented status', () => {
    const { path: _path, ...noPath } = sent(false) as Record<string, unknown>;
    expect(
      httpErrorBodyProblems(document, { ...at, body: noPath, traced: false }).join(),
    ).toContain('no path');
    expect(
      httpErrorBodyProblems(document, {
        ...at,
        body: { ...(sent(false) as object), x: 1 },
        traced: false,
      }).join(),
    ).toContain('x: not allowed');
    expect(
      httpErrorBodyProblems(document, { ...at, status: 409, body: sent(false), traced: false }),
    ).toHaveLength(1);
  });

  it('finds the template of a concrete url, the most specific first', () => {
    const paths = {
      '/v1/stock/{id}': {},
      '/v1/stock/reservations': {},
      '/v1/stock/reservations/{id}/release': {},
    };
    const doc = { paths } as PublishedDocument;
    expect(publishedPathOf(doc, '/v1/stock/STK_1?x=1')).toBe('/v1/stock/{id}');
    expect(publishedPathOf(doc, '/v1/stock/reservations')).toBe('/v1/stock/reservations');
    expect(publishedPathOf(doc, '/v1/stock/reservations/RSV_1/release')).toBe(
      '/v1/stock/reservations/{id}/release',
    );
    expect(publishedPathOf(doc, '/v1/other')).toBeUndefined();
  });
});
