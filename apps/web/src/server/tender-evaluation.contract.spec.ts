/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  AWARD_REFUSAL_TEXT,
  DISQUALIFICATION_REASONS,
  DISQUALIFY_TEXT_MAX,
  EVALUATION_REFUSAL_TEXT,
  JUSTIFICATION_MAX,
  READINESS_BLOCKED_TEXT,
  SCORE_SCALE,
} from '@/lib/tender-evaluation-fields';
import {
  APPROVAL_REFUSAL_TEXT,
  REPEATABLE_OWNER_COMMANDS,
  UNREPEATABLE_OWNER_COMMANDS,
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

import { AUTHORITY_STEP_SCHEMA, INBOX_PAGE_SIZE } from './tender-authority';
import { AWARD_APPROVAL_SCHEMA, MATRIX_SCHEMA } from './tender-evaluation';
import { AWARD_SCHEMA, AWARD_WORKFLOW } from './tender-owner';

/**
 * What the evaluation's and the award's forms depend on, pinned to
 * construction-service's source — the technique of
 * `tender-owner.contract.spec.ts`. No view carries the caller's available
 * actions, so "may this person use the form" is a copy of the service's checks,
 * each pinned here; every closed reason has the page's fixed words; and which
 * command may be sent again after a lost answer follows from what the service
 * keeps, pinned here too.
 */

const SERVICE = ['services', 'construction-service', 'src'] as const;
const TENDER = [...SERVICE, 'tender'] as const;
const evaluationController = parseSource(readSource(...TENDER, 'evaluation.controller.ts'));
const awardController = parseSource(readSource(...TENDER, 'award.controller.ts'));
const evaluationDto = parseSource(readSource(...TENDER, 'evaluation.dto.ts'));
const awardDto = parseSource(readSource(...TENDER, 'award.dto.ts'));
const approvalDto = parseSource(readSource(...SERVICE, 'approval', 'dto.ts'));
const evaluationServiceText = readSource(...TENDER, 'evaluation.service.ts');
const evaluationServiceTree = parseSource(evaluationServiceText);
const awardServiceText = readSource(...TENDER, 'award.service.ts');
const awardServiceTree = parseSource(awardServiceText);
const evaluationRepository = squash(readSource(...TENDER, 'evaluation.repository.ts'))!;
const awardRepository = squash(readSource(...TENDER, 'award.repository.ts'))!;
const matrix = squash(readSource(...TENDER, 'evaluation-matrix.ts'))!;
const approvalGate = squash(readSource(...TENDER, 'tender-approval.gate.ts'))!;
const tenderApprovals = squash(readSource(...TENDER, 'tender-approval.service.ts'))!;
const access = squash(readSource(...SERVICE, 'access', 'access.ts'))!;
const constructionEnv = squash(readSource(...SERVICE, 'config', 'env.ts'))!;
const constructionEnvTree = parseSource(readSource(...SERVICE, 'config', 'env.ts'));
const webEnv = squash(readSource('apps', 'web', 'src', 'server', 'env.ts'))!;
const approvalController = parseSource(
  readSource(...SERVICE, 'approval', 'approval.controller.ts'),
);
const approvalService = parseSource(readSource(...SERVICE, 'approval', 'approval.service.ts'));
const pagination = parseSource(
  readSource('packages', 'contracts', 'src', 'common', 'pagination.ts'),
);

function method(tree: ts.SourceFile, name: string): string {
  const found = collect(tree, ts.isMethodDeclaration).find((node) => node.name.getText() === name);
  if (!found) throw new Error(`no method ${name}`);
  return squash(found.getText())!;
}

/** The keys of a zod object schema in the portal. */
const keysOf = (schema: { shape: Record<string, unknown> }): string[] => Object.keys(schema.shape);

describe('the routes', () => {
  it('the evaluators’ commands and the matrix are where the portal sends them', () => {
    const route = (name: string, verb: string) =>
      decoratorOf(evaluationController, name, verb)?.arguments[0]?.getText();
    expect(route('qualify', 'Post')).toBe("'tenders/:id/bids/:bidId/qualification'");
    expect(route('score', 'Post')).toBe("'tenders/:id/bids/:bidId/scores'");
    expect(route('evaluate', 'Post')).toBe("'tenders/:id/evaluate'");
    expect(route('matrix', 'Get')).toBe("'tenders/:id/evaluation'");
    expect(decoratorOf(awardController, 'award', 'Post')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/award'",
    );
    expect(decoratorOf(awardController, 'read', 'Get')?.arguments[0]?.getText()).toBe(
      "'tenders/:id/award'",
    );
    expect(AWARD_WORKFLOW).toBe('tender.award');
  });

  it('every command demands a platform user id; no handler names a role — the service decides', () => {
    for (const name of ['qualify', 'score', 'evaluate']) {
      expect(decoratorOf(evaluationController, name, 'RequirePlatformUserId')).toBeDefined();
      expect(decoratorOf(evaluationController, name, 'Roles')).toBeUndefined();
    }
    expect(decoratorOf(awardController, 'award', 'RequirePlatformUserId')).toBeDefined();
    expect(decoratorOf(awardController, 'award', 'Roles')).toBeUndefined();
  });
});

describe('who may evaluate and award — `canEvaluate`, `canAward`, `mayDecideAward`', () => {
  it('the configured roles, else the owner’s, less the bid side’s exclusions', () => {
    expect(access).toContain(
      'this.evaluators=(env.CONSTRUCTION_TENDER_EVALUATE_ROLES.length>0?env.CONSTRUCTION_TENDER_EVALUATE_ROLES:env.CONSTRUCTION_PROJECT_ROLES).filter((role)=>!BID_EXCLUDED_ROLES.includes(role));',
    );
    expect(access).toContain(
      'this.awarders=(env.CONSTRUCTION_TENDER_AWARD_ROLES.length>0?env.CONSTRUCTION_TENDER_AWARD_ROLES:env.CONSTRUCTION_PROJECT_ROLES).filter((role)=>!BID_EXCLUDED_ROLES.includes(role));',
    );
    expect(access).toContain(
      "assertCanEvaluate():{organizationId:string;actor:string;organizationIds:readonlystring[];}{returnthis.assertOwnerBidSide(this.evaluators,'evaluateitsbids');}",
    );
    expect(access).toContain(
      "assertCanAward():{organizationId:string;actor:string;organizationIds:readonlystring[];}{returnthis.assertOwnerBidSide(this.awarders,'awarditsevaluatedtender');}",
    );
    // Refused whenever present, the token's roles and the live ones alike.
    expect(access).toContain(
      'assertNoBidExcludedRole(context.roles);if(!roles.some((role)=>context.roles.includes(role)))',
    );
  });

  it('the award’s approver holds none of the bid side’s excluded roles, on the token and as of now', () => {
    expect(access).toContain(
      'assertMayDecideAward():void{assertNotServiceCaller();assertNoBidExcludedRole(getContext().roles);}',
    );
    expect(tenderApprovals).toContain(
      "if(workflowKey==='tender.award'){this.access.assertMayDecideAward();this.access.assertLiveRolesMayDecideAward(mine.roles);",
    );
    // Reading the award step is held to the same rules: its refusal is the decision's refusal.
    expect(tenderApprovals).toContain(
      'this.access.assertMayDecideAward();this.access.assertLiveRolesMayDecideAward(mine.roles);awaitthis.assertApproverNotConflicted(',
    );
  });

  it('the portal’s role settings and conflict rules mirror the service’s, with the same defaults and refusals', () => {
    for (const name of ['EVALUATE', 'AWARD']) {
      expect(constructionEnv).toContain(`CONSTRUCTION_TENDER_${name}_ROLES:z`);
      expect(webEnv).toContain(`WEB_TENDER_${name}_ROLES:roleList('WEB_TENDER_${name}_ROLES','',[`);
    }
    expect(webEnv).toContain(
      "WEB_TENDER_EVALUATE_ROLES:roleList('WEB_TENDER_EVALUATE_ROLES','',['SYSTEM_ADMIN','CONTRACTOR',]),",
    );
    expect(webEnv).toContain(
      "WEB_TENDER_AWARD_ROLES:roleList('WEB_TENDER_AWARD_ROLES','',['SYSTEM_ADMIN','CONTRACTOR']),",
    );
    expect(constructionEnv).toContain(
      "CONSTRUCTION_COI_RULES:z.string().default('AWARDER_NOT_EVALUATOR')",
    );
    expect(webEnv).toContain("WEB_TENDER_COI_RULES:z.string().default('AWARDER_NOT_EVALUATOR')");
    const rules = literalsOf(topLevelConst(constructionEnvTree, 'COI_RULES').getText());
    expect(webEnv).toContain(`z.enum([${rules.map((rule) => `'${rule}'`).join(',')}])`);
  });
});

describe('what an evaluator is offered — `evaluationOffers`', () => {
  const qualify = method(evaluationServiceTree, 'qualify');
  const scoreOnce = method(evaluationServiceTree, 'scoreOnce');
  const onePerson = method(evaluationServiceTree, 'assertOnePerson');

  it('the matrix read makes every check a command makes before its own rules', () => {
    const getMatrix = method(evaluationServiceTree, 'getMatrix');
    for (const check of [
      "this.authorize(tenderId,'READ_EVALUATION')",
      "this.identity.live(caller,'EVALUATE_BIDS')",
      'this.assertNotConflicted(principal,tenderId)',
      'this.assertEvaluatorMayAct(principal,tender,bids)',
    ]) {
      expect(getMatrix).toContain(check);
    }
    expect(method(evaluationServiceTree, 'enter')).toContain(
      "this.assertEvaluatorMayAct(principal,tender,bids);if(tender.status!=='EVALUATING')throwthis.rule('NOT_EVALUATING');",
    );
    expect(method(evaluationServiceTree, 'assertEvaluatorMayAct')).toContain(
      "if(this.env.CONSTRUCTION_COI_RULES.includes('EVALUATOR_NOT_TENDER_AUTHOR')){this.assertNotTenderAuthor(tender);}",
    );
  });

  it('a decision on an opened bid nobody decided; never by one who stood down from it', () => {
    expect(qualify).toContain("if(bid.status!=='OPENED')throwthis.rule('BID_NOT_OPENED');");
    expect(qualify).toContain("awaitthis.assertOnePerson(tx,tenderId,bidId,'DECIDE');");
    expect(onePerson).toContain(
      "conststoodDown=compare(recusals);if(stoodDown.includes('SAME')){throwthis.forbid('RECUSED',",
    );
  });

  it('a score on a qualified bid, within the evaluator limit counting no one who stood down', () => {
    expect(scoreOnce).toContain("if(bid.status!=='QUALIFIED')throwthis.rule('BID_NOT_QUALIFIED');");
    expect(scoreOnce).toContain(
      "if(!evaluation){constactive=awaitthis.repo.countActiveEvaluators(tx,tenderId,bidId);if(active>=this.env.CONSTRUCTION_EVALUATION_MAX_EVALUATORS){throwthis.rule('EVALUATOR_LIMIT');}",
    );
    expect(evaluationRepository).toContain(
      'returnclaims.filter((claim)=>!recused.has(claim.evaluatorId)).length;',
    );
    // Each cell compared-and-set at the revision its sender read, 0 for a new one.
    expect(scoreOnce).toContain(
      "if((latest.get(criterionCode)?.revision??0)!==expectedRevision){versionConflictsTotal.inc({service:SERVICE_NAME,aggregate:'BidScore'});",
    );
    expect(scoreOnce).toContain(
      "consttop=criterion.maxScore*100;if(scoreScaled<0||scoreScaled>top||(criterion.scoringMethod==='PASS_FAIL'&&scoreScaled!==0&&scoreScaled!==top))",
    );
  });

  it('completing when the matrix says it may: `ready` is what `evaluate` would answer', () => {
    expect(matrix).toContain(
      'ready:qualifiedBids.length>0&&blockers.length===0&&undecidedBidCount===0,',
    );
    expect(method(evaluationServiceTree, 'getMatrix')).toContain(
      'ready:counted.ready&&blockedBy===null,readinessBlockedBy:blockedBy,',
    );
    const evaluate = method(evaluationServiceTree, 'evaluate');
    expect(evaluate).toContain("if(!matrix.ready){throwthis.rule('EVALUATION_INCOMPLETE',");
    expect(evaluate).toContain('awaitthis.assertDistinctEvaluators(tx,tenderId,matrix);');
  });

  it('the matrix the page reads is the service’s, field for field', () => {
    const view = schemaProperties(evaluationDto, 'matrixViewSchema');
    for (const key of keysOf(MATRIX_SCHEMA)) expect(view.has(key)).toBe(true);
    const bidKeys = keysOf(MATRIX_SCHEMA.shape.bids.element);
    const bidView = squash(view.get('bids'))!;
    for (const key of bidKeys) expect(bidView).toContain(`${key}:`);
    expect(squash(readSource(...TENDER, 'evaluation.dto.ts'))).toContain(
      "readinessBlockedBy:z.enum(['SAME_PERSON_AS_EVALUATOR','ACTOR_IDENTITY_UNKNOWN']).nullable()",
    );
    for (const code of ['SAME_PERSON_AS_EVALUATOR', 'ACTOR_IDENTITY_UNKNOWN']) {
      expect(READINESS_BLOCKED_TEXT[code]).toBeDefined();
    }
  });

  it('a score is the points × 100; a disqualification a closed reason and up to 2000 characters', () => {
    expect(topLevelConst(evaluationDto, 'SCORE_SCALE').getText()).toBe(String(SCORE_SCALE));
    expect(literalsOf(topLevelConst(evaluationDto, 'DISQUALIFICATION_REASONS').getText())).toEqual(
      DISQUALIFICATION_REASONS,
    );
    const qualifyBid = squash(topLevelConst(evaluationDto, 'qualifyBidSchema').getText())!;
    expect(qualifyBid).toContain(`reasonText:z.string().trim().min(1).max(${DISQUALIFY_TEXT_MAX})`);
    const scoreBid = squash(topLevelConst(evaluationDto, 'scoreBidSchema').getText())!;
    expect(scoreBid).toContain('expectedRevision:z.number().int().min(0)');
    expect(scoreBid).toContain('scoreScaled:z.number().int().min(0)');
  });
});

describe('what an awarder is offered — `awardOffers`', () => {
  const judge = method(awardServiceTree, 'judge');

  it('an evaluated tender, a qualified bid the matrix ranks, a justification for anything but the single first rank', () => {
    expect(judge).toContain(
      "if(tender.status!=='EVALUATED'||tender.evaluatedAt===null){throwthis.rule('NOT_EVALUATED');}",
    );
    expect(judge).toContain("if(bid.status!=='QUALIFIED')throwthis.rule('BID_NOT_QUALIFIED');");
    expect(judge).toContain("if(!ranked||ranked.rank===null)throwthis.rule('BID_NOT_QUALIFIED');");
    expect(judge).toContain(
      "if((ranked.rank!==1||ranked.tied)&&justification===null){throwthis.rule('JUSTIFICATION_REQUIRED',",
    );
    expect(topLevelConst(awardDto, 'MAX_JUSTIFICATION_LENGTH').getText()).toBe(
      String(JUSTIFICATION_MAX),
    );
  });

  it('AWARDER_NOT_EVALUATOR: whoever decided, scored or stood down, and whoever completed it', () => {
    expect(judge).toContain(
      "if(this.env.CONSTRUCTION_COI_RULES.includes('AWARDER_NOT_EVALUATOR')){awaitthis.assertAwarderIsNotEvaluator(tx,tender);}",
    );
    const participants = method(awardServiceTree, 'assertAwarderIsNotEvaluator');
    expect(participants).toContain(
      'constparticipants=awaitthis.awards.listParticipants(tx,tender.id);if(tender.evaluatedBy){participants.push(',
    );
    for (const table of ['bidQualification', 'bidEvaluation', 'bidEvaluationRecusal']) {
      expect(awardRepository).toContain(`tx.${table}.findMany({where:{tenderId},`);
    }
    // Completing names its person on the tender too — `statusChangedBy` of an EVALUATED tender.
    expect(evaluationRepository).toContain(
      "where:{id:input.tenderId,status:'EVALUATING',version:input.expectedVersion},data:{status:'EVALUATED',evaluatedAt:input.at,evaluatedBy:input.actor,",
    );
    expect(evaluationRepository).toContain('statusChangedBy:input.actor,');
  });

  it('a pending request of another choice is ended and asked anew; an approved one is executed only as approved', () => {
    expect(approvalGate).toContain(
      "case'tender.award':return(request.bidId===binding.bidId&&request.bidderOrganizationId===binding.bidderOrganizationId&&request.rank===binding.rank&&request.tied===binding.tied&&request.justification===binding.justification&&request.matrixDigest===binding.matrixDigest);",
    );
    expect(approvalGate).toContain(
      "awaitthis.decisions.endStale(tx,live,tender,caller.userId,caller.organizationId,at);if(approved)return{kind:'STALE',request:live};",
    );
  });

  it('the award, the award step and the bid it names are the service’s, field for field', () => {
    const award = schemaProperties(awardDto, 'tenderAwardViewSchema');
    for (const key of keysOf(AWARD_SCHEMA)) expect(award.has(key)).toBe(true);
    expect(squash(award.get('amountMinor'))).toContain('z.string()');
    const approval = schemaProperties(approvalDto, 'approvalViewSchema');
    for (const key of keysOf(AWARD_APPROVAL_SCHEMA)) expect(approval.has(key)).toBe(true);
    const binding = squash(topLevelConst(approvalDto, 'approvalBindingSchema').getText())!;
    const bid = AWARD_APPROVAL_SCHEMA.shape.request.unwrap().shape.bid.unwrap();
    for (const key of keysOf(bid)) expect(binding).toContain(`${key}:`);
  });
});

describe('an award without the evaluators’ read (PR 346 review 1, finding 2)', () => {
  it('awarding is decided by the award roles alone — no evaluation role is asked of the awarder', () => {
    expect(method(awardServiceTree, 'authorize')).toContain('returnthis.access.assertCanAward();');
    expect(awardServiceText).not.toContain('assertCanEvaluate');
    // The bid is named by the caller and judged by the service, ranked or not.
    expect(method(awardServiceTree, 'judge')).toContain(
      'constbid=bids.find((candidate)=>candidate.id===dto.bidId);',
    );
  });
});

describe('an authority of another organization (PR 346 review 1, finding 3)', () => {
  it('finds its steps in its inbox and reads each on its own, never the tender', () => {
    expect(decoratorOf(approvalController, 'inbox', 'Get')?.arguments).toHaveLength(0);
    expect(decoratorOf(approvalController, 'get', 'Get')?.arguments[0]?.getText()).toBe("':id'");
    expect(method(approvalService, 'inbox')).toContain(
      'constscope=this.access.inboxScope();constrows=awaitthis.approvals.inbox({authorityOrganizationId:scope.organizationId,roles:scope.roles,status:query.status,',
    );
    expect(access).toContain(
      'inboxScope():{organizationId:string;roles:readonlystring[]}{assertNotAuditor();',
    );
    expect(squash(topLevelConst(approvalDto, 'inboxQuerySchema').getText())).toContain(
      "status:z.enum(APPROVAL_STATES).default('PENDING')",
    );
    expect(method(approvalService, 'get')).toContain(
      "this.access.assertCanSeeApproval(approval);//Whatanawardapprovalisaboutnamesabid:notshowntooneinconflictwiththetender.if(approval.workflowKey==='tender.award'){awaitthis.tenderApprovals.assertMayReadAward(approval);}",
    );
    expect(topLevelConst(pagination, 'MAX_PAGE_SIZE').getText()).toBe(String(INBOX_PAGE_SIZE));
    const view = schemaProperties(approvalDto, 'approvalViewSchema');
    for (const key of keysOf(AUTHORITY_STEP_SCHEMA)) expect(view.has(key)).toBe(true);
  });
});

describe('every closed reason has fixed words', () => {
  it('the evaluation’s and the award’s', () => {
    const evaluation = literalsOf(
      topLevelConst(evaluationServiceTree, 'EVALUATION_REFUSALS').getText(),
    );
    expect(Object.keys(EVALUATION_REFUSAL_TEXT).sort()).toEqual([...evaluation].sort());
    const award = literalsOf(topLevelConst(awardServiceTree, 'AWARD_REFUSALS').getText());
    expect(Object.keys(AWARD_REFUSAL_TEXT).sort()).toEqual([...award].sort());
    // The gate's own: a stale approval, the award approver's conflicts.
    for (const code of ['APPROVAL_STALE', 'APPROVER_IS_EVALUATOR', 'CONFLICT_OF_INTEREST']) {
      expect(APPROVAL_REFUSAL_TEXT[code]).toBeDefined();
    }
  });
});

describe('which commands may be sent again after a lost answer', () => {
  it('a score is kept under its Idempotency-Key — the only one of these', () => {
    expect(decoratorOf(evaluationController, 'score', 'Post')).toBeDefined();
    expect(squash(evaluationController.getText())).toContain(
      "@Body(zodPipe(scoreBidSchema))dto:ScoreBidDto,@Headers('idempotency-key')idempotencyKey?:string,",
    );
    expect(method(evaluationServiceTree, 'score')).toContain(
      'returnthis.idempotency.run(SCORE_BID_ENDPOINT,idempotencyKey,',
    );
    for (const name of ['qualify', 'evaluate']) {
      expect(method(evaluationServiceTree, name)).not.toContain('idempotency');
    }
    expect(squash(awardController.getText())).not.toContain("@Headers('idempotency-key')");
    expect(awardServiceText).not.toContain('IdempotencyStore');
    expect(awardServiceText).not.toContain('idempotency.run(');
  });

  it('a decision on a bid, the completion and an award keep no result for a re-send: only a score may be sent again', () => {
    // A decision on a bid answers its own repeat, but that answer cannot tell the first send from
    // another evaluator's; a completion freezes the matrix as it stands when the re-send arrives.
    expect(method(evaluationServiceTree, 'qualify')).toContain(
      "if(existing.decision!==dto.decision)throwthis.rule('BID_ALREADY_DECIDED');",
    );
    expect(method(evaluationServiceTree, 'evaluate')).toContain(
      'constmatched=awaitthis.repo.completeEvaluation(tx,{tenderId,expectedVersion:tender.version,',
    );
    // A lost award request, rejected meanwhile, is not found again: the same award opens a new round.
    expect(approvalGate).toContain(
      "return{kind:'REQUESTED',request:awaitthis.open(tx,input),created:true,",
    );
    expect([...REPEATABLE_OWNER_COMMANDS]).toEqual(['SCORE']);
    for (const command of [
      'QUALIFY',
      'DISQUALIFY',
      'EVALUATE',
      'AWARD',
      'GRANT_AWARD',
      'REJECT_AWARD',
    ]) {
      expect(UNREPEATABLE_OWNER_COMMANDS).toContain(command);
    }
  });
});
