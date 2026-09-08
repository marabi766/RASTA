/**
 * What it takes to call a capability `LIVE`.
 *
 * A descriptor is not documentation. `assertManifestIntegrity` in
 * `lib/capabilities.ts` refuses a `LIVE` badge whose adapter id is not in the
 * registry, and the registry is built from these objects — so the badge cannot
 * outrun the code that earns it.
 *
 * `routes` is written out because it is the thing a reviewer checks against
 * `services/api-gateway/src/config/routes.ts`, and because a test asserts that
 * every declared route is one the gateway actually resolves.
 */
export interface AdapterDescriptor {
  /** Stable id referenced by `Capability.adapter`. */
  readonly id: string;
  /** The service that owns the data, for the report and the UI footnote. */
  readonly service: string;
  /** Gateway paths this adapter calls, `METHOD /v1/<prefix>...`. */
  readonly routes: readonly string[];
}
