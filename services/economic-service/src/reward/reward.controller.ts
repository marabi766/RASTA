import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { RewardService } from './reward.service';
import { ParticipationService } from './participation.service';
import { toParticipationRuleApiView, toParticipationView } from './participation-views';
import { RecognitionService } from './recognition.service';
import { toRecognitionRuleApiView, toRecognitionView } from './recognition-views';
import { assertNotAuditor } from '../access/access';
import { IdempotencyStore } from '../shared/idempotency';
import { canonicalPipe } from '../shared/canonical';
import { requireIdempotencyKey } from '../wallet/wallet.controller';
import {
  toRewardBalanceView,
  toRewardRuleView,
  toRewardView,
  type RewardBalanceRow,
  type RewardRow,
} from '../shared/views';
import {
  createParticipationRuleSchema,
  createRecognitionRuleSchema,
  createRewardRuleSchema,
  listRewardRulesQuerySchema,
  myParticipationQuerySchema,
  myRecognitionQuerySchema,
  myRewardsQuerySchema,
  updateRewardRuleSchema,
  type CreateParticipationRuleDto,
  type CreateRecognitionRuleDto,
  type CreateRewardRuleDto,
  type MyParticipationQuery,
  type MyRecognitionQuery,
  type ListRewardRulesQuery,
  type MyRewardsQuery,
  type UpdateRewardRuleDto,
} from './dto';

/**
 * The reward API (docs/06 § 6.10, docs/10 § 10.8).
 *
 * ## Points and money are separate, and the API says which is which
 *
 * A reward always carries points. It carries rial **only** when its rule has a
 * configured `creditPerPointMinor`, which nothing in this repository sets:
 * docs/24 Q-09 — what share of commission funds rewards — is open, and a
 * default would be an invented commercial term (ADR-033). So `monetised` is on
 * every reward, and a `creditAmountMinor` of "0" with `monetised: false` means
 * "points only", not "worth nothing".
 *
 * ## No gamification
 *
 * The product document constrains the presentation: "از الگوهای کودکانه یا
 * سرگرمی‌محور پرهیز کند" (docs/10 § 10.8). This API returns a point total and a
 * level name. It exposes no streaks and no celebratory state, because an API
 * that offered them would invite a UI to use them. Levels and badges
 * (`me/recognition`) say only what the caller holds and why: never the next
 * level, the distance to it, or a badge not held.
 */
@ApiTags('rewards')
@Controller({ path: 'rewards', version: '1' })
export class RewardController {
  constructor(
    private readonly rewards: RewardService,
    private readonly participation: ParticipationService,
    private readonly recognition: RecognitionService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  // ---- The caller's own standing -------------------------------------------

  @Get('me')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'OPERATOR', 'DRIVER')
  @ApiOperation({
    summary: 'The calling user points, level and recent rewards',
    description:
      'Scoped to the authenticated user within the active organization. There is no endpoint ' +
      'that reads another user standing: it is behavioural data about a person, and nothing ' +
      'in the product document asks for it to be visible to anyone else. ' +
      '`balance.level` is the unversioned legacy ladder (`reward_level`), which no API ' +
      'configures and nothing seeds, so it is null; levels and badges are ' +
      'GET /v1/rewards/me/recognition, ' +
      'read on the basis their version names (COM-012, docs/24 Q-140). Neither grants a ' +
      'benefit (docs/24 Q-13).',
  })
  async me(@Query(zodPipe(myRewardsQuerySchema)) query: MyRewardsQuery) {
    assertNotAuditor();
    const result = await this.rewards.myRewards(query.limit);
    return {
      balance: result.balance
        ? toRewardBalanceView(result.balance as unknown as RewardBalanceRow)
        : null,
      rewards: result.rewards.map((row) => toRewardView(row as RewardRow)),
    };
  }

