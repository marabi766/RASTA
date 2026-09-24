import { ButtonLink, EmptyState, ErrorState, Identifier, NoAccessState, Section } from '@/ui';
import { membershipStatusLabel, roleLabel } from '@/lib/organization-fields';
import { memberName, type MemberListQuery, type MemberPage } from '@/server/members';
import { newSubmissionId } from '@/server/submission';
import type { ReadResult } from '@/server/assets';

import { MemberRolesForm } from './MemberRolesForm';
import { RevokeMembershipForm } from './RevokeMembershipForm';

/**
 * The people in this organization, and the two changes an administrator may
 * make to one.
 *
 * A pure function of what the server read, mirroring `DriversScreen` and
 * `MaintenanceScreen`: every state — a page of members, an empty tenant, a
 * search that matched nothing, a refusal, an outage — is renderable in a test.
 *
 * Paging and search happen in the URL, as on every list in this portal: no
 * JavaScript is involved, and a filtered list is a link somebody can send.
 */

export interface MembersScreenProps {
  readonly result: ReadResult<MemberPage>;
  readonly query: MemberListQuery;
  readonly grantableRoles: readonly string[];
  readonly csrfToken: string;
}

function hrefWith(query: MemberListQuery, changes: Partial<MemberListQuery>): string {
  const params = new URLSearchParams();
  const merged = { ...query, ...changes };
  if (merged.q) params.set('q', merged.q);
  if (merged.role) params.set('role', merged.role);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const search = params.toString();
  return search ? `/organizations?${search}` : '/organizations';
}

const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

function Search({ query }: { query: MemberListQuery }) {
  return (
    <form
      method="get"
      action="/organizations"
      className="flex flex-wrap items-end gap-4"
      aria-label="جست‌وجوی اعضا"
    >
      <label htmlFor="member-q" className="flex flex-col gap-1 text-sm text-content-muted">
        نام، نام کاربری یا رایانامه
        <input
          id="member-q"
          name="q"
          aria-label="جست‌وجوی اعضا بر پایهٔ نام، نام کاربری یا رایانامه"
          defaultValue={query.q ?? ''}
          className={CONTROL}
        />
      </label>
      <button type="submit" className={CONTROL}>
        جست‌وجو
      </button>
    </form>
  );
}

/**
 * One submission id per form, minted here.
 *
 * `submission.ts` says "one id per form, minted when the form is rendered".
 * This screen renders two per member plus one profile form beside it, so a
 * single id handed to all of them breaks that contract — and the reason it
 * looked harmless was a property of a *different* service's uniqueness key
 * (`(organizationId, endpoint, key)`), which is not a thing this file should
 * depend on staying true. A server component may mint them, so it does.
 */
export function MembersScreen({ result, query, grantableRoles, csrfToken }: MembersScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="فهرست اعضای این سازمان در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="سازمانی یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست اعضا خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <div className="flex flex-col gap-4">
      <Section headingId="members" title="اعضای سازمان">
        <Search query={query} />

        {page.items.length === 0 ? (
          <EmptyState
            title={query.q ? 'عضوی با این جست‌وجو پیدا نشد' : 'هنوز عضوی ثبت نشده است'}
            description={
              query.q
                ? 'عبارت دیگری را امتحان کنید یا جست‌وجو را خالی بگذارید.'
                : 'اعضای سازمان پس از ثبت‌نام و تأیید اینجا دیده می‌شوند.'
            }
          />
        ) : (
          <ul className="mt-4 flex flex-col gap-4">
            {page.items.map((member) => (
              <li key={member.id} className="rounded-lg border border-border bg-surface-raised p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-medium">{memberName(member)}</h3>
                  <span className="text-sm text-content-muted">
                    {membershipStatusLabel(member.status)}
                  </span>
                </div>

                <p className="mt-1 text-sm text-content-muted">
                  <Identifier>{member.username}</Identifier>
                </p>

                <p className="mt-2 text-sm">
                  نقش‌های کنونی: {member.roles.map(roleLabel).join('، ') || '—'}
                </p>

                {member.membershipId === null ? (
                  // The list resolves a user *through* a membership, so a null
                  // id means the membership went away between two queries.
                  // Nothing here can act on it, and saying so beats rendering
                  // forms that would 404.
                  <p className="mt-3 text-sm text-content-muted">
                    عضویت این کاربر در فاصلهٔ خواندن این صفحه تغییر کرده است. صفحه را تازه کنید.
                  </p>
                ) : (
                  <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
                    <MemberRolesForm
                      membershipId={member.membershipId}
                      memberName={memberName(member)}
                      currentRoles={member.roles}
                      grantableRoles={grantableRoles}
                      csrfToken={csrfToken}
                      submissionId={newSubmissionId()}
                    />
                    <RevokeMembershipForm
                      membershipId={member.membershipId}
                      memberName={memberName(member)}
                      csrfToken={csrfToken}
                      submissionId={newSubmissionId()}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {page.hasMore && page.nextCursor ? (
          <div className="mt-4">
            <ButtonLink href={hrefWith(query, { cursor: page.nextCursor })} tone="secondary">
              صفحهٔ بعد
            </ButtonLink>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
