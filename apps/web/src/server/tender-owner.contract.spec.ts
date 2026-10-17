/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  APPROVAL_REFUSAL_TEXT,
  OPENING_REFUSAL_TEXT,
  PUBLICATION_REFUSAL_TEXT,
  REJECT_REASON_MAX,
  REJECT_REASON_MIN,
  requestStatusLabel,
  stepStatusLabel,
} from '@/lib/tender-owner-fields';
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

import {
  APPROVAL_REQUEST_SCHEMA,
  APPROVAL_SCHEMA,
  BID_EXCLUDED_ROLES,
  CONTRACTOR_ROLE,
  OVERSIGHT_ROLE,
  OWNER_BIDS_SCHEMA,
  PLATFORM_ADMINISTRATOR,
  PUBLICATION_WORKFLOW,
} from './tender-owner';

/**
 * What the owner's forms depend on, pinned to construction-service's source —
 * the technique of `tender-bids.contract.spec.ts`. No owner view carries the
 * caller's available actions, so "may this person use the form" is a copy of
 * the service's checks — each pinned here — and every closed reason the
 * owner's commands can name has the page's fixed words.
 */

const SERVICE = ['services', 'construction-service', 'src'] as const;
const publication = parseSource(readSource(...SERVICE, 'tender', 'publication.controller.ts'));
const opening = parseSource(readSource(...SERVICE, 'tender', 'bid-opening.controller.ts'));
const approvals = parseSource(readSource(...SERVICE, 'approval', 'approval.controller.ts'));
const requests = parseSource(readSource(...SERVICE, 'tender', 'tender-approval.controller.ts'));
const approvalDto = parseSource(readSource(...SERVICE, 'approval', 'dto.ts'));
const approvalStates = parseSource(readSource(...SERVICE, 'approval', 'approval.state-machine.ts'));
const requestDto = parseSource(readSource(...SERVICE, 'tender', 'tender-approval.dto.ts'));
const openingDto = parseSource(readSource(...SERVICE, 'tender', 'bid-opening.dto.ts'));
const publicationDto = parseSource(readSource(...SERVICE, 'tender', 'publication.dto.ts'));
const publicationRules = parseSource(readSource(...SERVICE, 'tender', 'publication.ts'));
const publicationService = squash(readSource(...SERVICE, 'tender', 'publication.service.ts'))!;
const openService = readSource(...SERVICE, 'tender', 'tender-open.service.ts');
const openServiceTree = parseSource(openService);
const approvalErrors = parseSource(readSource(...SERVICE, 'tender', 'tender-approval.errors.ts'));
const tenderApprovals = squash(readSource(...SERVICE, 'tender', 'tender-approval.service.ts'))!;
const access = squash(readSource(...SERVICE, 'access', 'access.ts'))!;
const constructionEnv = squash(readSource(...SERVICE, 'config', 'env.ts'))!;
const gatewayRoutes = squash(readSource('services', 'api-gateway', 'src', 'config', 'routes.ts'))!;
const authGuard = squash(readSource('packages', 'nest-common', 'src', 'guards', 'auth.guard.ts'))!;
const webEnv = squash(readSource('apps', 'web', 'src', 'server', 'env.ts'))!;

function method(tree: ts.SourceFile, name: string): string {
  const found = collect(tree, ts.isMethodDeclaration).find((node) => node.name.getText() === name);
  if (!found) throw new Error(`no method ${name}`);
  return squash(found.getText())!;
}

