import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { WITHOUT_BIDI_CONTROL } from '@rasta/contracts';
import {
  RESPONSE_BODIES,
  buildContractOpenApiDocument,
  buildDocumentationApp,
  formatDocument,
} from './document';

/**
 * The committed contract is exactly what the generator produces.
 *
 * `docs/api/contract-service.openapi.json` is checked in so an API change shows in a PR's
 * diff; this spec turns "remember to regenerate" into a failing test. That the document
 * describes the **real** application is `test/openapi.int-spec.ts`.
 */
describe('the committed OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildDocumentationApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const committedPath = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'docs',
    'api',
    'contract-service.openapi.json',
  );

  it('matches the generator byte for byte (run `pnpm openapi:generate` after changing the API)', () => {
    const generated = formatDocument(buildContractOpenApiDocument(app), committedPath);
    expect(readFileSync(committedPath, 'utf8')).toBe(generated);
  });

  it('publishes the reads and commands of CON-003, its amendments and milestones and the approval-policy routes, each closed, and no route that creates a contract', () => {
    const document = buildContractOpenApiDocument(app);
    const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(
        item as Record<string, { security?: unknown; responses: Record<string, unknown> }>,
      ).map(([method, operation]) => ({ key: `${method.toUpperCase()} ${path}`, operation })),
    );

    expect(operations.map((o) => o.key).sort()).toEqual(Object.keys(RESPONSE_BODIES).sort());
    expect(operations.map((o) => o.key).sort()).toEqual([
      'GET /v1/approval-policies',
      'GET /v1/approval-policies/pending-platform-approval',
      'GET /v1/approval-policies/{id}',
      'GET /v1/contracts',
      'GET /v1/contracts/{id}',
      'GET /v1/contracts/{id}/amendments',
      'GET /v1/contracts/{id}/amendments/{amendmentId}',
      'GET /v1/contracts/{id}/milestones',
      'GET /v1/contracts/{id}/milestones/{milestoneId}',
      'PATCH /v1/contracts/{id}/milestones/{milestoneId}',
      'POST /v1/approval-policies',
      'POST /v1/approval-policies/{id}/approve',
      'POST /v1/approval-policies/{id}/reject',
      'POST /v1/approval-policies/{id}/retire',
      'POST /v1/approval-policies/{id}/submit',
      'POST /v1/contracts/{id}/amendments',
      'POST /v1/contracts/{id}/amendments/{amendmentId}/sign',
      'POST /v1/contracts/{id}/cancel',
      'POST /v1/contracts/{id}/milestones',
      'POST /v1/contracts/{id}/sign',
    ]);
    for (const { key, operation } of operations) {
      expect(operation.security).toEqual([{ bearer: [] }]);
      // The routes that create (a policy, an amendment, a milestone) answer 201; every other 200.
      const created = [
        'POST /v1/approval-policies',
        'POST /v1/contracts/{id}/amendments',
        'POST /v1/contracts/{id}/milestones',
      ].includes(key);
      expect(operation.responses['200'] !== undefined).toBe(!created);
      expect(operation.responses['201'] !== undefined).toBe(created);
    }
  });

  describe('the approval-policy routes (ADR-068 § 5, Q-70 (7))', () => {
    type Op = { parameters: { name: string; in: string }[]; responses: Record<string, unknown> };
    const operation = (path: string, method: 'get' | 'post'): Op =>
      (buildContractOpenApiDocument(app).paths?.[path] as unknown as Record<string, Op>)[method]!;

    it('requires an Idempotency-Key on the create only', () => {
      const headerOf = (op: Op) =>
        op.parameters.filter((parameter) => parameter.in === 'header').map((p) => p.name);
      expect(headerOf(operation('/v1/approval-policies', 'post'))).toEqual(['Idempotency-Key']);
      for (const verb of ['submit', 'approve', 'reject', 'retire']) {
        expect(headerOf(operation(`/v1/approval-policies/{id}/${verb}`, 'post'))).toEqual([]);
      }
    });

    it('answers 503 and 504 only where organization-service is asked: create, submit, approve', () => {
      const asks = (path: string) =>
        ['503', '504'].map((s) => operation(path, 'post').responses[s] !== undefined);
      expect(asks('/v1/approval-policies')).toEqual([true, true]);
      expect(asks('/v1/approval-policies/{id}/submit')).toEqual([true, true]);
      expect(asks('/v1/approval-policies/{id}/approve')).toEqual([true, true]);
      expect(asks('/v1/approval-policies/{id}/reject')).toEqual([false, false]);
      expect(asks('/v1/approval-policies/{id}/retire')).toEqual([false, false]);
    });

    it('types the create’s 422 with the closed policy reason', () => {
      const schema = (
        operation('/v1/approval-policies', 'post').responses['422'] as {
          content: Record<
            string,
            {
              schema: {
                properties: {
                  details: {
                    items: { properties: { path: { const: string }; code: { enum: string[] } } };
                  };
                };
              };
            }
          >;
        }
      ).content['application/json']!.schema;
      expect(schema.properties.details.items.properties.path.const).toBe('policy');
      expect(schema.properties.details.items.properties.code.enum).toEqual([
        'AUTHORITY_NOT_GOVERNED_ORGANIZATION',
      ]);
    });

    it('never offers the oversight role or the platform operator as an authority', () => {
      const body = (
        buildContractOpenApiDocument(app).paths?.['/v1/approval-policies'] as unknown as {
          post: {
            requestBody: {
              content: Record<string, { schema: { properties: { steps: { items: unknown } } } }>;
            };
          };
        }
      ).post.requestBody.content['application/json']!.schema.properties.steps.items;
      const text = JSON.stringify(body);
      // The enum of authority roles lists every platform role but these two.
      expect(text).not.toContain('"AUDITOR"');
      expect(text).not.toContain('"SYSTEM_ADMIN"');
    });
  });

  it('documents 400 on the list (a query) and the commands (a body and a key), 404 on every route by id, 409 and 422 only on the commands', () => {
    const document = buildContractOpenApiDocument(app);
    const responses = (path: string, method: 'get' | 'post') =>
      (document.paths?.[path] as Record<string, { responses: Record<string, unknown> }>)[method]!
        .responses;
    const list = responses('/v1/contracts', 'get');
    const read = responses('/v1/contracts/{id}', 'get');
    expect(list['400']).toBeDefined();
    expect(list['404']).toBeUndefined();
    expect(read['400']).toBeUndefined();
    expect(read['404']).toBeDefined();
    for (const reader of [list, read]) {
      expect(reader['409']).toBeUndefined();
      expect(reader['422']).toBeUndefined();
    }
    for (const command of ['sign', 'cancel']) {
      const answered = responses(`/v1/contracts/{id}/${command}`, 'post');
      for (const status of ['200', '400', '401', '403', '404', '409', '422']) {
        expect({ command, status, documented: answered[status] !== undefined }).toEqual({
          command,
          status,
          documented: true,
        });
      }
    }
  });

  describe('the commands', () => {
    type Operation = {
      parameters: { name: string; in: string; required?: boolean; schema?: unknown }[];
      requestBody: {
        required: boolean;
        content: Record<string, { schema: Record<string, unknown> }>;
      };
      responses: Record<
        string,
        {
          headers?: Record<string, unknown>;
          content: Record<string, { schema: Record<string, unknown> }>;
        }
      >;
    };
    const operation = (command: 'sign' | 'cancel'): Operation =>
      (
        buildContractOpenApiDocument(app).paths?.[`/v1/contracts/{id}/${command}`] as unknown as {
          post: Operation;
        }
      ).post;

    it.each(['sign', 'cancel'] as const)(
      '%s requires an Idempotency-Key of 8 to 255 characters and takes a strict body',
      (command) => {
        const post = operation(command);
        const header = post.parameters.filter((parameter) => parameter.in === 'header');
        expect(header).toEqual([
          expect.objectContaining({
            name: 'Idempotency-Key',
            required: true,
            schema: { type: 'string', minLength: 8, maxLength: 255 },
          }),
        ]);
        const body = post.requestBody.content['application/json']!.schema as {
          additionalProperties?: boolean;
        };
        expect(post.requestBody.required).toBe(true);
        expect(body.additionalProperties).toBe(false);
      },
    );

    it('cancel names a closed reason code and a bounded note without bidirectional controls', () => {
      const body = operation('cancel').requestBody.content['application/json']!.schema as {
        required: string[];
        properties: Record<string, { pattern?: string; maxLength?: number }>;
      };
      expect(body.required).toEqual(['reasonCode']);
      expect(body.properties.reasonCode?.pattern).toBe('^[A-Z][A-Z0-9_]{1,63}$');
      expect(body.properties.note?.maxLength).toBe(1000);
      expect(body.properties.note?.pattern).toBe(WITHOUT_BIDI_CONTROL.source);
    });

    it('types each refusal’s details by area with the closed codes answered with that status (docs/06 § 6.7)', () => {
      const codesOf = (command: 'sign' | 'cancel', status: string) => {
        const schema = operation(command).responses[status]!.content['application/json']!
          .schema as {
          properties: {
            details: {
              items: { properties: { path: { const: string }; code: { enum: string[] } } };
            };
          };
        };
        const item = schema.properties.details.items.properties;
        return { area: item.path.const, codes: item.code.enum };
      };
      expect(codesOf('sign', '403')).toEqual({
        area: 'signature',
        codes: ['POLICY_AUTHOR_NOT_GOVERNING', 'MEMBER_OF_BOTH_PARTIES', 'SAME_PERSON_BOTH_SIDES'],
      });
      expect(codesOf('sign', '409')).toEqual({ area: 'signature', codes: ['SIDE_ALREADY_SIGNED'] });
      expect(codesOf('sign', '422')).toEqual({
        area: 'signature',
        codes: ['SIGNATURE_POLICY_REQUIRED', 'CONTRACT_NOT_DRAFT', 'ACTOR_IDENTITY_UNKNOWN'],
      });
      expect(codesOf('cancel', '422')).toEqual({
        area: 'cancellation',
        codes: ['CANCEL_REASON_NOT_ALLOWED', 'CONTRACT_NOT_DRAFT', 'SIGNATURE_RECORDED'],
      });
      // Cancel has no reason answered 403 or 409: those statuses keep the plain error body.
      expect(operation('cancel').responses['403']!.content['application/json']!.schema).toEqual({
        $ref: '#/components/schemas/ApiError',
      });
    });

    it('sends Retry-After only on a command’s 409', () => {
      for (const command of ['sign', 'cancel'] as const) {
        const responses = operation(command).responses;
        expect(responses['409']!.headers).toHaveProperty('Retry-After');
        expect(responses['422']!.headers).toBeUndefined();
      }
    });
  });

  describe('the amendment and milestone routes (CON-003 PR 3)', () => {
    type Op = {
      parameters: { name: string; in: string; required?: boolean; schema?: unknown }[];
      requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
      responses: Record<
        string,
        { content: Record<string, { schema: Record<string, unknown> }>; headers?: unknown }
      >;
    };
    const operation = (path: string, method: 'get' | 'post' | 'patch'): Op =>
      (buildContractOpenApiDocument(app).paths?.[path] as unknown as Record<string, Op>)[method]!;
    const COMMANDS = [
      ['/v1/contracts/{id}/amendments', 'post'],
      ['/v1/contracts/{id}/amendments/{amendmentId}/sign', 'post'],
      ['/v1/contracts/{id}/milestones', 'post'],
      ['/v1/contracts/{id}/milestones/{milestoneId}', 'patch'],
    ] as const;

    it.each(COMMANDS)(
      '%s %s requires an Idempotency-Key of 8 to 255 characters and takes a strict body',
      (path, method) => {
        const op = operation(path, method);
        expect(op.parameters.filter((p) => p.in === 'header')).toEqual([
          expect.objectContaining({
            name: 'Idempotency-Key',
            required: true,
            schema: { type: 'string', minLength: 8, maxLength: 255 },
          }),
        ]);
        const body = op.requestBody!.content['application/json']!.schema as {
          additionalProperties?: boolean;
        };
        expect(body.additionalProperties).toBe(false);
        expect(op.responses['409']!.headers).toHaveProperty('Retry-After');
      },
    );

    it('reads are keyless and cannot answer 409 or 422', () => {
      for (const path of [
        '/v1/contracts/{id}/amendments',
        '/v1/contracts/{id}/amendments/{amendmentId}',
        '/v1/contracts/{id}/milestones',
        '/v1/contracts/{id}/milestones/{milestoneId}',
      ]) {
        const op = operation(path, 'get');
        expect(op.parameters.filter((p) => p.in === 'header')).toEqual([]);
        expect(op.responses['409']).toBeUndefined();
        expect(op.responses['422']).toBeUndefined();
        expect(op.responses['404']).toBeDefined();
      }
    });

    it('sends every amount as a string and the planned day as a date, never an instant', () => {
      const amendment = (
        operation('/v1/contracts/{id}/amendments/{amendmentId}', 'get').responses['200']!.content[
          'application/json'
        ]!.schema as { properties: Record<string, { type?: string }> }
      ).properties;
      expect(amendment.deltaMinor?.type).toBe('string');
      const request = operation('/v1/contracts/{id}/amendments', 'post').requestBody!.content[
        'application/json'
      ]!.schema as { properties: Record<string, { type?: string; maxLength?: number }> };
      expect(request.properties.deltaMinor?.type).toBe('string');
      expect(request.properties.reasonText?.maxLength).toBe(1000);
      const milestone = operation('/v1/contracts/{id}/milestones', 'post').requestBody!.content[
        'application/json'
      ]!.schema as { required: string[]; properties: Record<string, { pattern?: string }> };
      expect(milestone.required).toEqual(['title', 'plannedDate']);
      expect(milestone.properties.plannedDate?.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    });

    it('types each refusal’s details by area with the closed codes answered with that status', () => {
      const codesOf = (path: string, method: 'post' | 'patch', status: string) => {
        const schema = operation(path, method).responses[status]!.content['application/json']!
          .schema as {
          properties: {
            details: {
              items: { properties: { path: { const: string }; code: { enum: string[] } } };
            };
          };
        };
        const item = schema.properties.details.items.properties;
        return { area: item.path.const, codes: item.code.enum };
      };
      expect(codesOf('/v1/contracts/{id}/amendments', 'post', '403')).toEqual({
        area: 'amendment',
        codes: [
          'PROPOSER_NOT_EMPLOYER',
          'POLICY_AUTHOR_NOT_GOVERNING',
          'MEMBER_OF_BOTH_PARTIES',
          'SAME_PERSON_BOTH_SIDES',
        ],
      });
      expect(codesOf('/v1/contracts/{id}/amendments', 'post', '422').codes).toEqual(
        expect.arrayContaining([
          'AMENDMENT_DELTA_NOT_POSITIVE',
          'AMENDMENT_EXCEEDS_LIMIT',
          'AMENDMENT_REASON_NOT_ALLOWED',
          'CONTRACT_NOT_SIGNED',
        ]),
      );
      expect(codesOf('/v1/contracts/{id}/milestones/{milestoneId}', 'patch', '422')).toEqual({
        area: 'milestone',
        codes: ['CONTRACT_NOT_SIGNED', 'MILESTONE_REFERENCED', 'MILESTONE_LIMIT_REACHED'],
      });
      expect(codesOf('/v1/contracts/{id}/milestones', 'post', '403')).toEqual({
        area: 'milestone',
        codes: ['EDITOR_NOT_EMPLOYER'],
      });
    });

    it('answers 503 where a refusal is recorded or the hierarchy is asked, and 504 only for the latter', () => {
      const answers = (path: string, method: 'post' | 'patch') =>
        ['503', '504'].map((s) => operation(path, method).responses[s] !== undefined);
      expect(answers('/v1/contracts/{id}/amendments', 'post')).toEqual([true, false]);
      expect(answers('/v1/contracts/{id}/amendments/{amendmentId}/sign', 'post')).toEqual([
        true,
        true,
      ]);
      expect(answers('/v1/contracts/{id}/milestones', 'post')).toEqual([true, false]);
      expect(answers('/v1/contracts/{id}/milestones/{milestoneId}', 'patch')).toEqual([
        true,
        false,
      ]);
    });
  });

  it('sends the amount as a string and shows a party nothing of who awarded', () => {
    const document = buildContractOpenApiDocument(app);
    const view = document.paths?.['/v1/contracts/{id}']?.get as unknown as {
      responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
    };
    const schema = view.responses['200']?.content['application/json']?.schema as {
      properties: Record<string, { type?: string }>;
    };
    expect(schema.properties.amountMinor?.type).toBe('string');
    for (const hidden of ['awardedBy', 'matrixDigest', 'createdBy', 'signedBy']) {
      expect(schema.properties).not.toHaveProperty(hidden);
    }
  });

  it('keeps the health probes out of the contract', () => {
    const document = buildContractOpenApiDocument(app);
    expect(Object.keys(document.paths ?? {}).some((path) => path.startsWith('/health'))).toBe(
      false,
    );
  });
});
