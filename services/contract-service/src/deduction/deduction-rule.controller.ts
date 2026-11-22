import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { DeductionRuleService } from './deduction-rule.service';
import { proposeDeductionSchema, type ProposeDeductionDto, type DeductionReceipt } from './dto';

@ApiTags('deduction-rules')
@Controller({ path: 'deduction-rules/changes', version: '1' })
export class DeductionRuleController {
  constructor(private readonly deductions: DeductionRuleService) {}

  @Post()
  @RequirePlatformUserId()
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters, scoped to the selected employer organization.',
  })
  @ApiOperation({
    summary: 'Propose creating or retiring an employer deduction rule',
    description:
      'Authorized employer writers only. Creates a PENDING_APPROVAL proposal; never changes a rule in force. Independent platform approval is required for both kinds. An authorized replay within the configured idempotency lifetime returns the original receipt.',
  })
  propose(
    @Body(zodPipe(proposeDeductionSchema)) dto: ProposeDeductionDto,
    @Headers('idempotency-key') key?: string,
  ): Promise<DeductionReceipt> {
    return this.deductions.propose(dto, key);
  }
}
