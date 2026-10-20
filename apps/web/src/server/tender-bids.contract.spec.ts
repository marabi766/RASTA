/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  BID_ANSWER_MAX,
  BID_ANSWERS_MAX,
  BID_NOTE_MAX,
  BID_REFUSAL_TEXT,
  BID_STATUSES,
  UNREPEATABLE_BID_COMMANDS,
} from '@/lib/bid-fields';
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
  BID_RECEIPT_SCHEMA,
  CONTRACTOR_ROLE,
  OVERSIGHT_ROLE,
  PLATFORM_ADMINISTRATOR,
} from './tender-bids';

/**
 * What the bid forms depend on, pinned to construction-service's source — the
 * technique of `contract-statements.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies (`server/tender-bids.ts`,
 * `lib/bid-fields.ts`, `lib/bid-input.ts`) and this test fails the moment a
 * copy and its original disagree. No bidder view carries the caller's
 * available actions, so "may this contractor use the form" is a copy of the
 * service's own checks — each pinned here. Eligibility at supplier-service and
 * the invitation are the service's alone, and pinned as such.
 */

const SERVICE = ['services', 'construction-service', 'src'] as const;
const controller = parseSource(readSource(...SERVICE, 'tender', 'bid.controller.ts'));
const dto = parseSource(readSource(...SERVICE, 'tender', 'bid.dto.ts'));
const bidServiceSource = readSource(...SERVICE, 'tender', 'bid.service.ts');
const bidService = squash(bidServiceSource)!;
const bidServiceTree = parseSource(bidServiceSource);
const clock = squash(readSource(...SERVICE, 'tender', 'tender-clock.ts'))!;
const access = squash(readSource(...SERVICE, 'access', 'access.ts'))!;
const constructionEnv = squash(readSource(...SERVICE, 'config', 'env.ts'))!;
const repository = squash(readSource(...SERVICE, 'tender', 'bid.repository.ts'))!;
const schema = readSource('services', 'construction-service', 'prisma', 'schema.prisma');
const gatewayRoutes = squash(readSource('services', 'api-gateway', 'src', 'config', 'routes.ts'))!;
const authGuard = squash(readSource('packages', 'nest-common', 'src', 'guards', 'auth.guard.ts'))!;

/** The body of one method of `BidService`, squashed. */
function method(name: string): string {
  const found = collect(bidServiceTree, ts.isMethodDeclaration).find(
    (node) => node.name.getText() === name,
  );
  if (!found) throw new Error(`no method ${name}`);
  return squash(found.getText())!;
}

describe('the routes', () => {
  it('submit at the tender’s bids, read one’s own, replace and withdraw by the bid', () => {
    expect(decoratorOf(controller, 'submit', 'Post')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/bids'",
    );
    expect(decoratorOf(controller, 'mine', 'Get')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/bids/mine'",
    );
    expect(decoratorOf(controller, 'revise', 'Put')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/bids/:bidId'",
    );
    expect(decoratorOf(controller, 'withdraw', 'Post')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/bids/:bidId/withdraw'",
    );
    expect(squash(decoratorOf(controller, 'getOpenTender', 'Get')?.arguments[0]?.getText())).toBe(
      "'open-tenders/:id'",
    );
  });

  it('name no role on any handler — every one goes through assertCanBid', () => {
    for (const name of ['submit', 'mine', 'revise', 'withdraw', 'getOpenTender']) {
      expect(decoratorOf(controller, name, 'Roles')).toBeUndefined();
    }
    expect(method('submit')).toContain('this.access.assertCanBid()');
    expect(method('revise')).toContain('this.access.assertCanBid()');
    expect(method('withdraw')).toContain('this.access.assertCanBid()');
    expect(method('getMine')).toContain('this.access.assertCanBid()');
  });

  it('a submission requires the Idempotency-Key; the gateway requires one on every unsafe tender call', () => {
    expect(squash(handlerOf(controller, 'submit').getText())).toContain(
      "@Headers('idempotency-key')idempotencyKey?:string",
    );
    expect(method('submit')).toContain('requiredIdempotencyKey(idempotencyKey)');
    expect(squash(handlerOf(controller, 'revise').getText())).not.toContain('idempotency');
    expect(squash(handlerOf(controller, 'withdraw').getText())).not.toContain('idempotency');
    expect(gatewayRoutes).toContain(
      "{prefix:'tenders',service:'construction',requiresIdempotencyKey:true}",
    );
    expect(gatewayRoutes).toContain("{prefix:'open-tenders',service:'construction'}");
  });
});