describe('the routes', () => {
  it('publish, the opening’s three and the owner’s read of the bids are where the portal sends them', () => {
    expect(decoratorOf(publication, 'publish', 'Post')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/publish'",
    );
    expect(decoratorOf(opening, 'open', 'Post')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/open-bids'",
    );
    expect(decoratorOf(opening, 'propose', 'Post')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/open-bids/proposal'",
    );
    expect(decoratorOf(opening, 'withdrawProposal', 'Post')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/open-bids/proposal/withdraw'",
    );
    expect(decoratorOf(opening, 'list', 'Get')?.arguments[0]?.getText()).toBe("'tenders/:id/bids'");
    expect(decoratorOf(requests, 'list', 'Get')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/approvals'",
    );
  });

  it('a decision is POST /v1/approvals/:id/decision, and a step is read at /v1/approvals/:id', () => {
    const classDecorator = collect(approvals, ts.isClassDeclaration)
      .flatMap((node) => ts.getDecorators(node) ?? [])
      .map((decorator) => decorator.expression)
      .filter(ts.isCallExpression)
      .find((call) => call.expression.getText() === 'Controller');
    expect(squash(classDecorator?.arguments[0]?.getText())).toBe("{path:'approvals',version:'1'}");
    expect(decoratorOf(approvals, 'decide', 'Post')?.arguments[0]?.getText()).toBe(
      "':id/decision'",
    );
    expect(decoratorOf(approvals, 'get', 'Get')?.arguments[0]?.getText()).toBe("':id'");
  });

  it('publishing and the opening demand a platform user id; no handler names a role', () => {
    expect(decoratorOf(publication, 'publish', 'RequirePlatformUserId')).toBeDefined();
    for (const name of ['open', 'propose', 'withdrawProposal']) {
      expect(decoratorOf(opening, name, 'RequirePlatformUserId')).toBeDefined();
    }
    expect(decoratorOf(approvals, 'decide', 'RequirePlatformUserId')).toBeUndefined();
    for (const [tree, name] of [
      [publication, 'publish'],
      [opening, 'open'],
      [opening, 'propose'],
      [opening, 'withdrawProposal'],
      [opening, 'list'],
      [approvals, 'decide'],
    ] as const) {
      expect(decoratorOf(tree, name, 'Roles')).toBeUndefined();
    }
  });

  it('the gateway requires an Idempotency-Key under /v1/tenders, and routes /v1/approvals', () => {
    expect(gatewayRoutes).toContain(
      "{prefix:'tenders',service:'construction',requiresIdempotencyKey:true}",
    );
    expect(gatewayRoutes).toContain("{prefix:'approvals',service:'construction'}");
  });
});

describe('the bodies the portal sends', () => {
  it('a publication is the version read, and nothing else', () => {
    expect([...schemaProperties(publicationDto, 'publishTenderSchema').keys()]).toEqual([
      'expectedVersion',
    ]);
  });

  it('a decision is the step’s version, GRANT or REJECT, and a rejection states its reason', () => {
    const properties = schemaProperties(approvalDto, 'decisionSchema');
    expect([...properties.keys()]).toEqual([
      'expectedVersion',
      'decision',
      'decisionNumber',
      'conditions',
      'reason',
    ]);
    expect(literalsOf(properties.get('decision'))).toEqual(['GRANT', 'REJECT']);
    expect(squash(topLevelConst(approvalDto, 'statedReason').getText())).toBe(
      `z.string().trim().min(${REJECT_REASON_MIN}).max(${REJECT_REASON_MAX})`,
    );
    expect(squash(topLevelConst(approvalDto, 'decisionSchema').getText())).toContain(
      "if(value.decision==='REJECT'&&value.reason===undefined){",
    );
  });
});

