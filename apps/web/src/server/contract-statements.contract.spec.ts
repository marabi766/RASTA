/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  LINE_DESCRIPTION_MAX,
  MAX_STATEMENT_LINES,
  STATEMENT_CHAINS,
  STATEMENT_REFUSAL_TEXT,
  STATEMENT_STATES,
} from '@/lib/statement-fields';
import {
  collect,
  decoratorOf,
  handlerOf,
  literalsOf,
  parseSource,
  readSource,
  schemaProperties,
  squash,
  topLevelConst,
} from '@/test/service-source';

import {
  CONTRACTOR_ROLE,
  OVERSIGHT_ROLE,
  PLATFORM_ADMINISTRATOR,
  STATEMENT_SCHEMA,
  STATEMENT_STEP_PATHS,
  STATEMENTS_PER_PAGE,
} from './contract-statements';

/**
 * What the statement screens depend on, pinned to contract-service's source —
 * the technique of `transactions.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies (`server/contract-statements.ts`,
 * `lib/statement-fields.ts`) and this test fails the moment a copy and its
 * original disagree. The statement view has no per-caller list of available
 * actions, so the portal's "may this person use the form" is a copy of the
 * service's own checks — every one of them pinned here.
 */

const SERVICE = ['services', 'contract-service', 'src'] as const;
const controller = parseSource(readSource(...SERVICE, 'statement', 'statement.controller.ts'));
const dto = parseSource(readSource(...SERVICE, 'statement', 'dto.ts'));
const stateMachine = parseSource(readSource(...SERVICE, 'statement', 'statement.state-machine.ts'));
const statementService = squash(readSource(...SERVICE, 'statement', 'statement.service.ts'))!;
const decisionService = squash(
  readSource(...SERVICE, 'statement', 'statement-decision.service.ts'),
)!;
const decisions = squash(readSource(...SERVICE, 'statement', 'decisions.ts'))!;
const access = squash(readSource(...SERVICE, 'access', 'access.ts'))!;
const refusal = parseSource(readSource(...SERVICE, 'shared', 'refusal.ts'));
const contractEnv = squash(readSource(...SERVICE, 'config', 'env.ts'))!;
const gatewayRoutes = squash(readSource('services', 'api-gateway', 'src', 'config', 'routes.ts'))!;
const tokenVerifier = squash(
  readSource('packages', 'nest-common', 'src', 'auth', 'token-verifier.ts'),
)!;

describe('the routes', () => {
  it('are under /v1/contracts/:id/statements, version 1, behind the gateway’s contracts prefix', () => {
    const classDecorator = collect(controller, ts.isClassDeclaration)
      .flatMap((node) => ts.getDecorators(node) ?? [])
      .map((decorator) => decorator.expression)
      .filter(ts.isCallExpression)
      .find((call) => call.expression.getText() === 'Controller');
    expect(squash(classDecorator?.arguments[0]?.getText())).toBe(
      "{path:'contracts/:id/statements',version:'1'}",
    );
    expect(gatewayRoutes).toContain("{prefix:'contracts',service:'contract'}");
  });

  it('reads the list and one statement', () => {
    expect(decoratorOf(controller, 'list', 'Get')?.arguments).toHaveLength(0);
    expect(decoratorOf(controller, 'get', 'Get')?.arguments[0]?.getText()).toBe("':statementId'");
  });

  it('drafts at the collection, submits and decides at the paths the portal posts to', () => {
    expect(decoratorOf(controller, 'draft', 'Post')?.arguments).toHaveLength(0);
    expect(decoratorOf(controller, 'submit', 'Post')?.arguments[0]?.getText()).toBe(
      `':statementId/${STATEMENT_STEP_PATHS.SUBMIT}'`,
    );
    expect(decoratorOf(controller, 'decide', 'Post')?.arguments[0]?.getText()).toBe(
      `':statementId/${STATEMENT_STEP_PATHS.APPROVE}'`,
    );
    expect(STATEMENT_STEP_PATHS.REJECT).toBe(STATEMENT_STEP_PATHS.APPROVE);
  });

  it('names no role on any handler — the service decides, after RolesGuard refuses the oversight role', () => {
    for (const method of ['list', 'get', 'draft', 'submit', 'decide']) {
      expect(decoratorOf(controller, method, 'Roles')).toBeUndefined();
    }
  });

  it('demands a platform user id on every command (`rasta_uid` in the token)', () => {
    for (const method of ['draft', 'submit', 'decide']) {
      expect(decoratorOf(controller, method, 'RequirePlatformUserId')).toBeDefined();
    }
    expect(decoratorOf(controller, 'list', 'RequirePlatformUserId')).toBeUndefined();
    expect(tokenVerifier).toContain("rastaUserId:readString(payload,'rasta_uid')");
    expect(tokenVerifier).toContain("organizationIds:readStringArray(payload,'org_ids')");
  });

  it('takes the Idempotency-Key on every command', () => {
    for (const method of ['draft', 'submit', 'decide']) {
      expect(squash(handlerOf(controller, method).getText())).toContain(
        'requiredIdempotencyKey(idempotencyKey)',
      );
    }
  });
});

