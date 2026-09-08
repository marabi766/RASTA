'use client';

import * as Select from '@radix-ui/react-select';
import { useEffect, useState, type ReactNode } from 'react';
import {
  listVisibleOrganizations,
  membershipOptions,
  type MembershipOption,
} from '@/lib/api/adapters/organization';
import { ApiFailure } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';

/**
 * Choosing which organization every subsequent request acts as.
 *
 * The options come from the intersection of two different facts, and the order
 * of precedence is the whole point:
 *
 *  - the **token's `org_ids` claim** decides *which* organizations may appear.
 *    It is signed, the gateway validates `X-Organization-Id` against the same
 *    claim (ADR-035), and it is available before any network call.
 *  - `GET /v1/organizations` supplies **names only**. It answers "visible to
 *    you", which includes a whole subtree the user may read but must not act
 *    as, so it can never add an option.
 *
 * That is why a directory failure degrades to raw ids instead of an error
 * state: the switcher still works, it is just less readable. Losing the ability
 * to pick a tenant because a name lookup failed would be the wrong trade.
 *
 * Radix's `Select` is here for the keyboard and screen-reader behaviour — typeahead,
 * arrow navigation, `aria-activedescendant`, focus return on close — which is a
 * lot of correctness to reimplement for a control this central (docs/16 § 16.9).
 */
export function OrganizationSwitcher(): ReactNode {
  const { claims, organizationId, selectOrganization, api } = useSession();
  const [options, setOptions] = useState<MembershipOption[]>([]);
  const [namesResolved, setNamesResolved] = useState(false);

  const memberships = claims?.organizationIds ?? [];
  const membershipKey = memberships.join(',');

  useEffect(() => {
    const ids = membershipKey ? membershipKey.split(',') : [];
    // Ids first, so the control is usable before the directory answers.
    setOptions(membershipOptions(ids, []));
    setNamesResolved(false);

    if (!api || ids.length === 0) return;

    const controller = new AbortController();

    void (async () => {
      try {
        const directory = await listVisibleOrganizations(api, controller.signal);
        if (controller.signal.aborted) return;
        setOptions(membershipOptions(ids, directory));
        setNamesResolved(true);
      } catch (error) {
        // A name lookup is decoration. Whatever went wrong — 403 for this
        // role, the service down, the tenant not yet selected — the switcher
        // keeps working on ids.
        if (!(error instanceof ApiFailure)) throw error;
      }
    })();

    return () => controller.abort();
  }, [api, membershipKey]);

  if (memberships.length === 0) {
    return (
      <p className="text-xs text-[var(--tx3)]">
        توکن شما هیچ عضویت سازمانی اعلام نکرده است. برای دسترسی به دادهٔ سازمانی، عضویت باید در
        سرویس هویت ثبت شود.
      </p>
    );
  }

  const selected = options.find((option) => option.organizationId === organizationId);

  return (
    <div className="flex items-center gap-2">
      {/* Not a <label>: the control is Radix's Select trigger, a button that
          takes its accessible name from `aria-labelledby`. A <label> pointing
          at a button is invalid HTML and screen readers treat it inconsistently. */}
      <span id="org-switcher-label" className="text-xs font-semibold text-[var(--tx3)]">
        سازمان فعال
      </span>

      <Select.Root
        value={organizationId ?? undefined}
        onValueChange={(next) => {
          selectOrganization(next);
        }}
      >
        <Select.Trigger
          aria-labelledby="org-switcher-label"
          className="inline-flex min-h-[var(--tap)] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--control-border)] bg-[var(--surf)] px-3 text-sm text-[var(--tx)] hover:bg-[var(--sunken)]"
        >
          <Select.Value placeholder="انتخاب کنید…">
            {selected ? (selected.name ?? shortId(selected.organizationId)) : undefined}
          </Select.Value>
          <Select.Icon aria-hidden="true">▾</Select.Icon>
        </Select.Trigger>

        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={6}
            className="z-50 overflow-hidden rounded-[var(--radius-md)] border border-[var(--bd)] bg-[var(--surf)] shadow-[var(--sh2)]"
          >
            <Select.Viewport className="p-1">
              {options.map((option) => (
                <Select.Item
                  key={option.organizationId}
                  value={option.organizationId}
                  className="flex min-h-[var(--tap)] cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] px-3 text-sm text-[var(--tx)] outline-none data-[highlighted]:bg-[var(--pri-soft)] data-[highlighted]:text-[var(--pri-tx)]"
                >
                  <Select.ItemText>{option.name ?? shortId(option.organizationId)}</Select.ItemText>
                  {option.name === null && namesResolved ? (
                    <span className="text-xs text-[var(--tx3)]">(نام در دسترس نیست)</span>
                  ) : null}
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

/** Enough of an id to tell two apart without filling the top bar. */
function shortId(organizationId: string): string {
  return organizationId.length > 14 ? `${organizationId.slice(0, 12)}…` : organizationId;
}
