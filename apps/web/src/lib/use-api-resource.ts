'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiFailure, CLIENT_ERROR_CODES } from './api/errors';
import type { GatewayClient } from './api/client';
import { useSession } from './auth/session';

/**
 * One read, with all four of its outcomes.
 *
 * A hook rather than TanStack Query, which docs/16 § 16.1 names for the full
 * application. Caching, optimistic updates and background refetch are worth a
 * dependency once there are writes and shared reads to coordinate; this
 * milestone has neither, and pulling in a cache layer to serve two screens
 * would be building the abstraction before the second use exists.
 *
 * Two behaviours here are not incidental:
 *
 *  - **The active organization is a dependency.** Switching tenants re-runs the
 *    read, and an in-flight request for the previous tenant is aborted so its
 *    response cannot land on the new tenant's screen.
 *  - **Retry keeps the tenant.** `reload()` bumps an epoch and nothing else;
 *    the organization comes from the session on every call, so a retry after a
 *    `503` acts as the same organization the failed request did.
 */

export type ResourceState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly failure: ApiFailure };

export interface Resource<T> {
  readonly state: ResourceState<T>;
  reload(): void;
}

export function useApiResource<T>(
  load: (client: GatewayClient, signal: AbortSignal) => Promise<T>,
  dependencies: readonly unknown[],
): Resource<T> {
  const { api, organizationId } = useSession();
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });

  const reload = useCallback(() => setEpoch((value) => value + 1), []);

  useEffect(() => {
    if (!api) {
      setState({
        status: 'error',
        failure: new ApiFailure({
          code: CLIENT_ERROR_CODES.NO_SESSION,
          status: null,
          correlationId: '—',
        }),
      });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const data = await load(api, controller.signal);
        if (!controller.signal.aborted) setState({ status: 'success', data });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;

        // Anything that is not an `ApiFailure` is a bug in this application,
        // not a response from the platform. Swallowing it into an error card
        // would hide it; it belongs in the error boundary.
        if (!(error instanceof ApiFailure)) throw error;
        setState({ status: 'error', failure: error });
      }
    })();

    return () => controller.abort();
    // `load` is intentionally excluded: callers pass an inline closure, which
    // would be a new reference on every render. `dependencies` is the explicit
    // statement of what the read actually depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, organizationId, epoch, ...dependencies]);

  return { state, reload };
}
