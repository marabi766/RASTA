/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  CANCELLABLE_STATUSES,
  CANCEL_FIELDS,
  EDITABLE_STATUSES,
  GRANT_FIELDS,
  MAX_CONDITIONS_LENGTH,
  MAX_DECISION_NUMBER_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_OPERATION_TYPE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_LOCATION_LENGTH,
  MIN_OPERATION_TYPE_LENGTH,
  MIN_REASON_LENGTH,
  MIN_TITLE_LENGTH,
  PROJECT_422_PATTERNS,
  PROJECT_FIELDS,
  PROJECT_VALIDATION_DETAIL_CODES,
  commandsFrom,
  isProjectWorkflow,
  parseCancelForm,
  parseCreateForm,
  parseRejectForm,
} from '@/lib/project-commands';
import { PROJECT_STATUSES } from '@/lib/project-fields';
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
 * What the project write screens depend on, pinned to construction-service's
 * source — the technique of `tender-owner.contract.spec.ts`: A-02 forbids
 * importing `services/*\/src`, so the portal keeps copies and this test fails the
 * moment a copy and its original disagree. No project response carries the
 * caller's available actions, so "which command does this status offer" and "may
 * this person decide this step" are copies of the service's rules — each pinned
 * here — and every refusal the endpoints document has the page's fixed words.
 */

const SERVICE = ['services', 'construction-service', 'src'] as const;
const projectController = parseSource(readSource(...SERVICE, 'project', 'project.controller.ts'));
const projectControllerText = readSource(...SERVICE, 'project', 'project.controller.ts');
const lifecycle = parseSource(readSource(...SERVICE, 'project', 'lifecycle.controller.ts'));
const lifecycleText = readSource(...SERVICE, 'project', 'lifecycle.controller.ts');
const approvalController = parseSource(
  readSource(...SERVICE, 'approval', 'approval.controller.ts'),
);
const approvalControllerText = readSource(...SERVICE, 'approval', 'approval.controller.ts');
const projectDto = parseSource(readSource(...SERVICE, 'project', 'dto.ts'));
const approvalDto = parseSource(readSource(...SERVICE, 'approval', 'dto.ts'));
const stateMachine = readSource(...SERVICE, 'project', 'project.state-machine.ts');
const approvalStates = readSource(...SERVICE, 'approval', 'approval.state-machine.ts');
const access = readSource(...SERVICE, 'access', 'access.ts');
const document = readSource(...SERVICE, 'openapi', 'document.ts');
const documentTree = parseSource(document);
const routes = readSource('services', 'api-gateway', 'src', 'config', 'routes.ts');
const behaviour = [
  readSource(...SERVICE, 'project', 'project.service.ts'),
  readSource(...SERVICE, 'project', 'execution.service.ts'),
  readSource(...SERVICE, 'approval', 'approval.service.ts'),
  stateMachine,
  approvalStates,
].join('\n');

const arrayOf = (source: ts.SourceFile, name: string): string[] =>
  collect(topLevelConst(source, name), ts.isStringLiteral).map((node) => node.text);

const handlers = (controller: ts.SourceFile, verb: string): string[] =>
  collect(controller, ts.isMethodDeclaration)
    .filter((node) =>
      (ts.getDecorators(node) ?? []).some((d) => d.expression.getText().startsWith(`${verb}(`)),
    )
    .map((node) => node.name.getText());

const pathOf = (controller: ts.SourceFile, method: string, verb: string): string[] =>
  (decoratorOf(controller, method, verb)?.arguments ?? []).map((argument) =>
    ts.isStringLiteral(argument) ? argument.text : '?',
  );