describe('the views the portal reads', () => {
  it('a request has every field the portal keeps; a step too', () => {
    const service = [...schemaProperties(requestDto, 'tenderApprovalRequestViewSchema').keys()];
    expect(service).toEqual(expect.arrayContaining(Object.keys(APPROVAL_REQUEST_SCHEMA.shape)));
    const step = [...schemaProperties(requestDto, 'tenderApprovalStepViewSchema').keys()].sort();
    expect(Object.keys(APPROVAL_REQUEST_SCHEMA.shape.steps.element.shape).sort()).toEqual(step);
  });

  it('a step’s detail carries the version a decision is sent with', () => {
    const service = [...schemaProperties(approvalDto, 'approvalViewSchema').keys()];
    expect(service).toEqual(expect.arrayContaining(Object.keys(APPROVAL_SCHEMA.shape)));
  });

  it('the owner’s bids: a count and times before the opening, the opened bids after', () => {
    const service = [...schemaProperties(openingDto, 'tenderBidsViewSchema').keys()].sort();
    expect(Object.keys(OWNER_BIDS_SCHEMA.shape).sort()).toEqual(service);
    const bid = [...schemaProperties(openingDto, 'openedBidViewSchema').keys()];
    expect(bid).toEqual(
      expect.arrayContaining(Object.keys(OWNER_BIDS_SCHEMA.shape.bids.element.shape)),
    );
  });

  it('has words for every request status and every step status', () => {
    for (const status of literalsOf(
      topLevelConst(requestDto, 'TENDER_REQUEST_STATUSES').getText(),
    )) {
      expect(requestStatusLabel(status)).not.toBe(status);
    }
    for (const status of literalsOf(topLevelConst(approvalStates, 'APPROVAL_STATES').getText())) {
      expect(stepStatusLabel(status)).not.toBe(status);
    }
    expect(literalsOf(topLevelConst(approvalStates, 'TENDER_WORKFLOW_KEYS').getText())).toContain(
      PUBLICATION_WORKFLOW,
    );
  });
});

describe('who may publish — `assertCanWrite`', () => {
  it('the writers are SYSTEM_ADMIN and the project roles; AUDITOR never', () => {
    expect(access).toContain(`exportconstSUPER_ROLE='${PLATFORM_ADMINISTRATOR}';`);
    expect(access).toContain(`constOVERSIGHT_ROLE='${OVERSIGHT_ROLE}';`);
    expect(access).toContain('this.writers=[SUPER_ROLE,...env.CONSTRUCTION_PROJECT_ROLES];');
    const start = access.indexOf('privateassert(');
    const body = access.slice(start, access.indexOf('exportfunctionassertNotAuditor', start));
    const order = [
      'assertNotAuditor();',
      'if(!roles.some((role)=>context.roles.includes(role))){',
      'if(!context.organizationId){',
    ].map((check) => body.indexOf(check));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(publicationService).toContain(
      'asyncpublish(tenderId:string,dto:PublishTenderDto):Promise<Gated<TenderView>>{const{organizationId,actor}=this.access.assertCanWrite();',
    );
  });

  it('a draft becomes PUBLISHED, behind the approval gate — 202 with the request until approved', () => {
    expect(publicationService).toContain(
      "assertTenderTransition(tenderId,locked.status,'PUBLISHED');",
    );
    expect(squash(readSource(...SERVICE, 'tender', 'gated-response.ts'))).toContain(
      'if(gated.executed)returngated.result;response.status(202);returngated.request;',
    );
  });

  it('the project roles default as the portal’s do', () => {
    expect(constructionEnv).toContain(
      "CONSTRUCTION_PROJECT_ROLES:z.string().default('ORGANIZATION_ADMIN')",
    );
    expect(webEnv).toContain(
      "WEB_PROJECT_ROLES:roleList('WEB_PROJECT_ROLES','ORGANIZATION_ADMIN')",
    );
  });
});

describe('who may decide — `assertIsAuthority` and `TenderApprovalService.decide`', () => {
  it('the step’s organization and its exact role; AUDITOR never', () => {
    const start = access.indexOf('assertIsAuthority(approval:ApprovalAuthority):{actor:string}{');
    const body = access.slice(start, access.indexOf('assertCanSeeApproval(', start));
    expect(body).toContain('assertNotAuditor();');
    expect(body).toContain(
      'constisAuthority=context.organizationId===approval.authorityOrganizationId&&context.roles.includes(approval.authorityRole);',
    );
  });

  it('never the person who made the request; and the person as identity-service says now', () => {
    expect(tenderApprovals).toContain(
      "if(dto.decision==='GRANT'){assertDistinctActors(storedActor(request.requestedBy,request.requestedByIssuer,request.requestedBySubject),currentActor(),",
    );
    expect(tenderApprovals).toContain('constlive=awaitthis.identity.fetchMemberships(actor);');
    // `requestedBy` is the actor the guard recorded: `rasta_uid`, else the subject.
    expect(authGuard).toContain('constuserId=claims.rastaUserId??claims.sub;');
  });
});

