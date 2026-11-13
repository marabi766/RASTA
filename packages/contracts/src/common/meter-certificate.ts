import { z } from 'zod';

export const METER_CERTIFICATE_LIMIT = 20_000;
const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const quantity = (digits: number) =>
  z
    .string()
    .regex(new RegExp(`^\\d{1,${digits}}(\\.\\d{1,2})?$`))
    .nullable();
export const meterCertificateQuerySchema = z.object({ assetId: identifier }).strict();
export const meterCertificateFactSchema = z
  .object({
    id: identifier,
    organizationId: z.string().min(1).max(64),
    periodStart: z.iso.datetime({ offset: true }),
    periodEnd: z.iso.datetime({ offset: true }),
    hours: quantity(8),
    kilometres: quantity(10),
    hourMeter: quantity(10),
    odometer: quantity(10),
  })
  .strict()
  .refine((r) => new Date(r.periodStart) < new Date(r.periodEnd));
export const meterCertificateSchema = z
  .object({
    version: z.literal(1),
    assetId: identifier,
    snapshot: z
      .string()
      .max(1_000_000)
      .regex(/^\d+:\d+:(\d+(,\d+)*)?$/),
    facts: z.array(meterCertificateFactSchema).max(METER_CERTIFICATE_LIMIT),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((c) => new Set(c.facts.map((f) => f.id)).size === c.facts.length);
export type MeterCertificate = z.infer<typeof meterCertificateSchema>;
export type MeterCertificateFact = z.infer<typeof meterCertificateFactSchema>;

/** Wire canonicalization only. Null deltas mean zero; null readings remain absent. */
export function canonicalMeterCertificate(c: Omit<MeterCertificate, 'digest'>): string {
  const decimal = (s: string | null): string | null => {
    if (s === null) return null;
    const [whole, fraction = ''] = s.split('.');
    return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
  };
  return JSON.stringify([
    c.version,
    c.assetId,
    c.snapshot,
    [...c.facts]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((f) => [
        f.id,
        f.organizationId,
        new Date(f.periodStart).toISOString(),
        new Date(f.periodEnd).toISOString(),
        decimal(f.hours ?? '0'),
        decimal(f.kilometres ?? '0'),
        decimal(f.hourMeter),
        decimal(f.odometer),
      ]),
  ]);
}
