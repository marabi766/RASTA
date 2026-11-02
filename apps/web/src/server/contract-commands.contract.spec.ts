/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  AMENDMENT_REASON_MAX,
  CANCEL_NOTE_MAX,
  CONTRACT_REFUSAL_TEXT,
  MILESTONE_TITLE_MAX,
  PLANNED_SHARE_BP_MAX,
} from '@/lib/contract-command-fields';
import {
  collect,
  decoratorOf,
  handlerOf,
  parseSource,
  readSource,
  schemaProperties,
  squash,
  topLevelConst,
} from '@/test/service-source';

import { SIGNATURE_WORKFLOW, commandRequest } from './contract-commands';
import { CONTRACTOR_ROLE, OVERSIGHT_ROLE, PLATFORM_ADMINISTRATOR } from './contract-statements';
import { AMENDMENT_SCHEMA, CONTRACT_DETAIL_SCHEMA, MILESTONE_SCHEMA } from './contracts';
import { loadWebServerEnv } from './env';

/**
 * What the contract command forms depend on, pinned to contract-service's
 * source — the technique of `contract-statements.contract.spec.ts`: A-02
 * forbids importing `services/*\/src`, so the portal keeps copies
 * (`server/contract-commands.ts`, `lib/contract-command-fields.ts`, the
 * `WEB_CONTRACT_*` settings) and this test fails the moment a copy and its
 * original disagree. No view carries a list of the caller's available
 * actions, so "may this person use the form" is a copy of the service's own
 * checks — each of them pinned here, in the service's order.
 */

const SERVICE = ['services', 'contract-service', 'src'] as const;
const parse = (...path: string[]) => parseSource(readSource(...SERVICE, ...path));
const flat = (...path: string[]) => squash(readSource(...SERVICE, ...path))!;

const contractController = parse('contract', 'contract.controller.ts');
const amendmentController = parse('amendment', 'amendment.controller.ts');
const milestoneController = parse('milestone', 'milestone.controller.ts');
const policyController = parse('policy', 'policy.controller.ts');
const contractDto = parse('contract', 'dto.ts');
const amendmentDto = parse('amendment', 'dto.ts');
const milestoneDto = parse('milestone', 'dto.ts');
const policyDto = parse('policy', 'dto.ts');
const refusal = parse('shared', 'refusal.ts');
const access = flat('access', 'access.ts');
const contractService = flat('contract', 'contract.service.ts');
const amendmentService = flat('amendment', 'amendment.service.ts');
const milestoneService = flat('milestone', 'milestone.service.ts');
const signingAuthority = flat('signing', 'signing-authority.ts');
const policyAccess = flat('policy', 'policy.access.ts');
const policyRepository = flat('policy', 'policy.repository.ts');
const policyStates = flat('policy', 'policy.state-machine.ts');
const contractEnv = flat('config', 'env.ts');
const gatewayRoutes = squash(readSource('services', 'api-gateway', 'src', 'config', 'routes.ts'))!;

function controllerPath(controller: ts.SourceFile): string | undefined {
  const decorator = collect(controller, ts.isClassDeclaration)
    .flatMap((node) => ts.getDecorators(node) ?? [])
    .map((candidate) => candidate.expression)
    .filter(ts.isCallExpression)
    .find((call) => call.expression.getText() === 'Controller');
  return squash(decorator?.arguments[0]?.getText());
}

/** A method's body, squashed, between its name and the next one's. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`cannot find ${from} … ${to}`);
  return source.slice(start, end);
}

/** The path a command is sent to, relative to `/v1/contracts/{id}`. */
const pathOf = (
  command: Parameters<typeof commandRequest>[1]['command'],
  subjectId: string | null,
  input: Parameters<typeof commandRequest>[2],
) =>
  commandRequest(
    'CTR',
    {
      command,
      subjectId,
      expectedVersion: command === 'PLAN_MILESTONE' ? null : 1,
      side: command.startsWith('SIGN') ? 'EMPLOYER' : null,
    },
    input,
  )!;

