import { RastaError } from '@rasta/nest-common';
import { IDENTITY_SERVICE, type MembershipSource } from '../src/fleet/membership';

/**
 * identity-service's answer to "is this user a live member of this
 * organization", in-process (task 095).
 *
 * Membership is per (organization, user): {@link admit} makes a user a member
 * of one organization and of no other, so a test about tenant isolation says
 * which organization the user belongs to and asks as another. {@link down}
 * takes the source away (every question throws `UPSTREAM_UNAVAILABLE`, as the
 * real client does for any failure); {@link everyone} is for suites about
 * something else, where every user is a member everywhere.
 */
export class FakeMembershipSource implements MembershipSource {
  readonly asked: { organizationId: string; userId: string }[] = [];
  private readonly members = new Set<string>();
  private all = false;
  private unavailable = false;
  /** Runs before each answer, so a test can hold two questions open at once. */
  gate: () => Promise<void> = async () => undefined;

  admit(organizationId: string, userId: string): this {
    this.members.add(`${organizationId}\n${userId}`);
    return this;
  }

  remove(organizationId: string, userId: string): this {
    this.members.delete(`${organizationId}\n${userId}`);
    return this;
  }

  everyone(): this {
    this.all = true;
    return this;
  }

  down(unavailable = true): this {
    this.unavailable = unavailable;
    return this;
  }

  async isLiveMember(organizationId: string, userId: string): Promise<boolean> {
    this.asked.push({ organizationId, userId });
    await this.gate();
    if (this.unavailable) throw RastaError.upstreamUnavailable(IDENTITY_SERVICE);
    return this.all || this.members.has(`${organizationId}\n${userId}`);
  }
}

/** Every user is a live member of every organization: for suites about something else. */
export function everyoneIsAMember(): FakeMembershipSource {
  return new FakeMembershipSource().everyone();
}
