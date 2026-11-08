import { z } from 'zod';

import type { WriteCall } from './write';

/**
 * A type test, compiled by `tsc` (`pnpm typecheck`) and never run: jest matches
 * `*.spec.ts`, and nothing here is executed (Codex review of PR 366, finding 5).
 *
 * Every write requires its submission id — sent as `Idempotency-Key` — unless
 * the call says `idempotency: 'NONE'`. Each `@ts-expect-error` below fails the
 * build if the line under it ever compiles, so the default cannot quietly become
 * optional again.
 */

const schema = z.object({ id: z.string() });
type Call = WriteCall<typeof schema, 'field'>;
const base = { path: '/v1/x', body: {}, schema, mapping: { paths: {} } } as const;

export const keyedByDefault: Call = { ...base, submissionId: 'sub-1' };
export const keyedExplicitly: Call = { ...base, idempotency: 'KEYED', submissionId: 'sub-1' };
export const unkeyedWhenSaid: Call = { ...base, idempotency: 'NONE' };

// @ts-expect-error -- the default mode requires the submission id
export const omittedByDefault: Call = { ...base };

// @ts-expect-error -- saying KEYED does not make the id optional
export const omittedWhenKeyed: Call = { ...base, idempotency: 'KEYED' };

// @ts-expect-error -- NONE sends no key, so it cannot be given one
export const keyedAndUnkeyed: Call = { ...base, idempotency: 'NONE', submissionId: 'sub-1' };
