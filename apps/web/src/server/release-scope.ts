import type { UnresolvedScope } from './unresolved-request';

/**
 * Which held request a release acts on, as a thing only `server/` can make (FU-253/254, review 2 F1).
 * `settleRelease` (`release-feedback.ts`) takes one of these and calls the store's release itself, so an
 * action in `app/` has no way to release a hold without the shared tail (CSRF → consent → store →
 * signed outcome): it holds a scope, never the primitive. The class check is for a forged value
 * (`{ scope } as ReleaseScope`); `release-settlement-guard.ts` refuses any import of this module from
 * `app/` and `lib/`.
 */
export class ReleaseScope {
  private constructor(readonly scope: UnresolvedScope) {}

  static of(scope: UnresolvedScope): ReleaseScope {
    return new ReleaseScope(scope);
  }
}
