import { z } from 'zod';
import { amountMinorSchema, currencySchema, plainText } from '@rasta/contracts';
import { STATEMENT_STATES } from './statement.state-machine';

/**
 * The request and response shapes of the statement API (ADR-068 § 5, CON-003 PR 4 to 6).
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
    milestoneId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'A planned milestone of this contract the line is against, if any. One that is not a ' +
          'milestone of this contract is 422 MILESTONE_NOT_OF_CONTRACT. Submitting the statement ' +
          'marks the milestone referenced, after which the employer can no longer change it ' +
          '(Q-100 (4)).',
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
export const submitStatementSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .optional()
      .describe(
        'The statement’s `version` the caller read. When given, the submission applies only to ' +
          'that version (409 OPTIMISTIC_LOCK_FAILED otherwise).',
      ),
  })
  .strict();
export type SubmitStatementDto = z.infer<typeof submitStatementSchema>;

/**
 * `POST /v1/contracts/{id}/statements/{statementId}/decisions`: a step's authority approves or
 * rejects that step. The step is named — not inferred — so two approvers of one step racing each
 * other never land the second on the next step: the one who comes second is told it was decided.
 */
export const decideStatementSchema = z
  .object({
    chain: z
      .enum(['TECHNICAL', 'FINANCIAL'])
      .describe(
        'The chain of the step decided. The technical chain is open while the statement is ' +
          'SUBMITTED, the financial one once it is TECHNICALLY_APPROVED (Q-96 (2)).',
      ),
    stepOrder: z
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .describe(
        'The step’s `stepOrder` in that chain, as the statement’s `approvalChains` shows it.',
      ),
    decision: z
      .enum(['APPROVE', 'REJECT'])
      .describe(
        'APPROVE records the step approved; the last step of a chain completes it. REJECT rejects ' +
          'the statement, final for its number (Q-96 (7)).',
      ),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .optional()
      .describe(
        'The statement’s `version` the caller read. When given, the decision applies only to ' +
          'that version (409 OPTIMISTIC_LOCK_FAILED otherwise).',
      ),
  })
  .strict();
export type DecideStatementDto = z.infer<typeof decideStatementSchema>;

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

/** One chain as it was snapshotted at submission: the policy in force and its applicable steps. */
const approvalChainView = z
  .object({
    policyId: z.string(),
    policyVersion: z.number().int(),
    steps: z.array(
      z
        .object({
          stepOrder: z.number().int().describe('The policy step’s order; asked in this order.'),
          authorityOrganizationId: z.string(),
          authorityRole: z.string(),
          authorityLabel: z.string(),
          decision: z
            .object({
              outcome: z.enum(['APPROVED', 'REJECTED']),
              decidedAt: z.string().describe('When (ISO 8601, UTC).'),
            })
            .strict()
            .nullable()
            .describe('The step’s decision, or null while undecided — never by which person.'),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * A statement as either party — or an approver its chains name — sees it: what was claimed, what
 * was withheld and why, the net, and when it was drafted, submitted and decided — never by which
 * person.
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
          milestoneId: z.string().nullable().describe('The milestone it is against, or null.'),
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
    approvalChains: z
      .object({ technical: approvalChainView, financial: approvalChainView })
      .strict()
      .nullable()
      .describe(
        'The two approval chains as the policies in force said them when the statement was ' +
          'submitted — technical first, then financial (Q-96 (2)) — or null while it is a draft. ' +
          'A policy changed later never changes them (ADR-068 § 5).',
      ),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .strict();
export type StatementView = z.infer<typeof statementViewSchema>;

/**
 * A statement as economic-service reads it to build its obligation (ADR-068 § 6 (2), CON-003 PR 6a):
 * the stored row only — status, net, currency and who pays whom — whatever its status.
 */
export const statementSettlementViewSchema = z
  .object({
    statementId: z.string(),
    contractId: z.string(),
    status: z
      .enum(STATEMENT_STATES)
      .describe(
        'As stored. Only an APPROVED statement may be settled; the reader refuses the rest.',
      ),
    netMinor: money('The gross less the deductions, never negative,'),
    currency: currencySchema.describe(
      'Rials: nothing on the contract chain stores another currency (Q-73 (2)); said explicitly so no reader assumes one (ADR-022).',
    ),
    payerOrganizationId: z
      .string()
      .describe('The employer: the statement’s organization, the one the token acts for.'),
    beneficiaryOrganizationId: z.string().describe('The contract’s winning contractor.'),
    approvedAt: z
      .string()
      .nullable()
      .describe(
        'When the financial chain’s last step approved it (ISO 8601, UTC); null unless APPROVED.',
      ),
  })
  .strict();
export type StatementSettlementView = z.infer<typeof statementSettlementViewSchema>;
