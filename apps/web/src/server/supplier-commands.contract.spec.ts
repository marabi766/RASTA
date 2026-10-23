/**
 * @jest-environment node
 */
import { UNSUPPORTED_CHARACTERS, plainText, referenceId } from '@rasta/contracts';
import ts from 'typescript';
import { z } from 'zod';

import {
  ALREADY_REGISTERED_MESSAGE,
  APPROVE_FIELDS,
  EVIDENCE_ID_PREFIX,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_DOCUMENT_ID_LENGTH,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_LABEL_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_STATEMENT_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  MIN_REASON_LENGTH,
  REGISTER_FIELDS,
  REJECT_FIELDS,
  SUBMIT_FIELDS,
  STALE_MESSAGE,
  SUPPLIER_422_PATTERNS,
  SUPPLIER_VALIDATION_MESSAGES,
  SUSPENSION_EPISODE_CHANGED,
  approveFormSchema,
  registerFormSchema,
  rejectFormSchema,
  reinstateFormSchema,
  submitFormSchema,
  supplierFailureText,
  suspendFormSchema,
} from '@/lib/supplier-commands';
import { SUPPLIER_CAPABILITIES } from '@/lib/supplier-fields';
import {
  collect,
  decoratorOf,
  parseSource,
  readSource,
  schemaProperties,
  squash,
  topLevelConst,
} from '@/test/service-source';
import {
  BIDI_CONTROL_CODE_POINTS,
  OTHER_INVISIBLE_CODE_POINTS,
  formField,
  probesFrom,
} from '@/test/text-rules';

import {
  PLATFORM_ROLES,
  REASON_FIELD_MAPPING,
  SUPPLIER_SIDE_ROLES,
  approveQualification,
  provenUnwritten,
  registerSupplier,
} from './supplier-commands';

