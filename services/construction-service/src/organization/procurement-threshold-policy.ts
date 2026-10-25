import { internalFetch } from '@rasta/nest-common';
import { Inject, Injectable } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext } from '@rasta/nest-common';
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
    const token = await this.tokens.issue(
      SERVICE_NAME,
      ORGANIZATION_SERVICE,
      'SERVICE',
      organizationId,
    );
    const timeoutMs = this.env.CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await internalFetch(
        `${this.env.ORGANIZATION_SERVICE_URL.replace(/\/+$/, '')}/v1/organizations/${encodeURIComponent(organizationId)}/procurement-thresholds`,
        {
          headers: {
            accept: 'application/json',
            'x-internal-token': token,
            'x-correlation-id': getContext().correlationId,
          },
          signal: controller.signal,
        },
      );
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
    } catch (error) {
      if (error instanceof RastaError) throw error;
      if (controller.signal.aborted)
        throw RastaError.upstreamTimeout(ORGANIZATION_SERVICE, timeoutMs);
      throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
    } finally {
      clearTimeout(timer);
    }
  }
}