describe('the routes', () => {
  it('are under the gateway’s contracts prefix, version 1; the policies under their own', () => {
    expect(controllerPath(contractController)).toBe("{path:'contracts',version:'1'}");
    expect(controllerPath(amendmentController)).toBe(
      "{path:'contracts/:id/amendments',version:'1'}",
    );
    expect(controllerPath(milestoneController)).toBe(
      "{path:'contracts/:id/milestones',version:'1'}",
    );
    expect(controllerPath(policyController)).toBe(
      "{path:'contract-approval-policies',version:'1'}",
    );
    expect(gatewayRoutes).toContain("{prefix:'contracts',service:'contract'}");
    expect(gatewayRoutes).toContain("{prefix:'contract-approval-policies',service:'contract'}");
  });

  it('signs and cancels the contract where the portal posts', () => {
    expect(decoratorOf(contractController, 'sign', 'Post')?.arguments[0]?.getText()).toBe(
      "':id/sign'",
    );
    expect(decoratorOf(contractController, 'cancel', 'Post')?.arguments[0]?.getText()).toBe(
      "':id/cancel'",
    );
    expect(pathOf('SIGN', null, null)).toMatchObject({
      method: 'POST',
      path: '/v1/contracts/CTR/sign',
    });
    expect(pathOf('CANCEL', null, { reasonCode: 'OTHER' })).toMatchObject({
      path: '/v1/contracts/CTR/cancel',
    });
  });

  it('proposes and signs an amendment, plans by POST and changes by PATCH a milestone', () => {
    expect(decoratorOf(amendmentController, 'propose', 'Post')?.arguments).toHaveLength(0);
    expect(decoratorOf(amendmentController, 'sign', 'Post')?.arguments[0]?.getText()).toBe(
      "':amendmentId/sign'",
    );
    expect(decoratorOf(milestoneController, 'plan', 'Post')?.arguments).toHaveLength(0);
    expect(decoratorOf(milestoneController, 'change', 'Patch')?.arguments[0]?.getText()).toBe(
      "':milestoneId'",
    );
    expect(pathOf('SIGN_AMENDMENT', 'AMD', null).path).toBe(
      '/v1/contracts/CTR/amendments/AMD/sign',
    );
    const milestone = { title: 't', plannedDate: '2026-12-20', plannedShareBp: null };
    expect(pathOf('PLAN_MILESTONE', null, milestone)).toMatchObject({
      method: 'POST',
      path: '/v1/contracts/CTR/milestones',
    });
    expect(pathOf('CHANGE_MILESTONE', 'MST', milestone)).toMatchObject({
      method: 'PATCH',
      path: '/v1/contracts/CTR/milestones/MST',
    });
  });

  it('names no role on any handler, demands a platform user id and an Idempotency-Key on every command', () => {
    const commands: [ts.SourceFile, string][] = [
      [contractController, 'sign'],
      [contractController, 'cancel'],
      [amendmentController, 'propose'],
      [amendmentController, 'sign'],
      [milestoneController, 'plan'],
      [milestoneController, 'change'],
    ];
    for (const [controller, method] of commands) {
      expect(decoratorOf(controller, method, 'Roles')).toBeUndefined();
      expect(decoratorOf(controller, method, 'RequirePlatformUserId')).toBeDefined();
      expect(squash(handlerOf(controller, method).getText())).toContain(
        'requiredIdempotencyKey(idempotencyKey)',
      );
    }
  });
});

