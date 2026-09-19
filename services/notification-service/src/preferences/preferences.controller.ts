import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { PreferencesService, type EffectivePreferenceView } from './preferences.service';
import {
  effectiveQuerySchema,
  replacePreferencesSchema,
  type EffectiveQuery,
  type ReplacePreferencesDto,
} from './preferences.dto';

/**
 * Notification preferences — three endpoints, all "the caller's own" (ADR-054
 * § 5, § 11).
 *
 * Closed by default like the inbox: `AuthGuard` and `RolesGuard` are global,
 * nothing here carries `@Public`, `@AllowService` or `@Roles`. Every
 * authenticated person has preferences, nobody may read or write anybody
 * else's, and a service token has no preferences at all — refused by the guard
 * and again by `resolveActor()`.
 *
 * Route order matters here as it does on the inbox: `effective` is a static
 * path and there is no parameterised sibling to shadow it today, but the
 * ordering is kept deliberate so adding one later cannot silently make it
 * unreachable.
 *
 * No business logic in this class. A pipe validates, the service resolves the
 * actor and decides, and each handler is one line (AGENTS.md A-10).
 */
@ApiTags('notification-preferences')
@Controller({ path: 'preferences', version: '1' })
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  @ApiOperation({
    summary: 'List the caller’s own notification preferences',
    description:
      'Only the rows this person has stored for the active organization. ' +
      'Preferences are per tenant: the same human in another organization has ' +
      'a separate set, so silencing one does not silence the others. An empty ' +
      'list means every channel falls to its configured default.',
  })
  listOwn() {
    return this.preferences.listOwn();
  }

  @Put()
  @ApiOperation({
    summary: 'Replace the caller’s own notification preferences',
    description:
      'A whole replacement rather than a patch: a settings screen sends what it ' +
      'shows, and a row left out is removed. Turning off a channel that a ' +
      'mandatory rule delivers on is refused with 422 rather than stored and ' +
      'ignored — a control that shows "off" while the notification still arrives ' +
      'claims an effect it does not have. Nothing is written unless every entry ' +
      'is allowed.',
  })
  replaceOwn(@Body(zodPipe(replacePreferencesSchema)) body: ReplacePreferencesDto) {
    return this.preferences.replaceOwn(body.preferences);
  }

  @Get('effective')
  @ApiOperation({
    summary: 'Resolve one rule and channel, with the layer that decided',
    description:
      'Returns whether this rule would be delivered on this channel for the ' +
      'caller, which rung of the precedence ladder decided — MANDATORY_POLICY, ' +
      'RULE, CATEGORY, GLOBAL or CHANNEL_DEFAULT — and whether the caller may ' +
      'change it. The winning layer is part of the answer on purpose: a ' +
      'preference system nobody can inspect is a preference system nobody ' +
      'believes.',
  })
  effective(
    @Query(zodPipe(effectiveQuerySchema)) query: EffectiveQuery,
  ): Promise<EffectivePreferenceView> {
    return this.preferences.effective(query);
  }
}
