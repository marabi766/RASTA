import { Injectable, Logger } from '@nestjs/common';
import { IdentityRepository } from '../identity/identity.repository';
import { KeycloakAdminClient } from './keycloak.client';
import {
  divergentAttributes,
  platformAttributesFor,
  type PlatformAttributeName,
  type PlatformAttributes,
} from './platform-attributes';
import {
  KEYCLOAK_PROJECTION_OUTCOMES,
  keycloakProjectionsTotal,
  type KeycloakProjectionOutcome,
  type KeycloakProjectionTrigger,
} from '../observability/keycloak-projection.metrics';

export interface ReconcileFinding {
  userId: string;
  divergent: PlatformAttributeName[];
}

/**
 * Projects a user's memberships into their Keycloak attributes (ADR-060 § 5).
 *
 * `projectUserToKeycloak` in the ADR. The only writer of the four platform
 * attributes, and it always writes all four, rebuilt from the database — so
 * running it twice, or out of order, or long after the change that prompted
 * it, converges on the same attributes. That is what makes both the event
 * handler and the backfill safe to repeat.
 *
 * ## Two paths, one function
 *
 * Every membership change calls {@link projectAfterCommit} straight after its
 * transaction commits, so the next token is right in the ordinary case. That
 * write can fail — Keycloak down, a network blip — and the membership has
 * already committed, so it must not fail the request. The durable path is the
 * identity outbox: the same change enqueued `MEMBERSHIP_*` or `ROLE_*` in its
 * transaction, and `KeycloakProjectionConsumer` projects the user again when
 * it arrives. Whichever lands last wins, and both write the same thing.
 */
@Injectable()
export class KeycloakProjector {
  private readonly logger = new Logger(KeycloakProjector.name);

  constructor(
    private readonly repository: IdentityRepository,
    private readonly keycloak: KeycloakAdminClient,
  ) {}

  /** What the user's Keycloak attributes should be, or null when there is no such user. */
  async expectedAttributes(
    userId: string,
  ): Promise<{ keycloakId: string | null; attributes: PlatformAttributes } | null> {
    const user = await this.repository.findUserById(userId);
    if (!user) return null;
    const memberships = await this.repository.listMembershipsForUser(userId);
    return {
      keycloakId: user.keycloakId,
      attributes: platformAttributesFor(user, memberships, new Date()),
    };
  }

  /**
   * Rebuilds and writes one user's platform attributes. Throws if the write
   * does not land.
   */
  async project(
    userId: string,
    trigger: KeycloakProjectionTrigger,
  ): Promise<KeycloakProjectionOutcome> {
    const outcome = await this.write(userId).catch((error: unknown) => {
      keycloakProjectionsTotal.inc({ trigger, outcome: KEYCLOAK_PROJECTION_OUTCOMES.FAILED });
      throw error;
    });
    keycloakProjectionsTotal.inc({ trigger, outcome });
    return outcome;
  }

  /**
   * Projection after a membership change that has already committed.
   *
   * Never throws: failing the request would report a committed change as
   * failed, and a retry would then collide with the row it already wrote. The
   * failure is logged and counted, and the outbox event from the same
   * transaction brings the projection back round (see the class comment).
   */
  async projectAfterCommit(userId: string): Promise<void> {
    try {
      await this.project(userId, 'request');
    } catch (error) {
      this.logger.error(
        `Keycloak projection failed for user ${userId}; the identity event will retry it. ` +
          `Until then their token does not match their memberships. ${describe(error)}`,
      );
    }
  }

  /**
   * Compares what Keycloak holds with what it should, without writing.
   * Null when there is nothing to compare: no such user, or no account yet.
   */
  async reconcile(userId: string): Promise<ReconcileFinding | null> {
    const expected = await this.expectedAttributes(userId);
    if (!expected || !expected.keycloakId || !this.keycloak.enabled) return null;
    const actual = await this.keycloak.getPlatformAttributes(expected.keycloakId);
    return { userId, divergent: divergentAttributes(actual, expected.attributes) };
  }

  private async write(userId: string): Promise<KeycloakProjectionOutcome> {
    if (!this.keycloak.enabled) return KEYCLOAK_PROJECTION_OUTCOMES.DISABLED;
    const expected = await this.expectedAttributes(userId);
    if (!expected) return KEYCLOAK_PROJECTION_OUTCOMES.NO_USER;
    // A registration not yet approved has no account: nothing to project into.
    if (!expected.keycloakId) return KEYCLOAK_PROJECTION_OUTCOMES.NO_ACCOUNT;
    await this.keycloak.replacePlatformAttributes(expected.keycloakId, expected.attributes);
    return KEYCLOAK_PROJECTION_OUTCOMES.PROJECTED;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
