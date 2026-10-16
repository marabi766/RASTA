import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { RewardService } from './reward.service';
import { ParticipationService } from './participation.service';
import { toParticipationRuleApiView, toParticipationView } from './participation-views';
import { assertNotAuditor } from '../access/access';
import {
  toRewardBalanceView,
  toRewardView,
  type RewardBalanceRow,
  type RewardRow,
} from '../shared/views';
import {
  createParticipationRuleSchema,
  createRewardRuleSchema,
  listRewardRulesQuerySchema,
  myParticipationQuerySchema,
  myRewardsQuerySchema,
  updateRewardRuleSchema,
  type CreateParticipationRuleDto,
  type CreateRewardRuleDto,
  type MyParticipationQuery,
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
 * level name. It exposes no streaks, no badges and no celebratory state,
 * because an API that offered them would invite a UI to use them.
 */
@ApiTags('rewards')
@Controller({ path: 'rewards', version: '1' })
export class RewardController {
  constructor(
    private readonly rewards: RewardService,
    private readonly participation: ParticipationService,
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
      '`level` is null while no ladder is configured — docs/24 Q-13 has not been answered, so ' +
      'levels are computed but grant no benefit.',
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
      'the actor and the terms before and after. Weights are positive: no penalties.',
  })
  async createParticipationRule(
    @Body(zodPipe(createParticipationRuleSchema)) dto: CreateParticipationRuleDto,
  ) {
    assertNotAuditor();
    return toParticipationRuleApiView(await this.participation.createRule(dto));
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
    return { items: rows };
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
      'conditions cashback on a regulatory review (docs/24 Q-07).',
  })
  async createRule(@Body(zodPipe(createRewardRuleSchema)) dto: CreateRewardRuleDto) {
    assertNotAuditor();
    return this.rewards.createRule(dto);
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
      '`REWARD_RULE_CHANGED` with the actor and the terms before and after.',
  })
  async updateRule(
    @Param('id') id: string,
    @Body(zodPipe(updateRewardRuleSchema)) dto: UpdateRewardRuleDto,
  ) {
    assertNotAuditor();
    return this.rewards.updateRule(id, dto);
  }
}