describe('who may bid — `assertCanBid`', () => {
  it('names the roles the portal checks', () => {
    expect(access).toContain(`exportconstSUPER_ROLE='${PLATFORM_ADMINISTRATOR}';`);
    expect(access).toContain(`exportconstCONTRACTOR_ROLE='${CONTRACTOR_ROLE}';`);
    expect(access).toContain(`constOVERSIGHT_ROLE='${OVERSIGHT_ROLE}';`);
    expect(access).toContain(
      'constBIDDER_EXCLUDED_ROLES:readonlystring[]=[SUPER_ROLE,OVERSIGHT_ROLE];',
    );
  });

  it('refuses the excluded roles whenever present, then needs CONTRACTOR, an organization and an actor', () => {
    const start = access.indexOf('assertCanBid():{organizationId:string;actor:string}{');
    const body = access.slice(start, access.indexOf('assertCanOpenBids()', start));
    const order = [
      'assertNotServiceCaller();',
      'assertNoBidderExcludedRole(context.roles);',
      'if(!context.roles.includes(CONTRACTOR_ROLE)){',
      'if(!context.organizationId){',
      'if(!context.userId){',
    ].map((check) => body.indexOf(check));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('an actor is every signed-in person: the guard falls back to the token’s subject', () => {
    expect(authGuard).toContain('constuserId=claims.rastaUserId??claims.sub;');
    for (const name of ['submit', 'mine', 'revise', 'withdraw']) {
      expect(decoratorOf(controller, name, 'RequirePlatformUserId')).toBeUndefined();
    }
  });
});

describe('what the service judges, in its order — `decide`', () => {
  const decide = method('decide');

  it('a tender it may not see is a missing one; its own tender is OWN_TENDER', () => {
    expect(decide).toContain(
      "if(!tender||tender.status==='DRAFT')throwRastaError.notFound('Tender',tenderId);",
    );
    expect(decide).toContain(
      "if(tender.organizationId===bidder){throwthis.refused(tenderId,['OWN_TENDER']);}",
    );
    expect(decide).toContain(
      "tender.visibility!=='PUBLIC'&&!(awaitthis.bids.isInvited(tx,tender.organizationId,tenderId,bidder))",
    );
  });

  it('the bidder’s door shows only a published tender of another organization, public or invited', () => {
    const start = repository.indexOf('findOpenTender(tenderId:string,bidderOrganizationId:string)');
    const body = repository.slice(start, repository.indexOf('listCriteriaOf(', start));
    expect(body).toContain("status:'PUBLISHED',organizationId:{not:bidderOrganizationId},");
    expect(body).toContain(
      "OR:[{visibility:'PUBLIC'},{invitations:{some:{invitedOrganizationId:bidderOrganizationId}}},]",
    );
  });

  it('the window is [bidOpeningAt, bidClosingAt) on the decision instant', () => {
    expect(decide).toContain("refusals.push('BID_WINDOW_NOT_OPEN');");
    expect(decide).toContain('elseif(at.getTime()<tender.bidOpeningAt.getTime()){');
    expect(decide).toContain('elseif(!insideWindow(at,tender.bidOpeningAt,tender.bidClosingAt)){');
    expect(clock).toContain(
      'returnopening.getTime()<=at.getTime()&&at.getTime()<closing.getTime();',
    );
  });

  it('a replacement and a withdrawal need the revision shown and a SUBMITTED bid', () => {
    expect(method('assertRevision')).toContain(
      "if(locked.revision!==expected)throwthis.conflict(locked.id);if(locked.status!=='SUBMITTED')throwthis.refused(locked.id,['BID_NOT_SUBMITTED']);",
    );
    expect(method('revise')).toContain('this.assertRevision(locked,dto.expectedRevision);');
    expect(method('withdraw')).toContain('this.assertRevision(locked,dto.expectedRevision);');
  });

  it('one bid per organization: a second submission is ALREADY_EXISTS', () => {
    expect(method('submitOnce')).toContain(
      "if(awaitthis.bids.findBidOf(tx,tenderId,bidder)){throwRastaError.alreadyExists('Bid',tenderId);}",
    );
  });

  it('qualification is asked of supplier-service at the moment — never the portal’s to judge', () => {
    expect(method('assertEligible')).toContain(
      "if(verdict!=='ELIGIBLE')throwthis.refused(tenderId,['BIDDER_NOT_ELIGIBLE']);",
    );
    expect(method('submitOnce')).toContain('awaitthis.assertEligible(tenderId,bidder);');
    expect(method('revise')).toContain('awaitthis.assertEligible(tenderId,bidder);');
    // A withdrawal does not ask again: a contractor suspended since may still take its bid back.
    expect(method('withdraw')).not.toContain('assertEligible');
  });
});

describe('the bodies the portal sends', () => {
  it('a submission is the content; a replacement the revision and the content; a withdrawal the revision', () => {
    expect([...schemaProperties(dto, 'submitBidSchema').keys()]).toEqual(['content']);
    expect([...schemaProperties(dto, 'reviseBidSchema').keys()]).toEqual([
      'expectedRevision',
      'content',
    ]);
    expect([...schemaProperties(dto, 'withdrawBidSchema').keys()]).toEqual(['expectedRevision']);
  });

  it('the content is a price as a decimal string, answers by criterion code and an optional note', () => {
    const content = schemaProperties(dto, 'bidContentSchema');
    expect([...content.keys()]).toEqual(['priceMinor', 'answers', 'note']);
    const price = squash(content.get('priceMinor'))!;
    expect(price).toContain('.regex(/^(0|[1-9]\\d{0,18})$/,');
    expect(price).toContain('BigInt(value)<=9_223_372_036_854_775_807n');
    const answers = squash(content.get('answers'))!;
    expect(answers).toContain('criterionCode:z.string().trim().min(1).max(64)');
    expect(answers).toContain('response:z.string().trim().min(1).max(MAX_ANSWER_LENGTH)');
    expect(answers).toContain('.max(MAX_ANSWERS)');
    expect(squash(content.get('note'))).toBe(
      'z.string().trim().min(1).max(MAX_NOTE_LENGTH).optional()',
    );
  });

  it('bounds the form as the DTO does', () => {
    expect(topLevelConst(dto, 'MAX_ANSWER_LENGTH').getText()).toBe(String(BID_ANSWER_MAX));
    expect(topLevelConst(dto, 'MAX_NOTE_LENGTH').getText()).toBe(String(BID_NOTE_MAX));
    expect(topLevelConst(dto, 'MAX_ANSWERS').getText()).toBe(String(BID_ANSWERS_MAX));
  });
});

describe('the receipt the portal reads', () => {
  it('has exactly the fields the portal keeps, and no content', () => {
    const service = [...schemaProperties(dto, 'bidReceiptViewSchema').keys()].sort();
    expect(Object.keys(BID_RECEIPT_SCHEMA.shape).sort()).toEqual(service);
    expect(service).not.toContain('content');
  });

  it('knows every bid status', () => {
    const block = /enum BidStatus \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    expect(block.split(/\s+/).filter(Boolean)).toEqual([...BID_STATUSES]);
  });
});

describe('the refusals the portal says in its own words', () => {
  it('has fixed words for every closed reason of a bid — and no other', () => {
    const service = literalsOf(topLevelConst(bidServiceTree, 'BID_REFUSALS').getText()).sort();
    expect(Object.keys(BID_REFUSAL_TEXT).sort()).toEqual(service);
  });

  it('the deadline and the qualification are among them', () => {
    for (const reason of ['BID_WINDOW_NOT_OPEN', 'BID_WINDOW_CLOSED', 'BIDDER_NOT_ELIGIBLE']) {
      expect(BID_REFUSAL_TEXT[reason]).toBeDefined();
    }
    expect(bidService).toContain("ruleRefusal(`Bidrefused:${refusals.join(',')}`,'bid',refusals,");
  });
});

describe('which bid commands may be sent again after a lost answer (PR 345 reviews 1 and 2)', () => {
  it('a submission keeps its result under its required key; a replacement and a withdrawal keep none', () => {
    const submit = method('submit');
    expect(submit).toContain('constkey=requiredIdempotencyKey(idempotencyKey);');
    expect(submit).toContain('returnthis.idempotency.run(SUBMIT_BID_ENDPOINT,key,');
    for (const name of ['revise', 'withdraw']) {
      expect(method(name)).not.toContain('idempotency');
    }
    expect([...UNREPEATABLE_BID_COMMANDS]).toEqual(['REVISE', 'WITHDRAW']);
  });
});

describe('the replay window', () => {
  it('mirrors construction-service’s idempotency retention bounds', () => {
    expect(constructionEnv).toContain(
      'CONSTRUCTION_IDEMPOTENCY_TTL_HOURS:z.coerce.number().int().min(1).max(168).default(24)',
    );
    expect(squash(readSource('apps', 'web', 'src', 'server', 'env.ts'))).toContain(
      'WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS:z.coerce.number().int().min(1).max(168).default(1)',
    );
  });
});
