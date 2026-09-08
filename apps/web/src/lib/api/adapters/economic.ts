import { z } from 'zod';
import type { AdapterDescriptor } from '../adapter';
import type { ApiClient } from '../client';

/**
 * Payment-provider disclosure from `economic-service`.
 *
 * ADR-024 requires the simulated nature of MVP payments to be visible «در کد،
 * UI، مستند، Demo یا ارائه», and `GET /v1/wallets/provider` exists so a client
 * can state it without guessing. That is why this is an API call and not a
 * constant: a hard-coded «حالت نمایشی» becomes a lie the day a real provider
 * is configured, and the service's own contract suite asserts the inverse —
 * a live provider must stop repeating the simulated notice.
 *
 * Nothing here moves money, and nothing in this milestone does. The endpoint is
 * a `GET`, so the gateway's `Idempotency-Key` requirement on the `wallets`
 * prefix does not apply to it (it covers unsafe methods only).
 *
 * Route roles are `SYSTEM_ADMIN`, `UNION_ADMIN`, `ORGANIZATION_ADMIN`
 * (`wallet.controller.ts`), so a `PROCUREMENT_USER` gets `403` here. The UI
 * renders that as a "no access" state rather than an error — being refused is
 * the correct outcome for that role, not a fault.
 */

export const ECONOMIC_PAYMENT_PROVIDER_ADAPTER = {
  id: 'economic.paymentProvider',
  service: 'economic-service',
  routes: ['GET /v1/wallets/provider'],
} as const satisfies AdapterDescriptor;

/** Mirrors `PaymentService.describeProvider()`. */
export const paymentProviderSchema = z.object({
  provider: z.string(),
  /** `true` while `MockPaymentProvider` is configured. No bank connection exists. */
  simulated: z.boolean(),
  notice: z.string(),
});

export type PaymentProviderDisclosure = z.infer<typeof paymentProviderSchema>;

export async function fetchPaymentProvider(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<PaymentProviderDisclosure> {
  const result = await client.request({
    path: '/v1/wallets/provider',
    schema: paymentProviderSchema,
    signal,
  });

  return result.data;
}
