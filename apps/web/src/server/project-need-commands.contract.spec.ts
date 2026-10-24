/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  MAX_NEED_DESCRIPTION_LENGTH,
  MAX_NEED_REASON_LENGTH,
  MAX_NEED_TITLE_LENGTH,
  MAX_NEED_UNIT_LENGTH,
  MAX_QUANTITY_FRACTION_DIGITS,
  MAX_QUANTITY_INTEGER_DIGITS,
  MIN_NEED_DESCRIPTION_LENGTH,
  MIN_NEED_REASON_LENGTH,
  MIN_NEED_TITLE_LENGTH,
  MIN_NEED_UNIT_LENGTH,
  NEED_422_PATTERNS,
  NEED_FIELDS,
  NEED_STATUSES,
  NEEDS_EDITABLE_PROJECT_STATUSES,
  needCommandsFrom,
  parseAddNeedForm,
  parseWithdrawNeedForm,
  type NeedCommand,
} from '@/lib/project-need-commands';
import { PROJECT_STATUSES } from '@/lib/project-fields';
import { projectNeedSchema } from './projects';
import {
  collect,
  decoratorOf,
  literalsOf,
  parseSource,
  readSource,
  schemaProperties,
  squash,
  topLevelConst,
} from '@/test/service-source';

/**
 * What the need screens depend on, pinned to construction-service's source — the
 * technique of `project-commands.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies and this test fails the moment a
 * copy and its original disagree. No response carries the caller's available
 * actions, so "which command does this need offer" is a copy of the service's rule
 * — pinned here — and every refusal the endpoints document has the page's fixed words.
 */

const SERVICE = ['services', 'construction-service', 'src'] as const;
const controllerText = readSource(...SERVICE, 'project', 'project.controller.ts');
const controller = parseSource(controllerText);
const dto = parseSource(readSource(...SERVICE, 'project', 'dto.ts'));
const needService = readSource(...SERVICE, 'project', 'need.service.ts');
const needStates = readSource(...SERVICE, 'project', 'need.state-machine.ts');
const projectStates = readSource(...SERVICE, 'project', 'project.state-machine.ts');
const document = readSource(...SERVICE, 'openapi', 'document.ts');
const documentTree = parseSource(document);
const openapi = JSON.parse(readSource('docs', 'api', 'construction-service.openapi.json')) as {
  paths: Record<
    string,
    Record<string, { responses: Record<string, unknown>; parameters?: { name: string }[] }>
  >;
};

const pathOf = (method: string, verb: string): string[] =>
  (decoratorOf(controller, method, verb)?.arguments ?? []).map((argument) =>
    ts.isStringLiteral(argument) ? argument.text : '?',
  );

const handlerText = (method: string): string =>
  squash(
    collect(controller, ts.isMethodDeclaration)
      .find((node) => node.name.getText() === method)
      ?.getText(),
  )!;

const setOf = (name: string): string[] =>
  literalsOf(
    collect(documentTree, ts.isVariableDeclaration)
      .find((d) => d.name.getText() === name)
      ?.initializer?.getText(),
  );

const WRITES = [
  ['addNeed', 'Post', [':id/needs'], 'POST /v1/projects/{id}/needs'],
  ['updateNeed', 'Patch', [':id/needs/:needId'], 'PATCH /v1/projects/{id}/needs/{needId}'],
  [
    'submitNeed',
    'Post',
    [':id/needs/:needId/submit'],
    'POST /v1/projects/{id}/needs/{needId}/submit',
  ],
  [
    'withdrawNeed',
    'Post',
    [':id/needs/:needId/withdraw'],
    'POST /v1/projects/{id}/needs/{needId}/withdraw',
  ],
] as const;

