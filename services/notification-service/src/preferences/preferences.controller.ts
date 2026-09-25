import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditorSelfService, zodPipe } from '@rasta/nest-common';
import {
  PreferencesService,
  type EffectivePreferenceView,
  type QuietHoursView,
} from './preferences.service';
import {
  effectiveQuerySchema,
  replacePreferencesSchema,
  replaceQuietHoursSchema,
  type EffectiveQuery,
  type ReplacePreferencesDto,
  type ReplaceQuietHoursDto,
} from './preferences.dto';

/**
 * Notification preferences — five endpoints, all "the caller's own" (ADR-054
 * § 5, § 11). The last two are the quiet window NTF-003 deferred and NTF-004
 * owes: the first channel that can wake somebody is the first one for which
 * "not now" is a meaningful answer.
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
@AuditorSelfService(
  'every handler here reads or changes only the caller’s own notification preferences',
)
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

  @Get('quiet-hours')
  @ApiOperation({
    summary: 'Read the caller’s own quiet window',
    description:
      'The hours in which an interrupting channel waits. Returned in the zone ' +
      'it was set in, as HH:MM. `null` means no quiet window, which is what ' +
      'every recipient has until they set one. Quiet hours defer and never ' +
      'drop: a message due inside the window is sent when it ends, and a ' +
      'CRITICAL notification is sent regardless.',
  })
  quietHours(): Promise<QuietHoursView> {
    return this.preferences.quietHours();
  }

  @Put('quiet-hours')
  @ApiOperation({
    summary: 'Set or clear the caller’s own quiet window',
    description:
      'A window may wrap midnight — 22:00 to 07:00 is the ordinary case. Its ' +
      'start and end must differ, because a window whose bounds are equal is ' +
      'either zero minutes or the whole day depending on who reads it, and one ' +
      'of those two readings silences a person permanently. Send `null` to ' +
      'clear it. In-app notifications are never affected: they wait in an inbox ' +
      'and interrupt nobody.',
  })
  replaceQuietHours(
    @Body(zodPipe(replaceQuietHoursSchema)) body: ReplaceQuietHoursDto,
  ): Promise<QuietHoursView> {
    return this.preferences.replaceQuietHours(body.quietHours);
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
