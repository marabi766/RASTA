import { InternalHttpClient } from '@rasta/nest-common';
import { Inject, Injectable } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext, upstreamExchange } from '@rasta/nest-common';
import { z } from 'zod';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { ORGANIZATION_SERVICE, readCapped } from './organization-directory';
import {
  procurementThresholdsSchema,
  type ThresholdPolicy,
} from '../tender/procurement-thresholds';

const MAX_POLICY_RESPONSE_BYTES = 32_768;
const responseSchema = z
  .object({
    organizationId: z.string(),
    policy: z
      .object({ id: z.string().min(1), value: procurementThresholdsSchema })
      .strict()
      .nullable(),
  })
  .strict();

/** Reads one effective governance key, before taking any construction row lock. No cache. */
@Injectable()
export class ProcurementThresholdPolicy {
  constructor(
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  async get(organizationId: string): Promise<ThresholdPolicy | null> {
    const sender = await new InternalHttpClient(this.tokens).authorize({
      from: SERVICE_NAME,
      to: ORGANIZATION_SERVICE,
      purpose: 'SERVICE',
      organizationId,
    });
    const timeoutMs = this.env.CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS;
    return upstreamExchange(
      ORGANIZATION_SERVICE,
      timeoutMs,
      (signal) =>
        sender.send(
          `${this.env.ORGANIZATION_SERVICE_URL.replace(/\/+$/, '')}/v1/organizations/${encodeURIComponent(organizationId)}/procurement-thresholds`,
          {
            headers: {
              accept: 'application/json',
              'x-correlation-id': getContext().correlationId,
            },
            signal,
          },
        ),
      async (response) => {
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
        }
        const text = await readCapped(response, MAX_POLICY_RESPONSE_BYTES);
        const parsed = responseSchema.safeParse(text === null ? null : JSON.parse(text));
        if (!parsed.success || parsed.data.organizationId !== organizationId) {
          throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
        }
        return parsed.data.policy;
      },
    );
  }
}
