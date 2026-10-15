import { z } from 'zod';
import { amountMinorSchema, plainText } from '@rasta/contracts';
import { STATEMENT_STATES } from './statement.state-machine';

/**
 * The request and response shapes of the statement API (ADR-068 § 5, CON-003 PR 4).
 *
 * A statement is drafted whole: its lines and the configured deductions it applies, in one strict
 * body. Nothing in it decides who acts, for which side, when, or how much is withheld: the totals
 * and every deduction's amount are computed by the service, once, from the lines and the
 * configured rate (`net = gross − Σ deductions`). Money is a decimal string of minor units.
 */

/** Longest line description; the database keeps the same bound (`ck_statement_line_terms`). */
export const MAX_LINE_DESCRIPTION_LENGTH = 500;
/** Most lines and deductions one statement carries: protection of the service, not a business rule. */
export const MAX_STATEMENT_LINES = 100;
export const MAX_STATEMENT_DEDUCTIONS = 20;

const expectedVersion = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    'The statement’s `version` the caller read. When given, the command applies only to that ' +
      'version (409 OPTIMISTIC_LOCK_FAILED otherwise).',
  );

const line = z
  .object({
    description: plainText()
      .min(1)
      .max(MAX_LINE_DESCRIPTION_LENGTH)
      .describe(
        'What is claimed: trimmed, 1 to 500 characters, without bidirectional control characters.',
      ),
    amountMinor: amountMinorSchema
      .refine((value) => !/^0+$/.test(value), 'A line claims a positive amount')
      .describe(
        'The amount claimed in minor units (rials), a positive decimal string; never a float.',
      ),
  })
  .strict();

const deduction = z
  .object({
    deductionRuleId: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'A deduction rule the employer has configured and keeps in force. Its rate and base come ' +
          'from the rule, never from the request; a rule that is not configured for the employer, ' +
          'or no longer in force, is 422 DEDUCTION_NOT_CONFIGURED (Q-96 (6)).',
      ),
  })
  .strict();

/** `POST /v1/contracts/{id}/statements`: the contractor drafts a statement of a SIGNED contract. */
export const draftStatementSchema = z
  .object({
    lines: z
      .array(line)
      .min(1)
      .max(MAX_STATEMENT_LINES)
      .describe('1 to 100 lines, numbered in the order given. The gross is their sum.'),
    deductions: z
      .array(deduction)
      .max(MAX_STATEMENT_DEDUCTIONS)
      .default([])
      .refine(
        (value) => new Set(value.map((entry) => entry.deductionRuleId)).size === value.length,
        'A deduction rule is applied at most once',
      )
      .describe(
        'The configured deductions this statement applies, each at most once; none by default. ' +
          'With no deduction the net is the gross.',
      ),
  })
  .strict();
export type DraftStatementDto = z.infer<typeof draftStatementSchema>;

/** `POST /v1/contracts/{id}/statements/{statementId}/submit`: the contractor submits a draft. */
export const submitStatementSchema = z.object({ expectedVersion }).strict();
export type SubmitStatementDto = z.infer<typeof submitStatementSchema>;

/** `GET /v1/contracts/{id}/statements`: oldest first, a cursor being the last statement number. */
export const listStatementsQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      // The statement number is a Postgres/Prisma Int: ten digits can overflow it.
      .refine((value) => Number(value) <= 2_147_483_647, 'cursor is out of range')
      .optional()
      .describe('Opaque, server-issued.'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ListStatementsQuery = z.infer<typeof listStatementsQuerySchema>;

const money = (what: string) =>
  z.string().describe(`${what} in minor units (rials), a decimal string.`);

/**
 * A statement as either party sees it: what was claimed, what was withheld and why, the net, and
 * when it was drafted and submitted — never by which person.
 */
export const statementViewSchema = z
  .object({
    id: z.string(),
    contractId: z.string(),
    organizationId: z
      .string()
      .describe('The employer: the tender’s owner and the contract’s tenant.'),
    contractorOrganizationId: z.string(),
    statementNumber: z.number().int().describe('1, 2, 3 … per contract.'),
    status: z.enum(STATEMENT_STATES),
    grossMinor: money('The sum of the lines'),
    deductionsMinor: money('The sum of the deductions'),
    netMinor: money('The gross less the deductions, never negative,'),
    lines: z.array(
      z
        .object({
          lineNumber: z.number().int(),
          description: z.string(),
          amountMinor: money('The amount claimed'),
        })
        .strict(),
    ),
    deductions: z.array(
      z
        .object({
          deductionRuleId: z.string(),
          name: z.string().describe('The rule’s name when the statement was drafted.'),
          rateBp: z.number().int().describe('The rule’s rate in basis points when it was drafted.'),
          base: z.enum(['GROSS']),
          amountMinor: money('The rate of the base, rounded half up,'),
        })
        .strict(),
    ),
    createdAt: z.string(),
    submittedAt: z.string().nullable().describe('When it was submitted (ISO 8601, UTC), or null.'),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .strict();
export type StatementView = z.infer<typeof statementViewSchema>;