  @Get('me/participation')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'OPERATOR', 'DRIVER')
  @ApiOperation({
    summary: 'The calling user participation score, explained — not spendable',
    description:
      'ParticipationScore is a rolling index of the verified facts the caller did in the ' +
      'active organization (ADR-047): never spent, granted or converted, and separate from the ' +
      'reward points of GET /v1/rewards/me. `spendable` is always false. The score is the sum ' +
      'of `breakdown[].contribution`, each `counted × weight`, under the participation rule ' +
      'version named in `rule`, over `window`; `recentFacts` says which recent facts counted ' +
      'and what each added. Only facts the owning service confirmed and attributed to the ' +
      'caller count. `status` is NO_RULE, with a null score, while no participation rule has ' +
      'been created (docs/24 Q-139). Own score only: there is no parameter naming another ' +
      'user, and no comparison with anybody else.',
  })
  async myParticipation(@Query(zodPipe(myParticipationQuerySchema)) query: MyParticipationQuery) {
    assertNotAuditor();
    return toParticipationView(await this.participation.myParticipation(query.limit));
  }

  @Get('me/recognition')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'OPERATOR', 'DRIVER')
  @ApiOperation({
    summary: 'The level and badges the calling user holds, and why',
    description:
      'Read under the levels-and-badges version in force (`rule`), on the basis that version ' +
      'names — `REWARD_POINTS_CUMULATIVE` (the caller reward points in the active ' +
      'organization) or `PARTICIPATION_SCORE` (the caller participation score, under the ' +
      'participation rule version in `basis.participationRuleVersion`). `basis.value` is the ' +
      'number every threshold was compared with. `level` is the highest level whose threshold ' +
      'it meets, or null; `badges` every badge whose threshold it meets. Only what is held: ' +
      'never the levels above, the distance to them, or the badges not held. Nothing is ' +
      'granted by holding either (docs/24 Q-13). `status` is NO_RULE while no version exists ' +
      '(docs/24 Q-140), and NO_BASIS when the version is read on the participation score and ' +
      'no participation rule exists (Q-139). Own standing only: no parameter names another ' +
      'user, and no route lists who holds what (docs/24 Q-30).',
  })
  async myRecognition(@Query(zodPipe(myRecognitionQuerySchema)) _query: MyRecognitionQuery) {
    assertNotAuditor();
    return toRecognitionView(await this.recognition.myRecognition());
  }

  // ---- Levels-and-badges versions ------------------------------------------

  @Get('recognition-rules')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Levels-and-badges versions, newest first',
    description: 'Platform-wide. The first item is the version in force. Names no person.',
  })
  async listRecognitionRules() {
    assertNotAuditor();
    const rows = await this.recognition.listRules();
    return { items: rows.map(toRecognitionRuleApiView) };
  }

  @Post('recognition-rules')
  @HttpCode(201)
  @Roles('SYSTEM_ADMIN')
  @ApiOperation({
    summary: 'Create the next levels-and-badges version',
    description:
      '`basis` — what every threshold is measured on — has no default: ADR-047 § 1 requires ' +
      'it explicit in the version. Levels are given lowest first, thresholds rising strictly; ' +
      'badges are named thresholds on the same basis, held while met. No threshold, name or ' +
      'badge has a default and none is seeded — the product document gives none (docs/24 ' +
      'Q-140). There is no benefit field (Q-13). In force from now for every organization; ' +
      'the previous version stays as the record and is never edited. Publishes ' +
      'RECOGNITION_RULE_CHANGED with the actor and the terms before and after. ' +
      '`expectedCurrentVersion` is the version being replaced (0 while none exists); if another ' +
      'version was created since, 409 OPTIMISTIC_LOCK_FAILED and nothing is written. Requires ' +
      'an `Idempotency-Key`: a retry returns the version the first request created, never ' +
      'another one.',
  })
  async createRecognitionRule(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(createRecognitionRuleSchema)) dto: CreateRecognitionRuleDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run(
      'POST /v1/rewards/recognition-rules',
      key,
      dto,
      201,
      (answer) => this.recognition.createRule(dto, answer.map(toRecognitionRuleApiView)),
      // As the participation rule: platform-wide, listed to every
      // administrator, and the role checks have run as the caller now is.
      { mayReplay: async () => undefined },
    );
  }

  // ---- Participation rule versions -----------------------------------------

  @Get('participation-rules')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Participation rule versions, newest first',
    description: 'Platform-wide. The first item is the version in force.',
  })
  async listParticipationRules() {
    assertNotAuditor();
    const rows = await this.participation.listRules();
    return { items: rows.map(toParticipationRuleApiView) };
  }

  @Post('participation-rules')
  @HttpCode(201)
  @Roles('SYSTEM_ADMIN')
  @ApiOperation({
    summary: 'Create the next participation rule version',
    description:
      'Which verified facts count toward ParticipationScore, the weight of each, at most how ' +
      'many per window, and the window in days. In force from now for every organization; the ' +
      'previous version stays as the record and is never edited. No number has a default — the ' +
      'product document gives none (docs/24 Q-139). Publishes PARTICIPATION_RULE_CHANGED with ' +
      'the actor and the terms before and after. Weights are positive: no penalties. ' +
      '`expectedCurrentVersion` is the version being replaced (0 while none exists); if another ' +
      'version was created since, 409 OPTIMISTIC_LOCK_FAILED and nothing is written. Requires ' +
      'an `Idempotency-Key`: a retry returns the version the first request created, never ' +
      'another one.',
  })
  async createParticipationRule(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(createParticipationRuleSchema)) dto: CreateParticipationRuleDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run(
      'POST /v1/rewards/participation-rules',
      key,
      dto,
      201,
      (answer) => this.participation.createRule(dto, answer.map(toParticipationRuleApiView)),
      // Nothing to re-check: a version is platform-wide and listed to every
      // administrator, and the role and oversight checks above have already
      // run as the caller now is. The record answers only its own actor.
      { mayReplay: async () => undefined },
    );
  }

  // ---- Rules ---------------------------------------------------------------

  @Get('rules')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Reward rules that could apply to this organization',
    description: 'Platform-wide rules and this organization own.',
  })
  async listRules(@Query(zodPipe(listRewardRulesQuerySchema)) query: ListRewardRulesQuery) {
    assertNotAuditor();
    const rows = await this.rewards.listRules(query.triggerEvent);
    return { items: rows.map(toRewardRuleView) };
  }

  @Post('rules')
  @HttpCode(201)
  @Roles('SYSTEM_ADMIN')
  @ApiOperation({
    summary: 'Define a reward rule',
    description:
      'Omit `creditPerPointMinor` — the expected case — and the rule grants points only and ' +
      'posts no ledger journal. Supply it and each grant becomes a real recorded platform ' +
      'expense, debited to reward expense and credited to the organization wallet, exactly as ' +
      'docs/10 § 10.4 describes. `periodCap` and `periodType` must be given together: a cap ' +
      'with no window is not a cap, and the cap is an anti-fraud control (docs/10 § 10.9). ' +
      'CASHBACK rules are refused while the feature flag is off — the product document ' +
      'conditions cashback on a regulatory review (docs/24 Q-07). `creditPerPointMinor` is ' +
      'answered as a decimal string in minor units, or null. Requires an `Idempotency-Key`: a ' +
      'retry returns the rule the first request created, never a second rule paying for the ' +
      'same fact again.',
  })
  async createRule(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    // Canonical first (the amount, the instants, the label's line endings, the
    // condition's numeric operands), so a retry that says the same thing
    // differently replays rather than 409s.
    @Body(canonicalPipe(createRewardRuleSchema), zodPipe(createRewardRuleSchema))
    dto: CreateRewardRuleDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run(
      'POST /v1/rewards/rules',
      key,
      dto,
      201,
      (answer) => this.rewards.createRule(dto, answer.map(toRewardRuleView)),
      // Nothing to re-check before the stored rule is shown: the route is
      // SYSTEM_ADMIN's alone, and the role and oversight checks above have run
      // as the caller now is; a system administrator reaches every rule
      // (PATCH /v1/rewards/rules/{id} reads by id alone). The record answers
      // only the actor who made it (`IdempotencyStore`).
      { mayReplay: async () => undefined },
    );
  }

  @Patch('rules/:id')
  @Roles('SYSTEM_ADMIN')
  @ApiOperation({
    summary: 'Close, deactivate or relabel a reward rule',
    description:
      '`points`, `creditPerPointMinor` and `periodCap` cannot be changed — sending one is a ' +
      '400, because a grant reads them when its event is processed and an edit reached back ' +
      'to occurrences not yet granted. docs/24 Q-09 is answered by closing the points-only ' +
      'rule and creating one with `creditPerPointMinor` from the same instant — still no code ' +
      'change and no deployment. `validTo` only moves forward. Every change publishes ' +
      '`REWARD_RULE_CHANGED` with the actor and the terms before and after. Answers the rule ' +
      'as POST does.',
  })
  async updateRule(
    @Param('id') id: string,
    @Body(zodPipe(updateRewardRuleSchema)) dto: UpdateRewardRuleDto,
  ) {
    assertNotAuditor();
    return toRewardRuleView(await this.rewards.updateRule(id, dto));
  }
}