describe('the endpoints', () => {
  it.each(WRITES)('%s is a %s of %j under /v1/projects', (method, verb, path) => {
    expect(pathOf(method, verb)).toEqual(path);
  });

  it('the list is a GET of the same collection, and the status filter is the need statuses', () => {
    expect(pathOf('listNeeds', 'Get')).toEqual([':id/needs']);
    const filter = squash(schemaProperties(dto, 'listNeedsQuerySchema').get('status'));
    expect(filter ?? squash(topLevelConst(dto, 'listNeedsQuerySchema').getText())).toContain(
      'NEED_STATES',
    );
  });

  it('answer 201 for the add and 200 for the other three, as the OpenAPI document lists them', () => {
    const doc = squash(document)!;
    expect(doc).toContain("'POST/v1/projects/{id}/needs':{status:'201',schema:needViewSchema}");
    for (const [, , , route] of WRITES.slice(1)) {
      expect(doc).toContain(`'${route.replace(' ', '')}':{status:'200',schema:needViewSchema}`);
    }
    expect(handlerText('addNeed')).toContain('@HttpCode(HttpStatus.CREATED)');
    for (const name of ['submitNeed', 'withdrawNeed']) {
      expect(handlerText(name)).toContain('@HttpCode(HttpStatus.OK)');
    }
  });

  it('document exactly the answers the screens say in fixed words', () => {
    for (const [, , , route] of WRITES) {
      const [verb, path] = route.split(' ') as [string, string];
      const responses = Object.keys(openapi.paths[path]![verb.toLowerCase()]!.responses).sort();
      expect(responses).toEqual(
        [
          route === 'POST /v1/projects/{id}/needs' ? '201' : '200',
          '400',
          '401',
          '403',
          '404',
          '409',
          '422',
          '500',
        ].sort(),
      );
    }
  });

  it('take an Idempotency-Key on the add alone, and read no replay deadline anywhere', () => {
    const idempotent = setOf('IDEMPOTENT');
    expect(idempotent).toContain('POST /v1/projects/{id}/needs');
    for (const [, , , route] of WRITES.slice(1)) expect(idempotent).not.toContain(route);

    expect(handlerText('addNeed')).toContain("@Headers('idempotency-key')");
    for (const [method] of WRITES.slice(1)) {
      expect(handlerText(method)).not.toContain('@Headers(');
    }
    // The add reads no `Idempotency-Replay-Deadline`: the service cannot refuse a resend past its
    // own retention, so `project-need-create` is `retry: false`. The day this fails, switch the
    // purpose to `retry: true, deadline: 'REQUIRED'` (like `project-create`) and send the deadline.
    expect(controllerText).toContain("@Headers('idempotency-replay-deadline')");
    expect(handlerText('addNeed')).not.toContain('idempotency-replay-deadline');
    expect(handlerText('addNeed')).not.toContain('parseReplayDeadline');

    const add = openapi.paths['/v1/projects/{id}/needs']!['post']!;
    expect((add.parameters ?? []).map((p) => p.name).sort()).toEqual(['Idempotency-Key', 'id']);
    for (const [, , , route] of WRITES.slice(1)) {
      const [verb, path] = route.split(' ') as [string, string];
      expect(
        (openapi.paths[path]![verb.toLowerCase()]!.parameters ?? []).map((p) => p.name),
      ).not.toContain('Idempotency-Key');
    }
  });

  it('are compare-and-set on the version, as the OpenAPI document says (VERSIONED)', () => {
    const versioned = setOf('VERSIONED');
    for (const [, , , route] of WRITES.slice(1)) expect(versioned).toContain(route);
    expect(versioned).not.toContain('POST /v1/projects/{id}/needs');
  });

  it('are exactly the need writes the screens use', () => {
    const verbs = (verb: string): string[] =>
      collect(controller, ts.isMethodDeclaration)
        .filter((node) =>
          (ts.getDecorators(node) ?? []).some((d) => d.expression.getText().startsWith(`${verb}(`)),
        )
        .map((node) => node.name.getText())
        .filter((name) => /Need/.test(name))
        .sort();
    expect(verbs('Post')).toEqual(['addNeed', 'submitNeed', 'withdrawNeed']);
    expect(verbs('Patch')).toEqual(['updateNeed']);
  });

  it('answer no permission list: a need carries no availableActions or permissions', () => {
    expect(readSource(...SERVICE, 'project', 'dto.ts')).not.toMatch(/availableActions|permissions/);
  });
});