describe('the bodies the portal sends', () => {
  it('a draft is lines (description, amountMinor, optional milestoneId) and optional deductions', () => {
    expect([...schemaProperties(dto, 'draftStatementSchema').keys()]).toEqual([
      'lines',
      'deductions',
    ]);
    const line = squash(topLevelConst(dto, 'line').getText())!;
    expect(line).toContain('description:plainText().min(1).max(MAX_LINE_DESCRIPTION_LENGTH)');
    expect(line).toContain('amountMinor:amountMinorSchema.refine((value)=>!/^0+$/.test(value)');
    expect(line).toContain('milestoneId:z.string().min(1).max(128).optional()');
    expect(squash(topLevelConst(dto, 'draftStatementSchema').getText())).toContain('.strict()');
  });

  it('bounds a line as the form does', () => {
    expect(topLevelConst(dto, 'MAX_LINE_DESCRIPTION_LENGTH').getText()).toBe(
      String(LINE_DESCRIPTION_MAX),
    );
    expect(topLevelConst(dto, 'MAX_STATEMENT_LINES').getText()).toBe(String(MAX_STATEMENT_LINES));
  });

  it('a submit is the version read, and nothing else', () => {
    expect([...schemaProperties(dto, 'submitStatementSchema').keys()]).toEqual(['expectedVersion']);
  });

  it('a decision names its chain and step, the decision, and the version read', () => {
    const properties = schemaProperties(dto, 'decideStatementSchema');
    expect([...properties.keys()]).toEqual(['chain', 'stepOrder', 'decision', 'expectedVersion']);
    expect(literalsOf(properties.get('chain'))).toEqual(
      expect.arrayContaining([...STATEMENT_CHAINS]),
    );
    expect(literalsOf(properties.get('decision')).slice(0, 2)).toEqual(['APPROVE', 'REJECT']);
  });

  it('has no reason field on a decision — a rejection from the portal carries none', () => {
    expect(squash(topLevelConst(dto, 'decideStatementSchema').getText())).not.toMatch(
      /reason|note|comment/i,
    );
  });

  it('pages the list at most fifty at a time', () => {
    expect(squash(topLevelConst(dto, 'listStatementsQuerySchema').getText())).toContain(
      'limit:numberInput(z.number().int().min(1).max(50)).prefault(20)',
    );
    expect(STATEMENTS_PER_PAGE).toBeLessThanOrEqual(50);
  });
});

describe('the view the portal reads', () => {
  it('has the fields the portal keeps, and no person', () => {
    const service = [...schemaProperties(dto, 'statementViewSchema').keys()].sort();
    expect(Object.keys(STATEMENT_SCHEMA.shape).sort()).toEqual(service);
    expect(service).not.toEqual(expect.arrayContaining(['submittedBy']));
    const chain = squash(topLevelConst(dto, 'approvalChainView').getText())!;
    expect(chain).not.toMatch(/decidedBy/);
    expect(chain).toContain("outcome:z.enum(['APPROVED','REJECTED'])");
  });

  it('knows every statement status', () => {
    expect(literalsOf(topLevelConst(stateMachine, 'STATEMENT_STATES').getText())).toEqual([
      ...STATEMENT_STATES,
    ]);
  });

  it('submits only a draft (the one `submit` transition)', () => {
    const table = squash(topLevelConst(stateMachine, 'STATEMENT_TRANSITIONS').getText())!;
    expect(table.match(/command:'submit'/g)).toHaveLength(1);
    expect(table).toContain("{from:'DRAFT',to:'SUBMITTED',command:'submit'}");
  });
});

describe('who may draft and submit — `contractorsContract`, `assertSigned`', () => {
  it('names the roles the portal checks', () => {
    expect(access).toContain(`exportconstSUPER_ROLE='${PLATFORM_ADMINISTRATOR}';`);
    expect(access).toContain(`exportconstCONTRACTOR_ROLE='${CONTRACTOR_ROLE}';`);
    expect(access).toContain(`constOVERSIGHT_ROLE='${OVERSIGHT_ROLE}';`);
  });

  it('refuses the oversight role, the platform administrator and a request for no organization', () => {
    const body = access.slice(
      access.indexOf('assertCanCommandStatements():Acting{'),
      access.indexOf('assertCanDecideStatements():Acting{'),
    );
    expect(body).toContain('assertNotAuditor();');
    expect(body).toContain(
      'if(context.roles.includes(SUPER_ROLE)){throwplatformAdministratorRefused(',
    );
    expect(body).toContain('if(!context.organizationId){');
  });

  it('only the contractor side, with the CONTRACTOR role', () => {
    expect(statementService).toContain('this.access.assertCanCommandStatements()');
    expect(statementService).toContain("if(side!=='CONTRACTOR'){");
    expect(statementService).toContain('if(!this.access.isContractor()){');
    expect(access).toContain(
      'isContractor():boolean{returngetContext().roles.includes(CONTRACTOR_ROLE);}',
    );
    expect(access).toContain(
      "if(contract.organizationId===organizationId)return'EMPLOYER';if(contract.contractorOrganizationId===organizationId)return'CONTRACTOR';",
    );
  });

  it('only on a signed contract', () => {
    expect(statementService).toContain(
      "privateassertSigned(contract:Contract,command:StatementCommand):void{if(contract.status!=='SIGNED'){",
    );
  });
});