describe('the endpoints', () => {
  it.each([
    [projectController, 'create', 'Post', []],
    [projectController, 'update', 'Patch', [':id']],
    [projectController, 'cancel', 'Post', [':id/cancel']],
    [lifecycle, 'requestApproval', 'Post', [':id/approvals']],
    [lifecycle, 'start', 'Post', [':id/start']],
    [lifecycle, 'complete', 'Post', [':id/complete']],
    [approvalController, 'decide', 'Post', [':id/decision']],
  ] as const)(
    '%#: %s is a %s of %j under its controller path',
    (controller, method, verb, path) => {
      expect(pathOf(controller, method, verb)).toEqual(path);
    },
  );

  it('live under /v1/projects and /v1/approvals, which the gateway routes to construction', () => {
    expect(squash(projectControllerText)).toContain("@Controller({path:'projects',version:'1'})");
    expect(squash(lifecycleText)).toContain("@Controller({path:'projects',version:'1'})");
    expect(squash(approvalControllerText)).toContain("@Controller({path:'approvals',version:'1'})");
    expect(squash(routes)).toContain("{prefix:'projects',service:'construction'}");
    expect(squash(routes)).toContain("{prefix:'approvals',service:'construction'}");
  });

  it('answer 201 for the create and 200 for every command, as the OpenAPI document lists them', () => {
    const doc = squash(document)!;
    expect(doc).toContain("'POST/v1/projects':{status:'201',schema:projectViewSchema}");
    for (const [route, schema] of [
      ['PATCH /v1/projects/{id}', 'projectViewSchema'],
      ['POST /v1/projects/{id}/cancel', 'projectViewSchema'],
      ['POST /v1/projects/{id}/approvals', 'projectViewSchema'],
      ['POST /v1/projects/{id}/start', 'projectViewSchema'],
      ['POST /v1/projects/{id}/complete', 'projectViewSchema'],
      ['POST /v1/approvals/{id}/decision', 'approvalViewSchema'],
    ] as const) {
      expect(doc).toContain(`'${route.replace(' ', '')}':{status:'200',schema:${schema}}`);
    }
  });

  it('take an Idempotency-Key on the create alone: the other six read no header and the OpenAPI lists none', () => {
    const idempotent = literalsOf(
      collect(documentTree, ts.isVariableDeclaration)
        .find((d) => d.name.getText() === 'IDEMPOTENT')
        ?.initializer?.getText(),
    );
    expect(idempotent).toContain('POST /v1/projects');
    for (const route of [
      'PATCH /v1/projects/{id}',
      'POST /v1/projects/{id}/cancel',
      'POST /v1/projects/{id}/approvals',
      'POST /v1/projects/{id}/start',
      'POST /v1/projects/{id}/complete',
      'POST /v1/approvals/{id}/decision',
    ]) {
      expect(idempotent).not.toContain(route);
    }

    const readsHeader = (controller: ts.SourceFile, method: string): boolean =>
      squash(
        collect(controller, ts.isMethodDeclaration)
          .find((node) => node.name.getText() === method)
          ?.getText(),
      )!.includes("@Headers('idempotency-key')");
    expect(readsHeader(projectController, 'create')).toBe(true);
    for (const [controller, method] of [
      [projectController, 'update'],
      [projectController, 'cancel'],
      [lifecycle, 'requestApproval'],
      [lifecycle, 'start'],
      [lifecycle, 'complete'],
      [approvalController, 'decide'],
    ] as const) {
      expect(readsHeader(controller, method)).toBe(false);
    }
  });

  it('are compare-and-set on the version, as the OpenAPI document says (VERSIONED)', () => {
    const versioned = literalsOf(
      collect(documentTree, ts.isVariableDeclaration)
        .find((d) => d.name.getText() === 'VERSIONED')
        ?.initializer?.getText(),
    );
    for (const route of [
      'PATCH /v1/projects/{id}',
      'POST /v1/projects/{id}/cancel',
      'POST /v1/projects/{id}/approvals',
      'POST /v1/projects/{id}/start',
      'POST /v1/projects/{id}/complete',
      'POST /v1/approvals/{id}/decision',
    ]) {
      expect(versioned).toContain(route);
    }
  });

  it('the gateway asks no key at the edge for either prefix', () => {
    for (const prefix of ['projects', 'approvals']) {
      const rule = new RegExp(`\\{ prefix: '${prefix}',[^}]*\\}`).exec(routes)?.[0];
      expect(rule).toBeDefined();
      expect(rule).not.toContain('requiresIdempotencyKey');
    }
  });

  it('are exactly the writes the screens use or list as out of scope — a new write endpoint needs a screen or a line in STATUS', () => {
    expect(handlers(projectController, 'Post').sort()).toEqual(
      ['addNeed', 'cancel', 'create', 'submitNeed', 'withdrawNeed'].sort(),
    );
    expect(handlers(projectController, 'Patch').sort()).toEqual(['update', 'updateNeed']);
    expect(handlers(lifecycle, 'Post').sort()).toEqual(
      [
        'complete',
        'discardProgress',
        'draftProgress',
        'requestApproval',
        'start',
        'submitProgress',
      ].sort(),
    );
    expect(handlers(approvalController, 'Post')).toEqual(['decide']);
  });

  it('answer no permission list: no project or approval response carries availableActions or permissions', () => {
    expect(readSource(...SERVICE, 'project', 'dto.ts')).not.toMatch(/availableActions|permissions/);
    expect(readSource(...SERVICE, 'approval', 'dto.ts')).not.toMatch(
      /availableActions|permissions/,
    );
  });
});