describe('the bodies the portal sends', () => {
  it('a signature is the version read, and nothing else', () => {
    expect([...schemaProperties(contractDto, 'signContractSchema').keys()]).toEqual([
      'expectedVersion',
    ]);
    expect([...schemaProperties(amendmentDto, 'signAmendmentSchema').keys()]).toEqual([
      'expectedVersion',
    ]);
  });

  it('a cancellation is a reason code, an optional bounded note and the version', () => {
    expect([...schemaProperties(contractDto, 'cancelContractSchema').keys()]).toEqual([
      'reasonCode',
      'note',
      'expectedVersion',
    ]);
    expect(topLevelConst(contractDto, 'MAX_CANCEL_NOTE_LENGTH').getText()).toBe(
      String(CANCEL_NOTE_MAX),
    );
    expect(squash(schemaProperties(contractDto, 'cancelContractSchema').get('note'))).toContain(
      'plainText().min(1).max(MAX_CANCEL_NOTE_LENGTH).optional()',
    );
  });

  it('a proposal is the amount, a reason code, its text and the contract’s version', () => {
    expect([...schemaProperties(amendmentDto, 'proposeAmendmentSchema').keys()]).toEqual([
      'deltaMinor',
      'reasonCode',
      'reasonText',
      'expectedVersion',
    ]);
    expect(topLevelConst(amendmentDto, 'MAX_AMENDMENT_REASON_LENGTH').getText()).toBe(
      String(AMENDMENT_REASON_MAX),
    );
  });

  it('a plan takes no version; a change takes every field and one; the bounds are the form’s', () => {
    expect([...schemaProperties(milestoneDto, 'planMilestoneSchema').keys()]).toEqual([
      'title',
      'plannedDate',
      'plannedShareBp',
    ]);
    expect([...schemaProperties(milestoneDto, 'changeMilestoneSchema').keys()]).toEqual([
      'title',
      'plannedDate',
      'plannedShareBp',
      'expectedVersion',
    ]);
    expect(
      squash(schemaProperties(milestoneDto, 'changeMilestoneSchema').get('plannedShareBp')),
    ).toBe('plannedShareBp.nullable().optional()');
    expect(topLevelConst(milestoneDto, 'MAX_MILESTONE_TITLE_LENGTH').getText()).toBe(
      String(MILESTONE_TITLE_MAX),
    );
    expect(topLevelConst(milestoneDto, 'MAX_PLANNED_SHARE_BP').getText()).toBe('10_000');
    expect(PLANNED_SHARE_BP_MAX).toBe(10_000);
    const day = squash(topLevelConst(milestoneDto, 'calendarDate').getText())!;
    expect(day).toContain(".regex(/^\\d{4}-\\d{2}-\\d{2}$/,'AdateisYYYY-MM-DD')");
    expect(day).toContain('if(year<1000)returnfalse;');
  });

  it('every body is strict: nothing in it may say who acts, for which side, or when', () => {
    for (const [dto, name] of [
      [contractDto, 'signContractSchema'],
      [contractDto, 'cancelContractSchema'],
      [amendmentDto, 'proposeAmendmentSchema'],
      [amendmentDto, 'signAmendmentSchema'],
      [milestoneDto, 'planMilestoneSchema'],
      [milestoneDto, 'changeMilestoneSchema'],
    ] as const) {
      expect(squash(topLevelConst(dto, name).getText())).toContain('.strict()');
    }
  });
});

describe('the answers the portal confirms against', () => {
  it('the contract, amendment and milestone views have the fields the portal keeps', () => {
    const keys = (dto: ts.SourceFile, name: string) =>
      [...schemaProperties(dto, name).keys()].sort();
    expect(Object.keys(CONTRACT_DETAIL_SCHEMA.shape).sort()).toEqual(
      keys(contractDto, 'contractViewSchema'),
    );
    expect(Object.keys(AMENDMENT_SCHEMA.shape).sort()).toEqual(
      keys(amendmentDto, 'amendmentViewSchema'),
    );
    expect(Object.keys(MILESTONE_SCHEMA.shape).sort()).toEqual(
      keys(milestoneDto, 'milestoneViewSchema'),
    );
  });

  it('the policy list carries what the signing check reads', () => {
    const view = schemaProperties(policyDto, 'policyViewSchema');
    for (const field of ['id', 'organizationId', 'workflowKey', 'status', 'steps'])
      expect(view.has(field)).toBe(true);
    const step = schemaProperties(policyDto, 'policyStepViewSchema');
    expect(step.has('authorityOrganizationId') && step.has('authorityRole')).toBe(true);
    expect(squash(topLevelConst(policyDto, 'listPoliciesQuerySchema').getText())).toContain(
      'workflowKey:z.enum(WORKFLOW_KEYS).optional(),status:z.enum(POLICY_STATES).optional()',
    );
  });
});