describe('who may decide — `StatementDecisionService.decide`', () => {
  it('refuses the oversight role, the platform administrator and a request for no organization', () => {
    const start = access.indexOf('assertCanDecideStatements():Acting{');
    const body = access.slice(start, access.indexOf('isMemberOf(', start));
    expect(body).toContain('assertNotAuditor();');
    expect(body).toContain(
      'if(context.roles.includes(SUPER_ROLE)){throwplatformAdministratorRefused(',
    );
    expect(body).toContain('if(!context.organizationId){');
    expect(decisionService).toContain('this.access.assertCanDecideStatements()');
  });

  it('a party or an organization the chains name; anyone else is told nothing exists', () => {
    expect(decisionService).toContain('step.authorityOrganizationId===acting.organizationId');
    expect(decisionService).toContain("if(!side)throwRastaError.notFound('Contract',contractId);");
  });

  it('never a member of the contractor’s organization acting for another', () => {
    expect(decisionService).toContain(
      "if(side!=='CONTRACTOR'&&this.access.isMemberOf(contract.contractorOrganizationId)){",
    );
    expect(access).toContain(
      'isMemberOf(organizationId:string):boolean{returngetContext().organizationIds.includes(organizationId);}',
    );
  });

  it('on a signed contract, the open chain’s next step, its organization and its exact role', () => {
    expect(decisionService).toContain("if(contract.status!=='SIGNED'){");
    expect(decisions).toContain(
      "if(status==='SUBMITTED')return'TECHNICAL';if(status==='TECHNICALLY_APPROVED')return'FINANCIAL';returnnull;",
    );
    expect(decisions).toContain(
      "if(remaining[0]?.stepOrder!==step.stepOrder)return{ok:false,reason:'STEP_NOT_NEXT'};",
    );
    expect(decisionService).toContain('if(step.authorityOrganizationId!==input.acting){');
    expect(decisionService).toContain('if(!this.access.holdsRole(step.authorityRole)){');
    // Exact: no administrator override (the administrator was refused above).
    expect(access).toContain(
      'holdsRole(role:string):boolean{returngetContext().roles.includes(role);}',
    );
  });

  it('leaves to the service what the view cannot show: who submitted and who decided', () => {
    expect(decisionService).toContain("if(separation==='SUBMITTER'){");
    expect(decisionService).toContain("if(separation==='ALREADY_DECIDED'){");
  });
});

describe('the refusals the portal says in its own words', () => {
  /** The closed reasons of one area of `REFUSAL_REASONS`, read from the literal. */
  function reasonsOf(area: string): string[] {
    const table = collect(
      topLevelConst(refusal, 'REFUSAL_REASONS'),
      ts.isObjectLiteralExpression,
    )[0]!;
    const entry = table.properties
      .filter(ts.isPropertyAssignment)
      .find((property) => property.name.getText() === area);
    if (!entry || !ts.isObjectLiteralExpression(entry.initializer)) {
      throw new Error(`no area ${area}`);
    }
    return entry.initializer.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => property.name.getText());
  }

  it('has fixed words for every closed reason of drafting, submitting and deciding — and no other', () => {
    const service = [...new Set([...reasonsOf('statement'), ...reasonsOf('decision')])].sort();
    expect(Object.keys(STATEMENT_REFUSAL_TEXT).sort()).toEqual(service);
  });

  it('separation of duties is among them', () => {
    for (const reason of [
      'MEMBER_OF_CONTRACTOR',
      'SUBMITTER_MAY_NOT_DECIDE',
      'ALREADY_DECIDED_STATEMENT',
    ]) {
      expect(reasonsOf('decision')).toContain(reason);
      expect(STATEMENT_REFUSAL_TEXT[reason]).toMatch(/^تفکیک وظایف/);
    }
  });
});

describe('the replay window', () => {
  it('mirrors contract-service’s idempotency retention bounds', () => {
    expect(contractEnv).toContain(
      'CONTRACT_IDEMPOTENCY_TTL_HOURS:z.coerce.number().int().min(1).max(168).prefault(24)',
    );
    expect(squash(readSource('apps', 'web', 'src', 'server', 'env.ts'))).toContain(
      'WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS:z.coerce.number().int().min(1).max(168).prefault(1)',
    );
  });
});