describe('the request bodies', () => {
  const keys = (source: ts.SourceFile, name: string) =>
    [...schemaProperties(source, name).keys()].sort();
  const strict = (source: ts.SourceFile, name: string) =>
    squash(topLevelConst(source, name).getText())!.includes('.strict()');

  it('are the fields the forms send — and the service refuses any other (.strict())', () => {
    const fields = [
      'title',
      'operationType',
      'scopeOfWork',
      'locationDescription',
      'estimatedCostMinor',
    ];
    // The form's `estimatedCost` is sent as `estimatedCostMinor`; the area is not drawn.
    expect(keys(projectDto, 'createProjectSchema')).toEqual([...fields, 'area'].sort());
    expect(PROJECT_FIELDS.filter((f) => f !== 'estimatedCost').sort()).toEqual(
      fields.filter((f) => f !== 'estimatedCostMinor').sort(),
    );
    expect(keys(projectDto, 'updateProjectSchema')).toEqual(
      [...fields, 'area', 'expectedVersion'].sort(),
    );
    expect(keys(projectDto, 'cancelProjectSchema')).toEqual(['expectedVersion', 'reason']);
    expect(CANCEL_FIELDS.filter((f) => f !== 'confirm')).toEqual(['reason']);
    expect(keys(approvalDto, 'projectCommandSchema')).toEqual(['expectedVersion']);
    expect(keys(approvalDto, 'decisionSchema')).toEqual(
      ['conditions', 'decision', 'decisionNumber', 'expectedVersion', 'reason'].sort(),
    );
    expect([...GRANT_FIELDS].sort()).toEqual(['conditions', 'decisionNumber']);
    for (const name of ['createProjectSchema', 'updateProjectSchema', 'cancelProjectSchema']) {
      expect(strict(projectDto, name)).toBe(true);
    }
    for (const name of ['projectCommandSchema', 'decisionSchema']) {
      expect(strict(approvalDto, name)).toBe(true);
    }
  });

  it('carry the bounds the forms copy', () => {
    const line = (name: string) => squash(topLevelConst(projectDto, name).getText())!;
    expect(line('title')).toContain(
      `.string().trim().min(${MIN_TITLE_LENGTH}).max(${MAX_TITLE_LENGTH})`,
    );
    expect(line('operationType')).toContain(
      `.string().trim().min(${MIN_OPERATION_TYPE_LENGTH}).max(${MAX_OPERATION_TYPE_LENGTH})`,
    );
    expect(line('scopeOfWork')).toContain(`.string().trim().min(1).max(${MAX_SCOPE_LENGTH})`);
    expect(line('locationDescription')).toContain(
      `.string().trim().min(${MIN_LOCATION_LENGTH}).max(${MAX_LOCATION_LENGTH})`,
    );
    expect(line('statedReason')).toBe(
      `z.string().trim().min(${MIN_REASON_LENGTH}).max(${MAX_REASON_LENGTH})`,
    );
    expect(squash(topLevelConst(approvalDto, 'statedReason').getText())).toBe(
      `z.string().trim().min(${MIN_REASON_LENGTH}).max(${MAX_REASON_LENGTH})`,
    );
    const decision = squash(schemaProperties(approvalDto, 'decisionSchema').get('decisionNumber'))!;
    expect(decision).toBe(`z.string().trim().min(1).max(${MAX_DECISION_NUMBER_LENGTH}).optional()`);
    expect(squash(schemaProperties(approvalDto, 'decisionSchema').get('conditions'))).toBe(
      `z.string().trim().min(1).max(${MAX_CONDITIONS_LENGTH}).optional()`,
    );
    // The estimate: whole non-negative minor units as digits, to the BIGINT bound.
    expect(squash(topLevelConst(projectDto, 'BIGINT_MAX').getText())).toBe(
      '9_223_372_036_854_775_807n',
    );
    expect(squash(topLevelConst(projectDto, 'amountMinorInput').getText())).toContain(
      '/^(0|[1-9]\\d{0,18})$/',
    );
  });

  it('the forms accept the limits and refuse one beyond them', () => {
    const base = {
      title: 'ع'.repeat(MAX_TITLE_LENGTH),
      operationType: 'ع'.repeat(MAX_OPERATION_TYPE_LENGTH),
      locationDescription: 'ع'.repeat(MAX_LOCATION_LENGTH),
      scopeOfWork: 'ع'.repeat(MAX_SCOPE_LENGTH),
      estimatedCost: '9223372036854775807',
    };
    expect(parseCreateForm(base).ok).toBe(true);
    expect(parseCreateForm({ ...base, title: base.title + 'ع' }).ok).toBe(false);
    expect(parseCreateForm({ ...base, scopeOfWork: base.scopeOfWork + 'ع' }).ok).toBe(false);
    expect(parseCreateForm({ ...base, estimatedCost: '9223372036854775808' }).ok).toBe(false);
    expect(parseCreateForm({ ...base, estimatedCost: '-1' }).ok).toBe(false);
    expect(parseCreateForm({ ...base, estimatedCost: '1.5' }).ok).toBe(false);
    expect(parseCancelForm({ reason: 'ع'.repeat(MAX_REASON_LENGTH), confirm: 'yes' }).ok).toBe(
      true,
    );
    expect(parseCancelForm({ reason: 'ع'.repeat(MAX_REASON_LENGTH + 1), confirm: 'yes' }).ok).toBe(
      false,
    );
    expect(parseRejectForm({ reason: 'ع'.repeat(MIN_REASON_LENGTH - 1) }).ok).toBe(false);
  });

  it('a rejection states its reason, and a grant has none (the decision schema)', () => {
    const text = squash(topLevelConst(approvalDto, 'decisionSchema').getText())!;
    expect(text).toContain("value.decision==='REJECT'&&value.reason===undefined");
    expect(text).toContain("value.decision==='REJECT'&&value.conditions!==undefined");
    expect(text).toContain("value.decision==='GRANT'&&value.reason!==undefined");
    expect(squash(topLevelConst(approvalDto, 'decisionSchema').getText())).toContain(
      "decision:z.enum(['GRANT','REJECT'])",
    );
  });
});

