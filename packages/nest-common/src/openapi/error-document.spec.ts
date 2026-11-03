import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { RastaError } from '../errors/rasta-error';
import { publishedApiErrorSchema } from './api-error';
import { toJsonSchema } from './zod-schema';
import { healthProbeErrorSchema, publishApiErrors } from './error-document';
import {
  probeExceptionProblems,
  errorEnvelopeProblems,
  publishedResponseSchemaOf,
  realFilterResponse,
  validatePublishedBody,
  type PublishedDocument,
} from './published-body';

function fixture(): PublishedDocument {
  return {
    paths: {
      '/things': {
        parameters: [],
        get: {
          responses: {
            '200': { description: 'Success' },
            '404': { description: 'Absent', headers: { 'Retry-After': {} } },
            '4XX': { description: 'Refused' },
          },
        },
      },
      '/health/ready': { get: { responses: { '200': { description: 'Success' } } } },
    },
  };
}

const BODY = {
  status: 'unavailable',
  service: 'test-service',
  checks: { database: false, kafka: true },
  degraded: [],
};
const EXCEPTIONS = [
  { service: 'test-service', path: '/health/ready', status: 503, bodies: [BODY] },
] as const;
function document(): PublishedDocument {
  return publishApiErrors(fixture(), {
    'GET /health/ready 503': healthProbeErrorSchema('test-service', 'ready'),
  });
}

describe('shared error publication with explicit D-121 exceptions', () => {
  it('probes every typed refusal in a union of detail areas', () => {
    const result = publishApiErrors(fixture());
    const detail = (area: string, code: string) =>
      z.object({ path: z.literal(area), code: z.literal(code), message: z.string() }).strict();
    const typed = publishedApiErrorSchema.extend({
      details: z
        .array(z.union([detail('opening', 'NOT_OPENED'), detail('approval', 'GATED')]))
        .optional(),
    });
    const item = result.paths!['/things'] as { get: { responses: Record<string, unknown> } };
    item.get.responses['422'] = {
      content: { 'application/json': { schema: toJsonSchema(typed) } },
    };
    const called: string[] = [];
    expect(
      errorEnvelopeProblems(result, {
        refusal: (area, code) => {
          called.push(`${area}/${code}`);
          return new RastaError('BUSINESS_RULE_VIOLATION', 'Refused', {
            details: [{ path: area, code, message: 'Refused' }],
          });
        },
      }),
    ).toEqual([]);
    expect(called).toEqual(['opening/NOT_OPENED', 'approval/GATED']);
  });

  it('covers every operation, existing status and range; preserves success, headers and descriptions', () => {
    const result = document();
    expect(probeExceptionProblems(result, 'test-service', EXCEPTIONS)).toEqual([]);
    expect(result.paths!['/things']).toMatchObject({
      get: {
        responses: {
          '200': { description: 'Success' },
          '404': { description: 'Absent', headers: { 'Retry-After': {} } },
        },
      },
    });
    const schema = publishedResponseSchemaOf(result, 'get', '/things', 500);
    expect(
      validatePublishedBody(
        result,
        schema,
        realFilterResponse(new HttpException('Refused', 500)).body,
      ),
    ).toEqual([]);
  });

  it('refuses an unlisted health exception, a different service, missing response and missing real bodies', () => {
    expect(probeExceptionProblems(document(), 'test-service', [])).toContain(
      'GET /health/ready 503: does not use the shared envelope',
    );
    expect(
      probeExceptionProblems(document(), 'another-service', EXCEPTIONS).length,
    ).toBeGreaterThan(0);
    expect(
      probeExceptionProblems(document(), 'test-service', [{ ...EXCEPTIONS[0], path: '/missing' }])
        .length,
    ).toBeGreaterThan(0);
    expect(
      probeExceptionProblems(document(), 'test-service', [{ ...EXCEPTIONS[0], bodies: [] }]).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a health schema that does not validate the real body', () => {
    const result = document();
    const schema = publishedResponseSchemaOf(result, 'get', '/health/ready', 503);
    const health = (schema.anyOf as Record<string, unknown>[])[1];
    health.required = ['newRequiredField'];
    expect(probeExceptionProblems(result, 'test-service', EXCEPTIONS).length).toBeGreaterThan(0);
  });

  it('refuses a new operation with no envelope, even when other operations have it', () => {
    const result = document();
    result.paths!['/new'] = { post: { responses: { '201': { description: 'Created' } } } };
    expect(probeExceptionProblems(result, 'test-service', EXCEPTIONS)).toContain(
      'POST /new: no default error response',
    );
  });

  it('fails generation for an exception whose route disappeared', () => {
    expect(() => publishApiErrors(fixture(), { 'GET /missing 503': {} })).toThrow('no operation');
  });

  it('does not hide an explicit response with no schema behind the default', () => {
    const result = document();
    const item = result.paths!['/things'] as { get: { responses: Record<string, unknown> } };
    item.get.responses['404'] = { description: 'Missing body' };
    expect(() => publishedResponseSchemaOf(result, 'get', '/things', 404)).toThrow('no JSON body');
  });

  it('resolves status ranges before the default', () => {
    const result = document();
    const item = result.paths!['/things'] as { get: { responses: Record<string, unknown> } };
    item.get.responses['4XX'] = { content: { 'application/json': { schema: { type: 'string' } } } };
    expect(publishedResponseSchemaOf(result, 'get', '/things', 401)).toEqual({ type: 'string' });
  });
});