/**
 * What the supplier write screens depend on, pinned to supplier-service's
 * source — the technique of `asset-lifecycle-commands.contract.spec.ts`: A-02
 * forbids importing `services/*\/src`, so the portal keeps copies and this test
 * fails the moment a copy and its original disagree. supplier-service publishes
 * its OpenAPI document only from code (`openapi/document.ts`), so that file is
 * the contract read here. The reader refuses anything it cannot read literally.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SERVICE = ['services', 'supplier-service', 'src'] as const;
const controllerText = readSource(...SERVICE, 'supplier', 'supplier.controller.ts');
const controller = parseSource(controllerText);
const dto = parseSource(readSource(...SERVICE, 'supplier', 'dto.ts'));
const accessText = readSource(...SERVICE, 'access', 'access.ts');
const access = parseSource(accessText);
const capabilities = parseSource(readSource(...SERVICE, 'supplier', 'capabilities.ts'));
const documentText = readSource(...SERVICE, 'openapi', 'document.ts');
const routes = readSource('services', 'api-gateway', 'src', 'config', 'routes.ts');
const behaviour = [
  readSource(...SERVICE, 'supplier', 'qualification.service.ts'),
  readSource(...SERVICE, 'supplier', 'qualification.state-machine.ts'),
  readSource(...SERVICE, 'supplier', 'suspension.service.ts'),
  readSource(...SERVICE, 'supplier', 'suspension.state-machine.ts'),
  readSource(...SERVICE, 'supplier', 'supplier.service.ts'),
].join('\n');

const COMMANDS = [
  { method: 'register', verb: 'POST', path: '' },
  { method: 'submitQualification', verb: 'POST', path: ':id/qualifications' },
  {
    method: 'approveQualification',
    verb: 'POST',
    path: ':id/qualifications/:qualificationId/approve',
  },
  {
    method: 'rejectQualification',
    verb: 'POST',
    path: ':id/qualifications/:qualificationId/reject',
  },
  { method: 'suspend', verb: 'POST', path: ':id/suspend' },
  { method: 'reinstate', verb: 'POST', path: ':id/reinstate' },
] as const;

const arrayOf = (source: ts.SourceFile, name: string): string[] =>
  collect(topLevelConst(source, name), ts.isStringLiteral).map((node) => node.text);

describe('the six endpoints', () => {
  it.each(COMMANDS)('$method is a $verb of /v1/suppliers/$path', ({ method, verb, path }) => {
    const call = decoratorOf(controller, method, verb[0] + verb.slice(1).toLowerCase());
    expect(call).toBeDefined();
    const actual = call!.arguments.map((argument) =>
      ts.isStringLiteral(argument) ? argument.text : '?',
    );
    expect(actual).toEqual(path === '' ? [] : [path]);
  });

  it('are exactly the controller’s POSTs — a new write endpoint needs a screen or a line in STATUS', () => {
    const posts = collect(controller, ts.isMethodDeclaration)
      .filter((node) =>
        (ts.getDecorators(node) ?? []).some((d) => d.expression.getText().startsWith('Post(')),
      )
      .map((node) => node.name.getText())
      .sort();
    expect(posts).toEqual(COMMANDS.map((c) => c.method).sort());
  });

  it('take no Idempotency-Key: not the controller, not the OpenAPI document, not the gateway route', () => {
    expect(controllerText.toLowerCase()).not.toContain('idempotency');
    expect(documentText.toLowerCase()).not.toContain('idempotency');
    const rule = /\{ prefix: 'suppliers',[^}]*\}/.exec(routes)?.[0];
    expect(rule).toBeDefined();
    expect(rule).not.toContain('requiresIdempotencyKey');
  });

  it('answer no permission list: no response schema carries availableActions or permissions', () => {
    const dtoText = readSource(...SERVICE, 'supplier', 'dto.ts');
    expect(dtoText).not.toMatch(/availableActions|permissions/);
  });
});

describe('who may do what', () => {
  it('the role sets the portal mirrors are the service’s', () => {
    expect(arrayOf(access, 'SUPPLIER_SIDE_ROLES')).toEqual([...SUPPLIER_SIDE_ROLES]);
    expect(arrayOf(access, 'PLATFORM_ROLES')).toEqual([...PLATFORM_ROLES]);
  });

  it.each([
    ['register', '...SUPPLIER_SIDE_ROLES'],
    ['submitQualification', '...SUPPLIER_SIDE_ROLES'],
    ['approveQualification', '...PLATFORM_ROLES'],
    ['rejectQualification', '...PLATFORM_ROLES'],
    ['suspend', '...PLATFORM_ROLES'],
    ['reinstate', '...PLATFORM_ROLES'],
  ])('%s: the route guard names %s, spread from the constant', (method, expected) => {
    const roles = decoratorOf(controller, method, 'Roles');
    expect(roles?.arguments.map((a) => squash(a.getText()))).toEqual([expected]);
  });

  const body = (name: string) =>
    squash(
      collect(access, ts.isFunctionDeclaration)
        .find((node) => node.name?.text === name)
        ?.getText(),
    ) ?? '';

  it('register needs a supplier-side role and an organization, and refuses the oversight role', () => {
    const text = body('assertCanRegisterSupplier');
    expect(text).toContain('assertNotAuditor();');
    expect(text).toContain('!hasAnyRole(SUPPLIER_SIDE_ROLES)');
    expect(text).toContain('getOrganizationId();');
    // No administrator bypass: hasAnyRole is a plain membership test.
    expect(squash(accessText)).toContain(
      'functionhasAnyRole(roles:readonlystring[]):boolean{constcontext=getContext();returnroles.some((role)=>context.roles.includes(role));}',
    );
  });

  it('submit acts only as a supplier-side role of the supplier’s own organization', () => {
    const text = body('assertActingAsSupplier');
    expect(text).toContain('!hasAnyRole(SUPPLIER_SIDE_ROLES)');
    expect(text).toContain('getOrganizationId()!==supplier.organizationId');
    expect(text).toContain('RastaError.notFound');
  });

  it('a decision needs platform scope and refuses every member of the supplier’s organization', () => {
    expect(body('assertCanDecideAbout')).toContain('!hasPlatformScope()');
    expect(body('assertCanDecideAbout')).toContain('assertNotDecidingOwnCase(supplier);');
    expect(body('assertNotDecidingOwnCase')).toContain(
      'isMemberOfOrganization(supplier.organizationId)',
    );
    expect(body('hasPlatformScope')).toContain('PLATFORM_ROLES.some');
    expect(body('assertNotAuditor')).toContain("includes('AUDITOR')");
  });

  it('a decision does not ask for an organization: its handlers never call getOrganizationId', () => {
    const decisions = ['assertCanDecideAbout', 'assertNotDecidingOwnCase', 'hasPlatformScope'];
    for (const name of decisions) expect(body(name)).not.toContain('getOrganizationId');
  });

  it('only a SUBMITTED qualification is decided, and only a ACTIVE / SUSPENDED supplier is (re)instated', () => {
    const qualification = readSource(...SERVICE, 'supplier', 'qualification.state-machine.ts');
    expect(squash(qualification)).toContain("SUBMITTED:['APPROVED','REJECTED']");
    const suspension = readSource(...SERVICE, 'supplier', 'suspension.state-machine.ts');
    expect(squash(suspension)).toContain("ACTIVE:['SUSPENDED']");
    expect(squash(suspension)).toContain("SUSPENDED:['ACTIVE']");
  });

  it('a submission is blocked by one awaiting a decision or approved, never by a rejected one', () => {
    const text = squash(
      readSource(...SERVICE, 'supplier', 'qualification.state-machine.ts'),
    ) as string;
    expect(text).toContain("row.state==='SUBMITTED'");
    expect(text).toContain("row.state==='APPROVED'");
  });
});

describe('the request bodies', () => {
  const keys = (name: string) => [...schemaProperties(dto, name).keys()].sort();

  it('are the fields the forms send — and the service refuses any other (.strict())', () => {
    expect(keys('registerSupplierSchema')).toEqual([...REGISTER_FIELDS].sort());
    expect(keys('submitQualificationSchema')).toEqual([...SUBMIT_FIELDS].sort());
    expect(keys('approveQualificationSchema')).toEqual([...APPROVE_FIELDS].sort());
    expect(keys('rejectQualificationSchema')).toEqual([...REJECT_FIELDS].sort());
    // The episode is not a form field: it comes from the signed baseline
    // (`suspensionId`), and the service compares it in the write's transaction.
    expect(keys('suspendSupplierSchema')).toEqual(['latestSuspensionId', 'reason']);
    expect(keys('reinstateSupplierSchema')).toEqual(['reason', 'suspensionId']);
    for (const name of [
      'registerSupplierSchema',
      'submitQualificationSchema',
      'approveQualificationSchema',
      'rejectQualificationSchema',
      'suspendSupplierSchema',
      'reinstateSupplierSchema',
    ]) {
      expect(squash(topLevelConst(dto, name).getText())).toContain('.strict()');
    }
  });

  it('carry the bounds the forms copy', () => {
    const prop = (schema: string, key: string) =>
      squash(schemaProperties(dto, schema).get(key)) as string;
    expect(squash(topLevelConst(dto, 'statedReason').getText())).toBe(
      `plainText().min(${MIN_REASON_LENGTH}).max(${MAX_REASON_LENGTH})`,
    );
    expect(squash(topLevelConst(dto, 'identifier').getText())).toBe(
      `referenceId().min(1).max(${MAX_DOCUMENT_ID_LENGTH})`,
    );
    expect(prop('registerSupplierSchema', 'displayName')).toBe(
      `plainText().min(${MIN_DISPLAY_NAME_LENGTH}).max(${MAX_DISPLAY_NAME_LENGTH})`,
    );
    expect(prop('registerSupplierSchema', 'capabilities')).toBe(
      'z.array(capability).min(1).max(SUPPLIER_CAPABILITIES.length)',
    );
    expect(prop('submitQualificationSchema', 'statement')).toBe(
      `plainText().min(1).max(${MAX_STATEMENT_LENGTH}).optional()`,
    );
    expect(prop('submitQualificationSchema', 'evidence')).toBe(
      `z.array(qualificationEvidenceInputSchema).max(${MAX_EVIDENCE_ITEMS}).default([])`,
    );
    expect(prop('qualificationEvidenceInputSchema', 'documentId')).toBe('identifier');
    expect(prop('qualificationEvidenceInputSchema', 'label')).toBe(
      `plainText().min(1).max(${MAX_EVIDENCE_LABEL_LENGTH}).optional()`,
    );
    expect(prop('approveQualificationSchema', 'note')).toBe(
      `plainText().min(1).max(${MAX_NOTE_LENGTH}).optional()`,
    );
    expect(prop('rejectQualificationSchema', 'reason')).toBe('statedReason');
    expect(prop('rejectQualificationSchema', 'note')).toBe(
      `plainText().min(1).max(${MAX_NOTE_LENGTH}).optional()`,
    );
    expect(prop('suspendSupplierSchema', 'reason')).toBe('statedReason');
    expect(prop('reinstateSupplierSchema', 'reason')).toBe('statedReason');
  });

  it('use the capabilities the portal lists, in the service’s order', () => {
    expect(arrayOf(capabilities, 'SUPPLIER_CAPABILITIES')).toEqual([...SUPPLIER_CAPABILITIES]);
  });

  it('refuse a repeated capability and a repeated document with the sentences the portal knows', () => {
    expect(squash(readSource(...SERVICE, 'supplier', 'dto.ts'))).toContain(
      "message:'Acapabilitymaybeclaimedonlyonce'",
    );
    expect(squash(readSource(...SERVICE, 'supplier', 'dto.ts'))).toContain(
      "message:'Thesamedocumentmaybeattachedonlyonce'",
    );
    expect(Object.keys(SUPPLIER_VALIDATION_MESSAGES).sort()).toEqual(
      [
        'A capability may be claimed only once',
        'The same document may be attached only once',
        UNSUPPORTED_CHARACTERS,
      ].sort(),
    );
  });

  it('the evidence rows are named by one prefix the reader and the form share', () => {
    expect(EVIDENCE_ID_PREFIX).toBe('evidenceDocumentId_');
  });
});

describe('the text rules the forms copy', () => {
  const PROSE = ['وزارت راه', 'a b c'];
  const bidi = PROSE.flatMap((sample) => probesFrom(sample, BIDI_CONTROL_CODE_POINTS));
  const invisible = PROSE.flatMap((sample) => probesFrom(sample, OTHER_INVISIBLE_CODE_POINTS));

  const admits = (schema: z.ZodTypeAny, value: string) => schema.safeParse(value).success;
  const sameAsService = (
    formSchema: z.ZodTypeAny,
    serviceSchema: z.ZodTypeAny,
    values: string[],
  ) => {
    for (const value of values) {
      expect({ value, admitted: admits(formSchema, value) }).toEqual({
        value,
        admitted: admits(serviceSchema, value),
      });
    }
  };

  const field = (schema: z.ZodTypeAny, key: string) => formField(schema, key);
  const everything = [
    ...bidi,
    ...invisible,
    '',
    ' ',
    'x'.repeat(8),
    'x'.repeat(501),
    'x'.repeat(2001),
  ];

  it('free text refuses bidirectional controls exactly where plainText() does', () => {
    sameAsService(
      field(registerFormSchema, 'displayName'),
      plainText().min(2).max(200),
      everything,
    );
    sameAsService(field(rejectFormSchema, 'reason'), plainText().min(8).max(500), everything);
    sameAsService(field(suspendFormSchema, 'reason'), plainText().min(8).max(500), everything);
    sameAsService(field(reinstateFormSchema, 'reason'), plainText().min(8).max(500), everything);
  });

  it('an optional note or statement is plainText() when it is given', () => {
    const optional = (schema: z.ZodTypeAny, key: string, max: number) => {
      for (const value of [...bidi, ...invisible, 'x'.repeat(max), 'x'.repeat(max + 1)]) {
        expect({ value: value.length, admitted: admits(field(schema, key), value) }).toEqual({
          value: value.length,
          admitted: admits(plainText().min(1).max(max), value),
        });
      }
    };
    optional(approveFormSchema, 'note', 2000);
    optional(rejectFormSchema, 'note', 2000);
  });

  it('a document id refuses every control and format character, as referenceId() does', () => {
    const row = (formField(submitFormSchema, 'evidence') as z.ZodArray<z.ZodTypeAny>).element;
    const service = referenceId().min(1).max(64);
    for (const value of [
      ...probesFrom('DOC_123', BIDI_CONTROL_CODE_POINTS),
      ...probesFrom('DOC_123', OTHER_INVISIBLE_CODE_POINTS),
      'D'.repeat(64),
      'D'.repeat(65),
    ]) {
      expect({ value, admitted: row.safeParse({ documentId: value, label: '' }).success }).toEqual({
        value,
        admitted: service.safeParse(value).success,
      });
    }
  });
});

describe('what the service refuses with a sentence, and how the portal says it', () => {
  const FRAGMENTS = [
    'is already awaiting a decision',
    'This supplier is already qualified for',
    'already exists for this supplier',
    'and cannot be decided again',
    'cannot move from',
    'was decided by somebody else first',
    'is already suspended',
    'is not suspended',
    'was suspended by somebody else first',
    'was reinstated by somebody else first',
  ];

  it('every 422 sentence the portal matches is still one the service writes', () => {
    expect(FRAGMENTS).toHaveLength(SUPPLIER_422_PATTERNS.length);
    for (const fragment of FRAGMENTS) expect(behaviour).toContain(fragment);
    // And each pattern is made of the same words as its fragment.
    SUPPLIER_422_PATTERNS.forEach(([pattern], index) => {
      const words = FRAGMENTS[index]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(pattern.source.replace(/\\S\+/g, '').replace(/\s+/g, '')).toContain(
        words.replace(/\s+/g, '').slice(0, 12),
      );
    });
  });

  it('a second registration is the service’s ALREADY_EXISTS, a 409', () => {
    expect(behaviour).toContain("RastaError.alreadyExists('Supplier', organizationId)");
    expect(ALREADY_REGISTERED_MESSAGE).toMatch(/پرونده/);
  });

  it('the documented error statuses are exactly the ones every form can say', async () => {
    const documented = Object.keys(
      Object.fromEntries(
        [...documentText.matchAll(/^\s{2}(\d{3}):\s*['`]/gm)].map((match) => [match[1], true]),
      ),
    )
      .map(Number)
      .sort();
    expect(documented).toEqual([400, 401, 403, 404, 409, 422, 500]);

    const body = {
      code: 'X',
      message: 'service sentence nobody may read',
      correlationId: 'corr-1',
      timestamp: '2026-10-23T08:00:00.000Z',
    };
    const kinds: Record<number, string> = {};
    for (const status of documented) {
      const impl = (async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const result = await registerSupplier(
        {
          subject: 's',
          username: 'u',
          organizationId: 'O',
          accessToken: 'a',
          accessTokenExpiresAt: 9e9,
          refreshToken: 'r',
          csrfToken: 'c',
          issuedAt: 1,
        },
        { displayName: 'ab', capabilities: ['GOODS_SUPPLY'] },
        impl,
      );
      kinds[status] = result.kind;
      expect(JSON.stringify(result)).not.toContain('nobody may read');
      if (result.kind === 'UNAVAILABLE') {
        expect(supplierFailureText(result.status)).toMatch(/[آ-ی]/);
      }
    }
    expect(kinds).toEqual({
      400: 'INVALID',
      401: 'UNAVAILABLE',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'INVALID',
      422: 'INVALID',
      500: 'UNAVAILABLE',
    });
    expect(supplierFailureText(401)).toMatch(/نشست/);
    expect(supplierFailureText(429)).toMatch(/چیزی تغییر نکرد/);
    // The documented 500 is what supplier-service answers when the read after a
    // committed write fails (`viewOf`, `detailOf`): never "nothing changed"
    // (Codex review of PR 366, finding 3).
    expect(behaviour).toContain('disappeared immediately after being written');
    expect(provenUnwritten(500, 'INTERNAL_ERROR')).toBe(false);
    expect(provenUnwritten(500, undefined)).toBe(false);
  });

  it('an episode that moved on is the service’s 409 SUSPENSION_EPISODE_CHANGED, said as stale', () => {
    const suspension = squash(readSource(...SERVICE, 'supplier', 'suspension.service.ts'));
    expect(suspension).toContain(`SUSPENSION_EPISODE_CHANGED='${SUSPENSION_EPISODE_CHANGED}'`);
    expect(suspension).toContain('ERROR_CODES.OPTIMISTIC_LOCK_FAILED');
    expect(REASON_FIELD_MAPPING.byDetailCode).toEqual({
      [SUSPENSION_EPISODE_CHANGED]: STALE_MESSAGE,
    });
  });

  it('the detail’s decisionNote is optional and rejectionReason present, as the service declares', () => {
    const view = squash(topLevelConst(dto, 'qualificationViewSchema').getText());
    expect(view).toContain('decisionNote:z.string().nullable().optional()');
    expect(view).toContain('rejectionReason:z.string().nullable()');
  });

  it('a decision names its qualification in the path, never in the body', async () => {
    const seen: string[] = [];
    const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${String(url)} ${String(init?.body)}`);
      return new Response(JSON.stringify({ id: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await approveQualification(
      {
        subject: 's',
        username: 'u',
        organizationId: 'O',
        accessToken: 'a',
        accessTokenExpiresAt: 9e9,
        refreshToken: 'r',
        csrfToken: 'c',
        issuedAt: 1,
      },
      'SUP_1',
      'QUA_1',
      {},
      impl,
    );
    expect(seen).toEqual([
      'http://gateway.test:3000/v1/suppliers/SUP_1/qualifications/QUA_1/approve {}',
    ]);
  });
});