describe('which command a status offers', () => {
  it('the lifecycle table is the service’s', () => {
    const table = squash(stateMachine)!;
    expect(table).toContain("DRAFT:['PENDING_APPROVAL','CANCELLED']");
    expect(table).toContain("PENDING_APPROVAL:['APPROVED','CHANGES_REQUESTED','CANCELLED']");
    expect(table).toContain("CHANGES_REQUESTED:['PENDING_APPROVAL','CANCELLED']");
    expect(table).toContain("APPROVED:['IN_PROGRESS','CANCELLED']");
    expect(table).toContain("IN_PROGRESS:['COMPLETED']");
    expect(table).toContain('COMPLETED:[]');
    expect(table).toContain('CANCELLED:[]');
    expect(arrayOf(parseSource(stateMachine), 'EDITABLE_PROJECT_STATES')).toEqual([
      ...EDITABLE_STATUSES,
    ]);
    expect(arrayOf(parseSource(stateMachine), 'PROJECT_STATES')).toEqual([...PROJECT_STATUSES]);
  });

  it('cancel is offered from every state the lifecycle can cancel from, and no other', () => {
    expect([...CANCELLABLE_STATUSES].sort()).toEqual(
      PROJECT_STATUSES.filter(
        (status) =>
          squash(stateMachine)!.includes(`${status}:[`) &&
          new RegExp(`${status}:\\[[^\\]]*'CANCELLED'`).test(squash(stateMachine)!),
      ).sort(),
    );
  });

  it.each([
    ['DRAFT', ['edit', 'requestApproval', 'cancel']],
    ['CHANGES_REQUESTED', ['edit', 'requestApproval', 'cancel']],
    ['PENDING_APPROVAL', ['cancel']],
    ['APPROVED', ['start', 'cancel']],
    ['IN_PROGRESS', ['complete']],
    ['COMPLETED', []],
    ['CANCELLED', []],
    ['SOMETHING_NEW', []],
  ])('%s offers %j', (status, offered) => {
    expect(commandsFrom(status)).toEqual(offered);
  });

  it('start needs APPROVED, complete needs IN_PROGRESS, request needs a state that can reach PENDING_APPROVAL', () => {
    const text = squash(behaviour)!;
    expect(text).toContain("assertProjectTransition(projectId,locked.status,'IN_PROGRESS')");
    expect(text).toContain("assertProjectTransition(projectId,locked.status,'COMPLETED')");
    expect(text).toContain("assertProjectTransition(projectId,locked.status,'PENDING_APPROVAL')");
    expect(text).toContain('assertProjectEditable(projectId,locked.status)');
  });
});

