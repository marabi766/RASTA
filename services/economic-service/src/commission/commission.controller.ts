import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { CommissionService } from './commission.service';
import { assertNotAuditor } from '../access/access';
import {
  toCommissionRuleView,
  toCommissionView,
  type CommissionRow,
  type CommissionRuleRow,
} from '../shared/views';
import {
  createCommissionRuleSchema,
  listCommissionRulesQuerySchema,
  listCommissionsQuerySchema,
  updateCommissionRuleSchema,
  type CreateCommissionRuleDto,
  type ListCommissionRulesQuery,
  type ListCommissionsQuery,
  type UpdateCommissionRuleDto,
} from './dto';

/**
 * The commission API (docs/06 § 6.10, docs/10 § 10.7).
 *
 * ## Why configuration is an API rather than a migration
 *
 * ADR-023 requires governance rules to be **data**, versioned in time and
 * recorded in the audit trail — because the product document says the platform
 * "هیچ اختیار یا مرجع تصمیم‌گیری تازه‌ای ایجاد نمی‌کند". A rate that lived in a
 * seed script would need a deployment to change and would leave no record of
 * who changed it. So docs/24 Q-08's answer is a `POST` to this controller by
 * whoever the steering group authorises, and nothing in this repository has to
 * change for it.
 *
 * ## Why writing a rule needs `SYSTEM_ADMIN` specifically
 *
 * Narrower than the rest of this service, which admits `UNION_ADMIN` too.
 * docs/10 § 10.7 names `SYSTEM_ADMIN` for a rate change because the rate is
 * approved by the steering group and the platform's job is only to record who
 * applied their decision — not to let platform operations set it.
 */
@ApiTags('commissions')
@Controller({ path: 'commissions', version: '1' })
export class CommissionController {
  constructor(private readonly commissions: CommissionService) {}

  // ---- Charges -------------------------------------------------------------

  @Get()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Commission charged to this organization',
    description:
      'One row per settled transaction, including those charged nothing. `outcome` ' +
      '`NO_ACTIVE_RULE` (and a null `ruleId`) means no active rule matched — evidence that the ' +
      'step ran, which its absence could not provide, and never the same thing as a rule ' +
      'configured at zero (ADR-045 § 2). Filter by `businessLine` and `outcome` to report ' +
      'revenue per line and the transactions no rule priced. A `cursor` pages the filtered view ' +
      'it came from: one from the same organization under another `businessLine` or `outcome` ' +
      'is refused like any other cursor that is not a row of this list.',
  })
  async list(@Query(zodPipe(listCommissionsQuerySchema)) query: ListCommissionsQuery) {
    assertNotAuditor();
    const rows = await this.commissions.listCommissions(query.limit, query.cursor, {
      businessLine: query.businessLine,
      outcome: query.outcome,
    });
    return { items: rows.map((row) => toCommissionView(row as CommissionRow)) };
  }

  // ---- Rules ---------------------------------------------------------------

  @Get('rules')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Commission rules that could apply to this organization',
    description:
      'Platform-wide rules and this organization own. Never another organization negotiated ' +
      'rate. An empty list is the expected state today: docs/24 Q-08 is open and **no ' +
      'commercial rate is seeded**, so every transaction settles at zero commission until the ' +
      'steering group decides otherwise.',
  })
  async listRules(@Query(zodPipe(listCommissionRulesQuerySchema)) query: ListCommissionRulesQuery) {
    assertNotAuditor();
    const rows = await this.commissions.listRules(query);
    return { items: rows.map((row) => toCommissionRuleView(row as CommissionRuleRow)) };
  }

  @Post('rules')
  @HttpCode(201)
  @Roles('SYSTEM_ADMIN')
  @ApiOperation({
    summary: 'Define a commission rate',
    description:
      'The rate is an integer in basis points — 250 is exactly 2.5%, which a decimal ' +
      'percentage cannot promise (ADR-022). A rule prices one `businessLine` (ADR-045), ' +
      'optionally narrowed to one `transactionType`; the narrowed rule wins over the line-wide ' +
      'one. Rules are versioned in time: a transaction is ' +
      'always charged the rate in force when it *occurred*, recorded with it when its source ' +
      'fact is recorded, so an old obligation settled today is not repriced. `validFrom` ' +
      'defaults to now and may not be earlier (422): a rule is never backdated. An active rule ' +
      'may not overlap another of the same organization (or the platform), line and type (409). ' +
      'An organization-specific rule takes precedence over a platform-wide ' +
      'one. Label demonstration data "نمونه — نیازمند تصویب" so a sample rate can never be ' +
      'mistaken for an approved one.',
  })
  async createRule(@Body(zodPipe(createCommissionRuleSchema)) dto: CreateCommissionRuleDto) {
    assertNotAuditor();
    const rule = await this.commissions.createRule(dto);
    return toCommissionRuleView(rule as CommissionRuleRow);
  }

  @Patch('rules/:id')
  @Roles('SYSTEM_ADMIN')
  @ApiOperation({
    summary: 'End, withdraw, reinstate or relabel a rule',
    description:
      'Close a rule with `validTo` rather than deleting it: a commission already charged ' +
      'references the rule that produced it, and deleting it would make a historical charge ' +
      'unexplainable. **The rate cannot be changed** — sending `rateBasisPoints` is a 400: a ' +
      'new rate is a new rule: close this one and ' +
      'create the next from the same instant. `validTo` only moves forward: a close in the ' +
      'past, or re-dating a rule that has ended, is a 422. **Status is effective-dated:** ' +
      '`status: INACTIVE` on a rule in force ends it now (`validTo` becomes the present and the ' +
      'status stays, so what it priced it still prices); before its start it withdraws the ' +
      'rule, and `status: ACTIVE` reinstates a withdrawn rule only while its start is ahead. An ' +
      'extension or reinstatement that would overlap an active rule of the same scope is a 409. ' +
      'Every change publishes `COMMISSION_RULE_CHANGED` (v2) with the actor and the terms ' +
      'before and after.',
  })
  async updateRule(
    @Param('id') id: string,
    @Body(zodPipe(updateCommissionRuleSchema)) dto: UpdateCommissionRuleDto,
  ) {
    assertNotAuditor();
    const rule = await this.commissions.updateRule(id, dto);
    return toCommissionRuleView(rule as CommissionRuleRow);
  }
}