describe('the request bodies', () => {
  const keys = (name: string) => [...schemaProperties(dto, name).keys()].sort();
  const strict = (name: string) =>
    squash(topLevelConst(dto, name).getText())!.includes('.strict()');

  it('are the fields the forms send — and the service refuses any other (.strict())', () => {
    const fields = ['title', 'description', 'quantity', 'unit', 'estimatedCostMinor'];
    // The form's `estimatedCost` is sent as `estimatedCostMinor`.
    expect(keys('createNeedSchema')).toEqual([...fields].sort());
    expect(NEED_FIELDS.filter((f) => f !== 'estimatedCost').sort()).toEqual(
      fields.filter((f) => f !== 'estimatedCostMinor').sort(),
    );
    expect(keys('updateNeedSchema')).toEqual([...fields, 'expectedVersion'].sort());
    expect(keys('submitNeedSchema')).toEqual(['expectedVersion']);
    expect(keys('withdrawNeedSchema')).toEqual(['expectedVersion', 'reason']);
    for (const name of [
      'createNeedSchema',
      'updateNeedSchema',
      'submitNeedSchema',
      'withdrawNeedSchema',
    ]) {
      expect(strict(name)).toBe(true);
    }
  });

  it('say which optional fields an edit may clear (nullable) and which it may not', () => {
    const props = schemaProperties(dto, 'updateNeedSchema');
    for (const name of ['quantity', 'unit', 'estimatedCostMinor']) {
      expect(squash(props.get(name))).toContain('.nullable().optional()');
    }
    for (const name of ['title', 'description']) {
      expect(squash(props.get(name))).not.toContain('nullable');
    }
    expect(squash(topLevelConst(dto, 'updateNeedSchema').getText())).toContain(
      "Object.keys(value).some((key)=>key!=='expectedVersion')",
    );
  });

  it('carry the bounds the forms copy', () => {
    const line = (name: string) => squash(topLevelConst(dto, name).getText())!;
    expect(line('needTitle')).toContain(
      `.string().trim().min(${MIN_NEED_TITLE_LENGTH}).max(${MAX_NEED_TITLE_LENGTH})`,
    );
    expect(line('needDescription')).toBe(
      `z.string().trim().min(${MIN_NEED_DESCRIPTION_LENGTH}).max(${MAX_NEED_DESCRIPTION_LENGTH})`,
    );
    expect(line('needUnit')).toContain(
      `.string().trim().min(${MIN_NEED_UNIT_LENGTH}).max(${MAX_NEED_UNIT_LENGTH})`,
    );
    expect(line('statedReason')).toBe(
      `z.string().trim().min(${MIN_NEED_REASON_LENGTH}).max(${MAX_NEED_REASON_LENGTH})`,
    );
    // A quantity: a positive decimal string, at most 14 integer and 4 fractional digits, no leading zeros.
    expect(line('quantityInput')).toContain(
      `/^(0|[1-9]\\d{0,${MAX_QUANTITY_INTEGER_DIGITS - 1}})(\\.\\d{1,${MAX_QUANTITY_FRACTION_DIGITS}})?$/`,
    );
    expect(line('quantityInput')).toContain('/[1-9]/.test(value)');
    expect(line('needQuantity')).toContain('quantityInput.describe');
  });

  it('the forms accept the limits and refuse one beyond them', () => {
    const base = {
      title: 'ع'.repeat(MAX_NEED_TITLE_LENGTH),
      description: 'ع'.repeat(MAX_NEED_DESCRIPTION_LENGTH),
      quantity:
        '9'.repeat(MAX_QUANTITY_INTEGER_DIGITS) + '.' + '9'.repeat(MAX_QUANTITY_FRACTION_DIGITS),
      unit: 'ع'.repeat(MAX_NEED_UNIT_LENGTH),
      estimatedCost: '9223372036854775807',
    };
    expect(parseAddNeedForm(base).ok).toBe(true);
    expect(parseAddNeedForm({ ...base, title: base.title + 'ع' }).ok).toBe(false);
    expect(parseAddNeedForm({ ...base, description: base.description + 'ع' }).ok).toBe(false);
    expect(parseAddNeedForm({ ...base, unit: base.unit + 'ع' }).ok).toBe(false);
    expect(parseAddNeedForm({ ...base, quantity: '1' + base.quantity }).ok).toBe(false);
    expect(parseAddNeedForm({ ...base, quantity: base.quantity + '9' }).ok).toBe(false);
    expect(parseAddNeedForm({ ...base, quantity: '0' }).ok).toBe(false);
    expect(parseAddNeedForm({ ...base, estimatedCost: '9223372036854775808' }).ok).toBe(false);
    expect(parseAddNeedForm({ ...base, title: 'ع'.repeat(MIN_NEED_TITLE_LENGTH - 1) }).ok).toBe(
      false,
    );
    expect(parseWithdrawNeedForm({ reason: 'ع'.repeat(MAX_NEED_REASON_LENGTH) }).ok).toBe(true);
    expect(parseWithdrawNeedForm({ reason: 'ع'.repeat(MAX_NEED_REASON_LENGTH + 1) }).ok).toBe(
      false,
    );
    expect(parseWithdrawNeedForm({ reason: 'ع'.repeat(MIN_NEED_REASON_LENGTH - 1) }).ok).toBe(
      false,
    );
  });
});