describe('who signs — ContractService.sign, AmendmentService.sign, SigningAuthority', () => {
  it('names the roles the portal checks', () => {
    expect(access).toContain(`exportconstSUPER_ROLE='${PLATFORM_ADMINISTRATOR}';`);
    expect(access).toContain(`exportconstCONTRACTOR_ROLE='${CONTRACTOR_ROLE}';`);
    expect(access).toContain(`constOVERSIGHT_ROLE='${OVERSIGHT_ROLE}';`);
  });

  it('the commanding caller: not the oversight role, a service or the platform administrator, and for an organization', () => {
    for (const [from, to] of [
      ['assertCanCommand():Acting{', 'assertCanCommandAmendments():Acting{'],
      ['assertCanCommandAmendments():Acting{', 'assertCanCommandStatements():Acting{'],
    ]) {
      const body = between(access, from!, to!);
      expect(body).toContain('assertNotAuditor();assertNotServiceCaller();');
      expect(body).toContain(
        'if(context.roles.includes(SUPER_ROLE)){throwplatformAdministratorRefused(',
      );
      expect(body).toContain('if(!context.organizationId){');
    }
    expect(contractService).toContain('()=>this.access.assertCanCommand(),');
    expect(amendmentService).toContain('()=>this.access.assertCanCommandAmendments(),');
    expect(milestoneService).toContain('()=>this.access.assertCanCommandAmendments(),');
  });

  it('the contract: a party; never a member of both; a new signature of its side; the contractor’s role; a draft', () => {
    const sign = between(contractService, 'asyncsign(', 'privateasyncrecordRefusal(');
    expect(sign).toContain(
      "if(this.access.isMemberOfBothParties(row)){returnthis.refusals.refuse({...base,reason:'MEMBER_OF_BOTH_PARTIES'}",
    );
    const locked = between(contractService, 'privateasyncsignLocked(', '//--cancel');
    const order = [
      'constmine=signatures.find((signature)=>signature.side===side);',
      "if(side==='CONTRACTOR'){try{contractorRole=this.access.contractorSigningRole();",
      "['SIDE_ALREADY_SIGNED']",
      "if(contract.status!=='DRAFT'){",
      'constauthority=awaitthis.authorityOf(tx,contract,side,contractorRole);',
      "['SAME_PERSON_BOTH_SIDES']",
    ].map((step) => locked.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('an amendment: the same machinery — a proposed amendment of a signed contract', () => {
    expect(amendmentService).toContain('if(this.access.isMemberOfBothParties(row)){');
    const locked = between(amendmentService, 'privateasyncsignLocked(', 'privateasyncauthorityOf(');
    for (const step of [
      'constmine=signatures.find((signature)=>signature.side===side);',
      'contractorRole=this.access.contractorSigningRole();',
      "if(amendment.status!=='PROPOSED'){",
      "this.assertSigned(contract,'sign_amendment');",
    ]) {
      expect(locked).toContain(step);
    }
    expect(amendmentService).toContain("if(contract.status!=='SIGNED'){");
  });

  it('the employer’s side: the contract.signature policy ACTIVE for its organization, a step naming it and a held role', () => {
    expect(policyStates).toContain(
      `exportconstSIGNATURE_WORKFLOW:WorkflowKey='${SIGNATURE_WORKFLOW}';`,
    );
    expect(signingAuthority).toContain(
      'constpolicy=awaitthis.policies.findActivePolicyOf(tx,contract.organizationId,SIGNATURE_WORKFLOW,);',
    );
    expect(signingAuthority).toContain(
      "if(!policy)thrownewSigningAuthorityDenied('SIGNATURE_POLICY_REQUIRED',null);",
    );
    expect(signingAuthority).toContain('constrole=signingRoleUnder(policy,getContext().roles);');
    expect(policyRepository).toContain("where:{organizationId,workflowKey,status:'ACTIVE'},");
    expect(between(policyAccess, 'exportfunctionsigningRoleUnder(', '@Injectable()')).toContain(
      'step.authorityOrganizationId===policy.organizationId&&heldRoles.includes(step.authorityRole),',
    );
  });

  it('the employer’s contract readers may read that policy (the page asks before it draws the form)', () => {
    expect(policyAccess).toContain('this.readers=[SUPER_ROLE,...env.CONTRACT_READER_ROLES];');
    expect(between(policyAccess, 'listVisibility()', 'assertCanSeePolicy(')).toContain(
      'if(own&&this.readers.some((role)=>context.roles.includes(role))){clauses.push({organizationId:own});}',
    );
  });

  it('membership of both parties is the signed memberships, never the tenant selected', () => {
    expect(
      between(access, 'isMemberOfBothParties(contract:{', 'assertCanRead():ReadingParties{'),
    ).toContain(
      'constmemberships=getContext().organizationIds;return(memberships.includes(contract.organizationId)&&memberships.includes(contract.contractorOrganizationId));',
    );
  });
});

describe('who cancels, amends and plans — configured roles, mirrored', () => {
  it('cancel: the employer, CONTRACT_CANCEL_ROLES, a draft, unsigned unless CONTRACT_CANCEL_AFTER_SIGNATURE', () => {
    expect(
      between(
        access,
        'assertMayCancel(side:ContractSideName):void{',
        'mayProposeAmendment():boolean{',
      ),
    ).toContain("if(side!=='EMPLOYER'){throwRastaError.forbidden(");
    const cancel = between(contractService, 'asynccancel(', '//--shared');
    for (const step of [
      'this.access.assertMayCancel(side);',
      'if(!this.env.CONTRACT_CANCEL_REASON_CODES.includes(dto.reasonCode)){',
      "if(contract.status!=='DRAFT'){",
      'if(signatures.length>0&&!this.env.CONTRACT_CANCEL_AFTER_SIGNATURE){',
    ]) {
      expect(cancel).toContain(step);
    }
  });

  it('propose: the employer (PROPOSER_NOT_EMPLOYER), CONTRACT_AMENDMENT_ROLES, a signed contract', () => {
    const propose = between(amendmentService, 'asyncpropose(', 'asyncsign(');
    expect(propose).toContain(
      "if(side!=='EMPLOYER'){returnthis.refusals.refuse({...base,reason:'NOT_EMPLOYER'}",
    );
    expect(propose).toContain('if(!this.access.mayProposeAmendment()){');
    expect(propose).toContain("this.assertSigned(contract,'propose_amendment');");
  });

  it('plan and change: the employer (EDITOR_NOT_EMPLOYER), CONTRACT_MILESTONE_ROLES, a signed contract; a referenced one never changes', () => {
    const edit = between(milestoneService, 'privateasyncassertMayEdit(', 'privateassertSigned(');
    expect(edit).toContain("if(side!=='EMPLOYER'){");
    expect(edit).toContain('if(!this.access.mayPlanMilestones()){');
    expect(milestoneService).toContain("this.assertSigned(contract,'plan_milestone');");
    expect(milestoneService).toContain('if(milestone.firstReferencedAt!==null){');
    expect(milestoneService).toContain("this.assertSigned(contract,'change_milestone');");
  });

  it('the portal’s settings default to the service’s', () => {
    const web = loadWebServerEnv({
      API_GATEWAY_URL: 'http://gateway.test:3000',
      OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
      OIDC_CLIENT_ID: 'rasta-web',
      WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
      WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
    });
    const defaultOf = (name: string): string => {
      const match = new RegExp(`${name}:z\\.string\\(\\)\\.prefault\\('([^']*)'\\)`).exec(
        contractEnv,
      );
      if (!match) throw new Error(`no default for ${name}`);
      return match[1]!;
    };
    expect(web.WEB_CONTRACT_CANCEL_ROLES.join(',')).toBe(defaultOf('CONTRACT_CANCEL_ROLES'));
    expect(web.WEB_CONTRACT_AMENDMENT_ROLES.join(',')).toBe(defaultOf('CONTRACT_AMENDMENT_ROLES'));
    expect(web.WEB_CONTRACT_MILESTONE_ROLES.join(',')).toBe(defaultOf('CONTRACT_MILESTONE_ROLES'));
    expect(web.WEB_CONTRACT_CANCEL_REASON_CODES.join(',')).toBe(
      defaultOf('CONTRACT_CANCEL_REASON_CODES'),
    );
    expect(web.WEB_CONTRACT_AMENDMENT_REASON_CODES.join(',')).toBe(
      defaultOf('CONTRACT_AMENDMENT_REASON_CODES'),
    );
    expect(contractEnv).toContain('CONTRACT_CANCEL_AFTER_SIGNATURE:booleanEnv(false),');
    expect(web.WEB_CONTRACT_CANCEL_AFTER_SIGNATURE).toBe(false);
  });
});

describe('the refusals the forms say', () => {
  function reasonsOf(area: string): string[] {
    const table = collect(
      topLevelConst(refusal, 'REFUSAL_REASONS'),
      ts.isObjectLiteralExpression,
    )[0]!;
    const entry = table.properties
      .filter(ts.isPropertyAssignment)
      .find((property) => property.name.getText() === area);
    if (!entry || !ts.isObjectLiteralExpression(entry.initializer))
      throw new Error(`no area ${area}`);
    return entry.initializer.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => property.name.getText());
  }

  const areas = ['signature', 'cancellation', 'amendment', 'milestone'];

  it('has fixed words for every closed reason of the four areas', () => {
    for (const area of areas) {
      for (const reason of reasonsOf(area)) {
        expect([area, reason, CONTRACT_REFUSAL_TEXT[reason]]).toEqual([
          area,
          reason,
          expect.any(String),
        ]);
      }
    }
  });

  it('and words for none the service cannot send', () => {
    const sent = new Set(areas.flatMap(reasonsOf));
    expect(Object.keys(CONTRACT_REFUSAL_TEXT).filter((reason) => !sent.has(reason))).toEqual([]);
  });

  it('the areas are the ones these routes refuse in', () => {
    for (const area of areas)
      expect(squash(topLevelConst(refusal, 'REFUSAL_AREAS').getText())).toContain(`${area}:`);
  });
});
