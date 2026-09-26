import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { PROGRESS_STATES } from './progress.state-machine';

/**
 * Progress reports at the boundary (`docs/03`: percentage, materials,
 * machinery, labour, obstacles; Q-72). The percentage is carried in basis
 * points — an integer from 0 to 10000 — never as a float (AGENTS.md § 3).
 */

const expectedVersion = z.number().int().min(1).max(2_147_483_647);
const note = z.string().trim().min(1).max(2000);

export const MAX_ASSETS_PER_REPORT = 100;

export const createProgressSchema = z
  .object({
    progressBasisPoints: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .describe('Progress in basis points: 10000 is 100%. docs/03 «درصد پیشرفت».'),
    materials: note.optional(),
    machinery: note.optional(),
    labor: note.optional(),
    obstacles: note.optional(),
    /** Asset identifiers as reported; stored, never resolved against fleet. */
    assetsUsed: z.array(z.string().trim().min(1).max(64)).max(MAX_ASSETS_PER_REPORT).default([]),
  })
  .strict()
  .refine((value) => new Set(value.assetsUsed).size === value.assetsUsed.length, {
    message: 'The same asset may be listed only once',
    path: ['assetsUsed'],
  });
export type CreateProgressDto = z.infer<typeof createProgressSchema>;

export const progressTransitionSchema = z.object({ expectedVersion }).strict();
export type ProgressTransitionDto = z.infer<typeof progressTransitionSchema>;

export const listProgressQuerySchema = cursorPaginationSchema
  .extend({ status: z.enum(PROGRESS_STATES).optional() })
  .strict();
export type ListProgressQuery = z.infer<typeof listProgressQuerySchema>;

export const progressViewSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    progressBasisPoints: z.number().int(),
    materials: z.string().nullable(),
    machinery: z.string().nullable(),
    labor: z.string().nullable(),
    obstacles: z.string().nullable(),
    assetsUsed: z.array(z.string()),
    status: z.enum(PROGRESS_STATES),
    createdAt: z.string(),
    createdBy: z.string(),
    submittedAt: z.string().nullable(),
    submittedBy: z.string().nullable(),
    discardedAt: z.string().nullable(),
    discardedBy: z.string().nullable(),
    version: z.number().int(),
  })
  .strict();
export type ProgressView = z.infer<typeof progressViewSchema>;