describe('which command a need offers', () => {
  const squashed = squash(needStates)!;

  it('the need lifecycle table is the service’s', () => {
    expect(squashed).toContain("exportconstNEED_STATES=['DRAFT','SUBMITTED','WITHDRAWN']as");
    expect(squashed).toContain("DRAFT:['SUBMITTED','WITHDRAWN']");
    expect(squashed).toContain("SUBMITTED:['WITHDRAWN']");
    expect(squashed).toContain('WITHDRAWN:[]');
    expect(squashed).toContain("EDITABLE_NEED_STATES:readonlyNeedStateName[]=['DRAFT']");
    expect([...NEED_STATUSES]).toEqual(['DRAFT', 'SUBMITTED', 'WITHDRAWN']);
  });

  it('a need’s fields change in a draft only; submit and withdraw follow the table', () => {
    const expected: Record<string, readonly NeedCommand[]> = {
      DRAFT: ['edit', 'submit', 'withdraw'],
      SUBMITTED: ['withdraw'],
      WITHDRAWN: [],
    };
    for (const [status, commands] of Object.entries(expected)) {
      expect(needCommandsFrom('DRAFT', status)).toEqual(commands);
    }
  });

  it('only a project the service calls editable offers any', () => {
    expect(squash(projectStates)).toContain(
      "EDITABLE_PROJECT_STATES:readonlyProjectStateName[]=['DRAFT','CHANGES_REQUESTED']",
    );
    expect([...NEEDS_EDITABLE_PROJECT_STATUSES]).toEqual(['DRAFT', 'CHANGES_REQUESTED']);
    for (const status of PROJECT_STATUSES) {
      const editable = NEEDS_EDITABLE_PROJECT_STATUSES.includes(status);
      expect(needCommandsFrom(status, 'DRAFT').length > 0).toBe(editable);
    }
  });

  it('every need command first locks the project and checks it is editable — the server-side re-check', () => {
    const service = squash(needService)!;
    // add, update, submit, withdraw: four commands, four locks.
    expect(
      service.match(/awaitthis\.lockEditableProject\(tx,organizationId,projectId\)/g),
    ).toHaveLength(4);
    expect(service).toContain('assertProjectEditable(projectId,locked.status)');
    // An edit also needs the need to be a draft; submit and withdraw follow the transition table.
    expect(service).toContain('assertNeedEditable(needId,need.statusasNeedStateName)');
    expect(service).toContain(
      "assertNeedTransition(needId,need.statusasNeedStateName,'SUBMITTED')",
    );
    expect(service).toContain(
      "assertNeedTransition(needId,need.statusasNeedStateName,'WITHDRAWN')",
    );
  });

  it('the writes need the write role, the list the read role', () => {
    const service = squash(needService)!;
    expect(service.match(/this\.access\.assertCanWrite\(\)/g)).toHaveLength(4);
    expect(service.match(/this\.access\.assertCanRead\(\)/g)).toHaveLength(1);
  });
});

