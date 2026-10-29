import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
  TableScroll,
} from '@/ui';
import { driverStatusLabel, driverStatusOptions } from '@/lib/labels';
import { formatJalaliDateLong, withoutBidiControls } from '@/lib/format';
import type { DriverListQuery, DriverPage, ReadResult } from '@/server/drivers';
import type { RosterPerson } from '@/server/driver-roster';
import { withContext, type InContext } from '@/lib/page-context';
import { ContextField } from '@/app/ContextField';

/**
 * The driver list (docs/16 § 16.6, `/drivers`).
 *
 * A pure function of what the server read, mirroring `MaintenanceScreen`
 * (PR #73): every state — a page of rows, an empty tenant, a filter that
 * matched nothing, a refusal, an outage — is renderable in a test.
 *
 * Filtering and paging happen in the URL for the same reason every list
 * screen in this portal does it that way: no JavaScript is involved, and a
 * filtered list is a link somebody can send to a colleague.
 */

export interface DriversScreenProps {
  readonly result: ReadResult<DriverPage>;
  readonly query: InContext<DriverListQuery>;
  /**
   * Every member of this organization by user id, when this person may list
   * the members and the whole list was read (`server/driver-roster.ts`);
   * otherwise null and the list has no name column. A driver row holds no
   * name — identity-service does — and a person without the member-list right
   * (`FLEET_MANAGER`) has no read that would give one (task 095).
   */
  readonly names?: ReadonlyMap<string, RosterPerson> | null;
}

/** Rebuilds this screen's URL with one value changed. */
function hrefWith(query: InContext<DriverListQuery>, changes: Partial<DriverListQuery>): string {
  const params = new URLSearchParams();
  const merged = { ...query, ...changes };
  if (merged.status) params.set('status', merged.status);
  if (merged.q) params.set('q', merged.q);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const search = params.toString();
  return withContext(query.context, search ? `/drivers?${search}` : '/drivers');
}

const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

function Filters({ query }: { query: InContext<DriverListQuery> }) {
  return (
    <form
      method="get"
      action="/drivers"
      className="flex flex-wrap items-end gap-4"
      aria-label="پالایش فهرست"
    >
      <ContextField context={query.context} />
      <label htmlFor="filter-status" className="flex flex-col gap-1 text-sm text-content-muted">
        وضعیت
        <select
          id="filter-status"
          name="status"
          defaultValue={query.status ?? ''}
          className={CONTROL}
        >
          <option value="">همه</option>
          {driverStatusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="filter-q" className="flex flex-col gap-1 text-sm text-content-muted">
        <span id="filter-q-label">جست‌وجو</span>
        <input
          id="filter-q"
          name="q"
          type="search"
          aria-labelledby="filter-q-label"
          defaultValue={query.q ?? ''}
          placeholder="شمارهٔ پرسنلی یا شمارهٔ گواهینامه"
          className={CONTROL}
        />
      </label>

      <Button type="submit">اعمال</Button>
    </form>
  );
}

function DriverName({ person }: { person: RosterPerson | undefined }) {
  if (!person) {
    // Not in the member list: the person left, or never was a member (a row
    // registered before task 095). Said, not hidden — such a row is still
    // assignable until somebody suspends it.
    return <span className="text-content-muted">در فهرست اعضای این سازمان نیست</span>;
  }
  return (
    <>
      {withoutBidiControls(person.name)}
      <span className="block text-content-muted">
        <Identifier>{withoutBidiControls(person.username)}</Identifier>
      </span>
    </>
  );
}

function DriverRows({
  page,
  query,
  names,
}: {
  page: DriverPage;
  query: InContext<DriverListQuery>;
  names: ReadonlyMap<string, RosterPerson> | null;
}) {
  return (
    <>
      <TableScroll label="فهرست رانندگان این سازمان">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">فهرست رانندگان این سازمان</caption>
          <thead>
            <tr className="border-b border-border text-start text-content-muted">
              {names ? (
                <th scope="col" className="p-3 text-start font-medium">
                  نام
                </th>
              ) : null}
              <th scope="col" className="p-3 text-start font-medium">
                شمارهٔ پرسنلی
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                گواهینامه
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                اعتبار تا
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                وضعیت
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((driver) => (
              <tr key={driver.id} className="border-b border-border">
                {names ? (
                  <td className="p-3">
                    <DriverName person={names.get(driver.userId)} />
                  </td>
                ) : null}
                <td className="p-3">
                  <a
                    href={`/drivers/${encodeURIComponent(driver.id)}`}
                    // `<Identifier>` isolates the run for bidi (L5-06), but its
                    // custom-component children are invisible to the linter's
                    // static accessible-name check — `aria-label` states the
                    // same text explicitly, which is also what a screen reader
                    // should say regardless of the bdi isolation underneath.
                    aria-label={driver.employeeNo ?? driver.userId}
                    className="text-accent-on-surface underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <Identifier>{driver.employeeNo ?? driver.userId}</Identifier>
                  </a>
                </td>
                <td className="p-3 text-content-muted">
                  {driver.licenceNumber ? (
                    <>
                      <Identifier>{driver.licenceNumber}</Identifier>
                      {driver.licenceClass ? (
                        <>
                          {' ('}
                          <Identifier>{driver.licenceClass}</Identifier>
                          {')'}
                        </>
                      ) : (
                        ''
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="p-3 text-content-muted">
                  {driver.licenceValidTo ? formatJalaliDateLong(driver.licenceValidTo) : '—'}
                </td>
                <td className="p-3">
                  <StatusBadge status={driver.status} label={driverStatusLabel(driver.status)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      {page.hasMore && page.nextCursor ? (
        <div className="mt-4 flex justify-start">
          <ButtonLink tone="secondary" href={hrefWith(query, { cursor: page.nextCursor })}>
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </>
  );
}

export function DriversScreen({ result, query, names = null }: DriversScreenProps) {
  const filtered = Boolean(query.status || query.q);

  return (
    <>
      <Section headingId="filters" title="پالایش">
        <Filters query={query} />
      </Section>

      <Section headingId="drivers" title="فهرست">
        {result.kind === 'FORBIDDEN' ? <NoAccessState /> : null}

        {result.kind === 'UNAVAILABLE' ? (
          <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
        ) : null}

        {result.kind === 'MALFORMED' ? (
          <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
        ) : null}

        {result.kind === 'NOT_FOUND' ? (
          <EmptyState title="فهرستی یافت نشد" description="این مسیر در سرویس ناوگان پاسخی نداشت." />
        ) : null}

        {result.kind === 'OK' && result.data.items.length === 0 ? (
          // Two different sentences: one says nobody is registered, the other
          // says this filter matched none of them.
          filtered ? (
            <EmptyState
              title="چیزی با این پالایش پیدا نشد"
              description="پالایه‌ها را بردارید یا عبارت دیگری را جست‌وجو کنید."
              action={<ButtonLink href="/drivers">نمایش همه</ButtonLink>}
            />
          ) : (
            <EmptyState
              title="هنوز راننده‌ای ثبت نشده"
              description="پس از ثبت نخستین راننده، همین‌جا دیده می‌شود."
            />
          )
        ) : null}

        {result.kind === 'OK' && result.data.items.length > 0 ? (
          <DriverRows page={result.data} query={query} names={names} />
        ) : null}
      </Section>
    </>
  );
}