describe('who may write a project', () => {
  it('assertCanWrite is the configured project roles and the platform administrator, never the oversight role', () => {
    const text = squash(access)!;
    expect(text).toContain('this.writers=[SUPER_ROLE,...env.CONSTRUCTION_PROJECT_ROLES]');
    expect(text).toContain(
      "assertCanWrite():{organizationId:string;actor:string}{returnthis.assert(this.writers,'changeconstructionprojects');}",
    );
    expect(text).toContain('assertNotAuditor();assertNotServiceCaller();');
    expect(text).toContain("exportconstSUPER_ROLE='SYSTEM_ADMIN'");
    expect(text).toContain("constOVERSIGHT_ROLE='AUDITOR'");
  });

  it('the roles default to ORGANIZATION_ADMIN in the service and in the portal alike', () => {
    expect(squash(readSource(...SERVICE, 'config', 'env.ts'))).toContain(
      "CONSTRUCTION_PROJECT_ROLES:z.string().default('ORGANIZATION_ADMIN')",
    );
    expect(squash(readSource('apps', 'web', 'src', 'server', 'env.ts'))).toContain(
      "WEB_PROJECT_ROLES:roleList('WEB_PROJECT_ROLES','ORGANIZATION_ADMIN')",
    );
  });

  it('create, edit and every lifecycle command share that one rule', () => {
    const text = squash(behaviour)!;
    expect(text.match(/this\.access\.assertCanWrite\(\)/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe('who may decide a step', () => {
  it('only a caller acting for the step’s organization who holds its role — no bypass for the platform administrator', () => {
    const text = squash(access)!;
    expect(text).toContain(
      'context.organizationId===approval.authorityOrganizationId&&context.roles.includes(approval.authorityRole)',
    );
    expect(text).toContain('assertNotAuditor();assertNotServiceCaller();');
    expect(squash(approvalControllerText)).toContain(
      'Onlyacalleractingforthestep’sauthorityOrganizationId',
    );
  });

  it('only a PENDING step is decided, on a project in the state its workflow expects', () => {
    expect(squash(approvalStates)).toContain("if(status==='PENDING')return;");
    expect(squash(behaviour)).toContain(
      "workflowKey==='project.execution'?'PENDING_APPROVAL':'IN_PROGRESS'",
    );
  });

  it('the project workflows are exactly the two the page names; a tender’s are not decided here', () => {
    expect(arrayOf(parseSource(approvalStates), 'PROJECT_WORKFLOW_KEYS')).toEqual([
      'project.execution',
      'project.completion',
    ]);
    for (const key of ['project.execution', 'project.completion']) {
      expect(isProjectWorkflow(key)).toBe(true);
    }
    for (const key of ['tender.publication', 'tender.award', 'tender.cancellation']) {
      expect(isProjectWorkflow(key)).toBe(false);
    }
  });

  it('the inbox is the organization the request acts for and its roles, PENDING by default, and never the oversight role', () => {
    const text = squash(access)!;
    expect(text).toContain('inboxScope()');
    expect(squash(topLevelConst(approvalDto, 'inboxQuerySchema').getText())).toContain(
      ".extend({status:z.enum(APPROVAL_STATES).default('PENDING')})",
    );
  });
});

describe('the approval policy the page reads', () => {
  it('the list is the policies that govern the organization, filterable by workflow and status', () => {
    const query = squash(topLevelConst(approvalDto, 'listPoliciesQuerySchema').getText())!;
    expect(query).toContain('workflowKey:z.enum(WORKFLOW_KEYS).optional()');
    expect(query).toContain('status:z.enum(POLICY_STATES).optional()');
    expect(squash(access)).toContain('governed:this.canReadProjectsOf(organizationId)');
  });

  it('the system is closed without a policy: a request is refused, never approved', () => {
    const text = squash(behaviour)!;
    expect(text).toContain("reason==='NO_POLICY'");
    expect(text).toContain('Theplatformneverapprovesbydefault');
    expect(text).toContain('if(!outcome.opened)throwthis.noApprovalPath(');
  });
});

describe('what the service refuses, in fixed words', () => {
  /** For each pattern: a sentence it must match, and the fixed fragments of that sentence in the service. */
  const SAMPLES: readonly (readonly [string, readonly string[]])[] = [
    [
      'There is no active approval policy for project.execution in this organization. The platform never approves by default; a policy setter must activate one first.',
      [
        'There is no active approval policy for ${workflowKey} in this organization. ',
        'The platform never approves by default; a policy setter must activate one first.',
      ],
    ],
    [
      "The active approval policy for project.execution has no step for this project's estimate. The platform never approves by default.",
      [
        'The active approval policy for ${workflowKey} has no step for this project',
        'estimate. ',
        'The platform never approves by default.',
      ],
    ],
    [
      'A project needs an estimate before it may request approval (CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE)',
      [
        'A project needs an estimate before it may request approval (CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE)',
      ],
    ],
    [
      'A project needs at least 1 submitted need(s) before it may request approval (CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS)',
      [
        'A project needs at least ${minimum} submitted need(s) before it may request approval ',
        '(CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS)',
      ],
    ],
    [
      'Project PRJ_1 has a tender that is not finished; cancel the tender first',
      ['has a tender that is not finished; cancel the tender first'],
    ],
    [
      'Project PRJ_1 cannot be cancelled while APPROVED in this deployment',
      ['cannot be cancelled while ${from} in this deployment'],
    ],
    [
      'This deployment starts a project only under a signed contract, and the contract boundary does not exist yet (CONSTRUCTION_START_REQUIRES_CONTRACT, CON-003)',
      [
        'This deployment starts a project only under a signed contract, and the contract ',
        'boundary does not exist yet (CONSTRUCTION_START_REQUIRES_CONTRACT, CON-003)',
      ],
    ],
    [
      'A project completes only when its latest submitted progress report says 100%',
      ['A project completes only when its latest submitted progress report says 100%'],
    ],
    [
      'A completion approval round is already open for this project',
      ['A completion approval round is already open for this project'],
    ],
    [
      'Project PRJ_1 is cancelled and cannot change state',
      ['is ${from.toLowerCase()} and cannot change state'],
    ],
    ['Project PRJ_1 cannot move from DRAFT to IN_PROGRESS', ['cannot move from ${from} to ${to}']],
    [
      'Project PRJ_1 is APPROVED and can no longer be edited; only a project in DRAFT or CHANGES_REQUESTED can change',
      [
        'is ${state} and can no longer be edited; ',
        'only a project in ${EDITABLE_PROJECT_STATES.join(',
      ],
    ],
    [
      'Project PRJ_1 is APPROVED; this approval can no longer be decided',
      ['; this approval can no longer be decided'],
    ],
    [
      'Approval APR_1 has not been requested yet: an earlier step is still undecided',
      ['has not been requested yet: an earlier step is still undecided'],
    ],
    [
      'Approval APR_1 is granted and cannot be decided again',
      ['is ${status.toLowerCase()} and cannot be decided again'],
    ],
    [
      'The project no longer reports 100% progress; its completion cannot be granted',
      ['The project no longer reports 100% progress; its completion cannot be granted'],
    ],
  ];

  it('has a sample for every pattern, in order', () => {
    expect(SAMPLES).toHaveLength(PROJECT_422_PATTERNS.length);
  });

  it.each(SAMPLES.map((sample, index) => [index, sample[0]] as const))(
    'pattern %i matches the service’s sentence “%s”',
    (index, sentence) => {
      expect(PROJECT_422_PATTERNS[index]![0].test(sentence)).toBe(true);
    },
  );

  it.each(SAMPLES.map((sample, index) => [index, sample[1]] as const))(
    'pattern %i is still the sentence the service says (its fixed fragments are in the source)',
    (_index, fragments) => {
      const source = behaviour.replace(/\s+/g, ' ');
      for (const fragment of fragments) {
        const needle = fragment.replace(/\s+/g, ' ');
        // The service splits long sentences over concatenated literals: look the
        // fragment up with the quote-and-plus joins removed.
        const joined = source.replace(/'\s*\+\s*`?'?/g, '').replace(/`\s*\+\s*`/g, '');
        expect(source.includes(needle) || joined.includes(needle)).toBe(true);
      }
    },
  );

  it('every validation detail code the service sends has a word of its own', () => {
    const service = readSource(...SERVICE, 'project', 'project.service.ts');
    for (const code of Object.keys(PROJECT_VALIDATION_DETAIL_CODES)) {
      expect(service).toContain(`code: '${code}'`);
    }
  });

  it('a stale version and a reused key are the codes the service gives, not sentences', () => {
    const errors = readSource('packages', 'nest-common', 'src', 'errors', 'rasta-error.ts');
    expect(errors).toContain('OPTIMISTIC_LOCK_FAILED');
    expect(errors).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(squash(document)).toContain('OPTIMISTIC_LOCK_FAILED');
    expect(squash(document)).toContain('IDEMPOTENCY_KEY_REUSED');
  });
});