describe('what the service refuses, in fixed words', () => {
  /** For each pattern: a sentence it must match, and the fixed fragments of that sentence in the service. */
  const SAMPLES: readonly (readonly [string, readonly string[], string])[] = [
    [
      'Need NED_1 was withdrawn and cannot change state',
      ['was withdrawn and cannot change state'],
      needStates,
    ],
    [
      'Need NED_1 cannot move from SUBMITTED to DRAFT',
      ['cannot move from ${from} to ${to}'],
      needStates,
    ],
    [
      'Need NED_1 is SUBMITTED and can no longer be edited; withdraw it and add a new one',
      ['is ${state} and can no longer be edited; withdraw it and add a new one'],
      needStates,
    ],
    [
      'Project PRJ_1 is APPROVED and can no longer be edited; only a project in DRAFT or CHANGES_REQUESTED can change',
      [
        'is ${state} and can no longer be edited; ',
        'only a project in ${EDITABLE_PROJECT_STATES.join(',
      ],
      projectStates,
    ],
  ];

  it('has a sample for every pattern, in order', () => {
    expect(SAMPLES).toHaveLength(NEED_422_PATTERNS.length);
  });

  it.each(SAMPLES.map((sample, index) => [index, sample[0]] as const))(
    'pattern %i matches the service’s sentence “%s”',
    (index, sentence) => {
      expect(NEED_422_PATTERNS[index]![0].test(sentence)).toBe(true);
    },
  );

  it.each(SAMPLES.map((sample, index) => [index, sample[1], sample[2]] as const))(
    'pattern %i is still the sentence the service says (its fixed fragments are in the source)',
    (_index, fragments, source) => {
      const flat = source.replace(/\s+/g, ' ');
      for (const fragment of fragments) {
        expect(flat.includes(fragment.replace(/\s+/g, ' '))).toBe(true);
      }
    },
  );

  it('the three refusals of a need are business rules (422), as the pattern table assumes', () => {
    const flat = squash(needStates)!;
    expect(flat.match(/RastaError\.businessRule\(/g)).toHaveLength(2);
    expect(squash(projectStates)).toContain('RastaError.businessRule(');
  });

  it('a stale version and a reused key are the codes the service gives, not sentences', () => {
    const errors = readSource('packages', 'nest-common', 'src', 'errors', 'rasta-error.ts');
    expect(errors).toContain('OPTIMISTIC_LOCK_FAILED');
    expect(errors).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(squash(needService)).toContain("RastaError.optimisticLockFailed('ProjectNeed',needId)");
  });
});

describe('what the screens read back', () => {
  type Schema = {
    type?: string;
    nullable?: boolean;
    properties?: Record<string, Schema>;
    required?: string[];
    items?: Schema;
  };
  const responseOf = (path: string, verb: string, status: string): Schema =>
    (
      openapi.paths[path]![verb]!.responses[status] as {
        content: { 'application/json': { schema: Schema } };
      }
    ).content['application/json'].schema;

  const created = responseOf('/v1/projects/{id}/needs', 'post', '201');
  const listed = responseOf('/v1/projects/{id}/needs', 'get', '200').properties!['items']!.items!;

  it.each([
    ['the add', created],
    ['the list', listed],
  ])(
    '%s answers every field the list reads, with the nullability the reader allows',
    (_n, schema) => {
      const properties = schema.properties!;
      for (const [name, reader] of Object.entries(projectNeedSchema.shape)) {
        const documented = properties[name];
        expect(documented).toBeDefined();
        // A field the reader takes as null must be documented as nullable, and the reverse.
        expect(reader.safeParse(null).success).toBe(documented!.nullable === true);
        // A field with no default is one the service always sends.
        if (!reader.safeParse(undefined).success) expect(schema.required).toContain(name);
      }
    },
  );

  it('the other three writes answer a need with an id, as the one-field answer the commands read', () => {
    for (const [, , , route] of WRITES.slice(1)) {
      const [verb, path] = route.split(' ') as [string, string];
      const answer = responseOf(path, verb.toLowerCase(), '200');
      expect(answer.properties!['id']).toMatchObject({ type: 'string' });
      expect(answer.required).toContain('id');
    }
    expect(created.required).toContain('id');
  });

  it('the version the commands send back is an integer the service always sends', () => {
    expect(created.properties!['version']).toMatchObject({ type: 'integer' });
    expect(created.required).toContain('version');
  });
});