describe('who may open — `assertCanOpenBids`', () => {
  it('none of the excluded roles whenever present, one of the opening roles, an organization', () => {
    expect(access).toContain(
      'constBID_EXCLUDED_ROLES:readonlystring[]=[SUPER_ROLE,CONTRACTOR_ROLE,OVERSIGHT_ROLE];',
    );
    expect([...BID_EXCLUDED_ROLES]).toEqual([
      PLATFORM_ADMINISTRATOR,
      CONTRACTOR_ROLE,
      OVERSIGHT_ROLE,
    ]);
    expect(access).toContain(
      'this.bidOpeners=(env.CONSTRUCTION_TENDER_OPEN_ROLES.length>0?env.CONSTRUCTION_TENDER_OPEN_ROLES:env.CONSTRUCTION_PROJECT_ROLES).filter((role)=>!BID_EXCLUDED_ROLES.includes(role));',
    );
    expect(access).toContain(
      "assertCanOpenBids():{organizationId:string;actor:string;organizationIds:readonlystring[];}{returnthis.assertOwnerBidSide(this.bidOpeners,'openitsbids');",
    );
    const start = access.indexOf('privateassertOwnerBidSide(');
    const body = access.slice(start, access.indexOf('privateassertLiveBidSide(', start));
    const order = [
      'assertNoBidExcludedRole(context.roles);',
      'if(!roles.some((role)=>context.roles.includes(role))){',
      'if(!context.organizationId){',
    ].map((check) => body.indexOf(check));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the opening roles default to none — the owner’s own — as the portal’s do', () => {
    expect(constructionEnv).toContain("CONSTRUCTION_TENDER_OPEN_ROLES:z.string().default('')");
    expect(webEnv).toContain(
      "WEB_TENDER_OPEN_ROLES:roleList('WEB_TENDER_OPEN_ROLES','',['SYSTEM_ADMIN','CONTRACTOR'])",
    );
  });

  it('only a CLOSED tender is proposed for opening; a proposal is idempotent, so is an opening', () => {
    const propose = method(openServiceTree, 'proposeOpening');
    expect(propose).toContain("if(found.status!=='CLOSED')throwthis.refused('NOT_CLOSED');");
    expect(propose).toContain('alreadyProposed:true');
    expect(squash(openService)).toContain('alreadyOpened');
    const withdraw = method(openServiceTree, 'withdrawProposal');
    expect(withdraw).toContain("throwthis.refused('NO_PROPOSAL');");
  });
});

describe('the refusals the portal says in its own words', () => {
  it('every closed reason of a publication', () => {
    const service = literalsOf(topLevelConst(publicationRules, 'PUBLICATION_REFUSALS').getText());
    expect(Object.keys(PUBLICATION_REFUSAL_TEXT).sort()).toEqual([...service].sort());
  });

  it('every closed reason of the approval gate', () => {
    const service = literalsOf(topLevelConst(approvalErrors, 'TENDER_APPROVAL_REFUSALS').getText());
    expect(Object.keys(APPROVAL_REFUSAL_TEXT).sort()).toEqual([...service].sort());
  });

  it('every closed reason of the opening — the two people among them', () => {
    const service = literalsOf(topLevelConst(openServiceTree, 'OPENING_REFUSALS').getText());
    expect(Object.keys(OPENING_REFUSAL_TEXT).sort()).toEqual([...service].sort());
    expect(OPENING_REFUSAL_TEXT.SECOND_PERSON_REQUIRED).toMatch(/^تفکیک وظایف/);
  });
});
