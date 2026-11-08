import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MAX_CONTENT_BYTES } from '@rasta/sealing';
import type { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authoredFiles } = require('../../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (
    dir: string,
    options?: { skip?: (name: string) => boolean; optional?: boolean },
  ) => string[];
};

import { largestQuotationBody } from '../../test/quotation-body';
import { cancelAggregationSchema, submitDemandSchema, withdrawDemandSchema } from '../demand/dto';
import {
  QUOTATION_BODY_MAX_BYTES,
  putQuotationSchema,
  withdrawQuotationSchema,
} from '../quotation/dto';
import { cancelRfqSchema, issueRfqSchema } from '../rfq/dto';
import { recordAggregationSettingSchema } from '../setting/dto';
import { JSON_BODY_LIMIT_BYTES } from './body-parser';

/** The heaviest character for JSON: U+0001 is `\u0001`, six bytes for one character. */
const HEAVY = '\u0001';
const heavy = (length: number) => `x${HEAVY.repeat(length - 2)}x`;
const REASON = heavy(500);
/** The longest identifier `organizationIdSchema` takes: a seed id of 48 characters. */
const organizationId = (index: number) => `ORG-${String(index).padStart(48, '0')}`;

/** Every command body at the bound of each of its fields, by the schema's name. */
const LARGEST: Record<string, { schema: z.ZodType; body: unknown; accepted: boolean }> = {
  submitDemandSchema: {
    schema: submitDemandSchema,
    body: {
      productId: `PRD_${'A'.repeat(26)}`,
      quantity: 2_147_483_647,
      note: heavy(500),
    },
    accepted: true,
  },
  withdrawDemandSchema: {
    schema: withdrawDemandSchema,
    body: { expectedVersion: Number.MAX_SAFE_INTEGER, reason: REASON },
    accepted: true,
  },
  cancelAggregationSchema: {
    schema: cancelAggregationSchema,
    body: { expectedVersion: Number.MAX_SAFE_INTEGER, reason: REASON },
    accepted: true,
  },
  recordAggregationSettingSchema: {
    schema: recordAggregationSettingSchema,
    body: {
      windowHours: 8760,
      minQuantity: 2_147_483_647,
      shortfallPolicy: 'EXTEND',
      expectedCurrentVersion: Number.MAX_SAFE_INTEGER,
    },
    accepted: true,
  },
  issueRfqSchema: {
    schema: issueRfqSchema,
    body: {
      expectedVersion: Number.MAX_SAFE_INTEGER,
      procurementNature: 'INQUIRY',
      quotationClosingAt: '2031-03-01T08:00:00.000Z',
      criteria: Array.from({ length: 50 }, (_, index) => ({
        code: `C${String(index).padStart(49, '0')}`,
        label: heavy(200),
        weightBp: 200,
        scoringMethod: 'MANUAL_SCORE',
        maxScore: 1_000_000,
      })),
      invitedSupplierOrganizationIds: Array.from({ length: 500 }, (_, i) => organizationId(i)),
    },
    accepted: true,
  },
  cancelRfqSchema: {
    schema: cancelRfqSchema,
    body: {
      expectedVersion: Number.MAX_SAFE_INTEGER,
      reasonCode: `A${'B'.repeat(63)}`,
      reason: REASON,
    },
    accepted: true,
  },
  // Within every field's bound, above the budget: the parser must let the schema say so. Persian:
  // heavier text can pass the parser's limit, which is the documented 413 (quotation.int-spec.ts).
  putQuotationSchema: {
    schema: putQuotationSchema,
    body: largestQuotationBody('ب'),
    accepted: false,
  },
  withdrawQuotationSchema: {
    schema: withdrawQuotationSchema,
    body: { expectedRevision: 2_147_483_647 },
    accepted: true,
  },
};

const sources = (directory: string): string[] =>
  authoredFiles(directory).filter(
    (path) => basename(path).endsWith('.ts') && !basename(path).endsWith('.spec.ts'),
  );

const SRC = join(__dirname, '..');

describe('the JSON parser limit against every command body (PR-605 r1 F1)', () => {
  it.each(Object.entries(LARGEST))('%s, at every field bound, fits it', (_, largest) => {
    const parsed = largest.schema.safeParse(largest.body);
    expect(parsed.success).toBe(largest.accepted);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.code)).toEqual(['too_big']);
    }
    expect(Buffer.byteLength(JSON.stringify(largest.body))).toBeLessThanOrEqual(
      JSON_BODY_LIMIT_BYTES,
    );
  });

  it('is the gateway’s limit and the seal’s, and three budgets fit it', () => {
    const gateway = readFileSync(join(SRC, '../../api-gateway/src/main.ts'), 'utf8');
    expect(gateway).toContain("app.useBodyParser('json', { limit: '256kb' });");
    expect(JSON_BODY_LIMIT_BYTES).toBe(256 * 1024);
    expect(JSON_BODY_LIMIT_BYTES).toBe(MAX_CONTENT_BYTES);
    expect(3 * QUOTATION_BODY_MAX_BYTES).toBeLessThanOrEqual(JSON_BODY_LIMIT_BYTES);
  });

  it('covers every body a controller validates: a new command must be added above', () => {
    const named = sources(SRC)
      .filter((path) => path.endsWith('.controller.ts'))
      .flatMap((path) =>
        [...readFileSync(path, 'utf8').matchAll(/@Body\(zodPipe\((\w+)\)\)/g)].map(
          (match) => match[1]!,
        ),
      );
    expect(named.sort()).toEqual(Object.keys(LARGEST).sort());
  });

  it('is configured in one place, which main.ts and the harness call', () => {
    const parsers = sources(SRC).filter((path) =>
      readFileSync(path, 'utf8').includes('.useBodyParser('),
    );
    expect(parsers).toEqual([join(SRC, 'shared/body-parser.ts')]);
    for (const path of [join(SRC, 'main.ts'), join(SRC, '../test/api-helpers.ts')]) {
      const source = readFileSync(path, 'utf8');
      expect(source).toMatch(/^\s*useProcurementBodyParser\((app|created)\);$/m);
      expect(source).not.toContain('.useBodyParser(');
    }
  });
});
