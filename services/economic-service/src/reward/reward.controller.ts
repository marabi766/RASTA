import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { RewardService } from './reward.service';
import { assertNotAuditor } from '../access/access';
import {
  toRewardBalanceView,
  toRewardView,
  type RewardBalanceRow,
  type RewardRow,
} from '../shared/views';
import {
  createRewardRuleSchema,
  listRewardRulesQuerySchema,
  myRewardsQuerySchema,
  updateRewardRuleSchema,
  type CreateRewardRuleDto,
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
  constructor(private readonly rewards: RewardService) {}

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
    summary: 'Amend a reward rule',
    description:
      'Setting `creditPerPointMinor` is how docs/24 Q-09 is answered when it is answered — a ' +
      'single update, with no code change and no deployment.',
  })
  async updateRule(
    @Param('id') id: string,
    @Body(zodPipe(updateRewardRuleSchema)) dto: UpdateRewardRuleDto,
  ) {
    assertNotAuditor();
    return this.rewards.updateRule(id, dto);
  }
}
