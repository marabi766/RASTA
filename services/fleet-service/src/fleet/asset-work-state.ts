import { Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { FleetRepository } from './fleet.repository';

/**
 * Whether a machine has an open assignment, as fleet-service records it (D-039).
 *
 * asset-service's `ASSIGNED` status follows this. When `ASSET_ASSIGNED` or
 * `ASSIGNMENT_ENDED` is replayed on `.retry` it may be older than what was
 * applied since, so asset-service does not apply the payload: it asks here
 * for the current answer and derives the status from it.
 *
 * The ADR-061 § 4 pattern: `/v1/internal/…`, which the gateway routes
 * nowhere; `@AllowService` on the route and {@link assertWorkStateCaller}
 * here, which also refuses every user token; the organization is the one
 * signed into the internal token (ADR-035), never a header. The answer is a
 * boolean about one machine in that organization: an assignment in another
 * organization is not visible, so it is never counted.
 */

/** The only caller. */
export const WORK_STATE_CALLER = 'asset-service';

export interface AssignmentStateView {
  assetId: string;
  activeAssignment: boolean;
}

export function assertWorkStateCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== WORK_STATE_CALLER) {
    throw RastaError.forbidden('This endpoint is reserved for asset-service');
  }
}

@Injectable()
export class AssetWorkStateService {
  constructor(private readonly repository: FleetRepository) {}

  async assignmentState(assetId: string): Promise<AssignmentStateView> {
    assertWorkStateCaller();
    // A token with no organization is a 403 here, before any query.
    getOrganizationId();
    return { assetId, activeAssignment: await this.repository.hasActiveAssignment(assetId) };
  }
}
