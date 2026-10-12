import { z } from 'zod';
import { plainText } from '@rasta/contracts';

/**
 * The request and response shapes of the milestone API (ADR-068 § 9, CON-003 PR 3).
 *
 * A planned milestone is a title, a planned **day** and an optional planned share. The day is a
 * calendar date (`YYYY-MM-DD`), never an instant: a plan says "by this day", and an instant would
 * pretend to a time zone and an hour nobody chose.
 */

/** Longest title; the database keeps the same bound (`ck_milestone_title`). */
export const MAX_MILESTONE_TITLE_LENGTH = 200;
/** A planned share is 1 to 10000 basis points (`ck_milestone_share`). */
export const MAX_PLANNED_SHARE_BP = 10_000;

/**
 * A calendar date, `YYYY-MM-DD`, that exists (no 31 February) in the years 1000 to 9999 — a
 * technical bound, so no two-digit year is read as 19xx and nothing is out of range for the
 * database's `date`.
 */
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD')
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (year < 1000) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'Not a calendar date');

const title = plainText()
  .min(1)
  .max(MAX_MILESTONE_TITLE_LENGTH)
  .describe('Trimmed, 1 to 200 characters, without bidirectional control characters.');

const plannedDate = calendarDate.describe(
  'The planned day, YYYY-MM-DD — a date, never an instant.',
);

const plannedShareBp = z
  .number()
  .int()
  .min(1)
  .max(MAX_PLANNED_SHARE_BP)
  .describe(
    'The planned share of the contract price in basis points (1 to 10000). Optional; no sum ' +
      'across a contract’s milestones is kept, because no document defines one.',
  );

const expectedVersion = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    'The milestone’s `version` the caller read. When given, the edit applies only to that ' +
      'version (409 OPTIMISTIC_LOCK_FAILED otherwise).',
  );

/** `POST /v1/contracts/{id}/milestones`: the employer plans a milestone. */
export const planMilestoneSchema = z
  .object({ title, plannedDate, plannedShareBp: plannedShareBp.optional() })
  .strict();
export type PlanMilestoneDto = z.infer<typeof planMilestoneSchema>;

/**
 * `PATCH /v1/contracts/{id}/milestones/{milestoneId}`: edits what is given, and leaves the rest.
 * `plannedShareBp: null` clears the share. At least one field is changed.
 */
export const changeMilestoneSchema = z
  .object({
    title: title.optional(),
    plannedDate: plannedDate.optional(),
    plannedShareBp: plannedShareBp.nullable().optional(),
    expectedVersion,
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.plannedDate !== undefined ||
      value.plannedShareBp !== undefined,
    'Name at least one field to change',
  );
export type ChangeMilestoneDto = z.infer<typeof changeMilestoneSchema>;

/** A milestone as either party sees it. */
export const milestoneViewSchema = z
  .object({
    id: z.string(),
    contractId: z.string(),
    organizationId: z
      .string()
      .describe('The employer: the tender’s owner and the contract’s tenant.'),
    title: z.string(),
    plannedDate: z.string().describe('The planned day, YYYY-MM-DD.'),
    plannedShareBp: z.number().int().nullable(),
    referenced: z
      .boolean()
      .describe('True once a statement refers to it: from then on it never changes.'),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .strict();
export type MilestoneView = z.infer<typeof milestoneViewSchema>;
