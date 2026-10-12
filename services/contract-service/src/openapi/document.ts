import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import { RETRY_AFTER_MAX_SECONDS, RETRY_AFTER_MIN_SECONDS } from '@rasta/nest-common';
import { ContractController } from '../contract/contract.controller';
import { ContractService } from '../contract/contract.service';
import {
  cancelContractSchema,
  contractViewSchema,
  listContractsQuerySchema,
  signContractSchema,
} from '../contract/dto';
import { AmendmentController } from '../amendment/amendment.controller';
import { AmendmentService } from '../amendment/amendment.service';
import {
  amendmentViewSchema,
  listAmendmentsQuerySchema,
  proposeAmendmentSchema,
  signAmendmentSchema,
} from '../amendment/dto';
import { MilestoneController } from '../milestone/milestone.controller';
import { MilestoneService } from '../milestone/milestone.service';
import { changeMilestoneSchema, milestoneViewSchema, planMilestoneSchema } from '../milestone/dto';
import { PolicyController } from '../policy/policy.controller';
import { PolicyService } from '../policy/policy.service';
import {
  createPolicySchema,
  listPoliciesQuerySchema,
  policyRejectionSchema,
  policyTransitionSchema,
  policyViewSchema,
} from '../policy/dto';
import { IdempotencyStore } from '../shared/idempotency';
import { REFUSAL_REASONS, type RefusalArea } from '../shared/refusal';

/**
 * The published contract of contract-service — **OpenAPI first**.
 *
 * `docs/api/contract-service.openapi.json` is committed, so an API change shows in a PR's
 * diff and a client can be generated without running anything. Three checks keep it honest,
 * the arrangement construction-service made:
 *
 *   - `document.spec.ts` regenerates it from the documentation module below and requires the
 *     committed bytes to match;
 *   - `test/openapi.int-spec.ts` builds it from the **real** `AppModule` — real guards, real
 *     router — and requires the same bytes, so the documentation module cannot drift from the
 *     application;
 *   - the same suite provokes every documented status against the real API.
 *
 * Payload shapes come from the Zod schemas the pipes validate with (`src/contract/dto.ts`),
 * converted by `zod-schema.ts`; Nest supplies paths, methods and parameters from the decorators.
 *
 * Regenerate after changing the API: `pnpm --filter @rasta/contract-service openapi:generate`.
 */

/** Pinned so the committed document is deterministic. */
export const CONTRACT_VERSION = '0.1.0';

const apiErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    details: z.array(z.unknown()).optional(),
  })
  .strict();

const cursorPageOf = (item: z.ZodTypeAny) =>
  z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    })
    .strict();

/** Success responses, each with the status the handler actually answers. */
export const RESPONSE_BODIES: Record<string, { status: '200' | '201'; schema: z.ZodTypeAny }> = {
  'GET /v1/contracts': { status: '200', schema: cursorPageOf(contractViewSchema) },
  'GET /v1/contracts/{id}': { status: '200', schema: contractViewSchema },
  'POST /v1/contracts/{id}/sign': { status: '200', schema: contractViewSchema },
  'POST /v1/contracts/{id}/cancel': { status: '200', schema: contractViewSchema },
  'POST /v1/approval-policies': { status: '201', schema: policyViewSchema },
  'GET /v1/approval-policies': { status: '200', schema: cursorPageOf(policyViewSchema) },
  'GET /v1/approval-policies/pending-platform-approval': {
    status: '200',
    schema: cursorPageOf(policyViewSchema),
  },
  'GET /v1/approval-policies/{id}': { status: '200', schema: policyViewSchema },
  'POST /v1/approval-policies/{id}/submit': { status: '200', schema: policyViewSchema },
  'POST /v1/approval-policies/{id}/approve': { status: '200', schema: policyViewSchema },
  'POST /v1/approval-policies/{id}/reject': { status: '200', schema: policyViewSchema },
  'POST /v1/approval-policies/{id}/retire': { status: '200', schema: policyViewSchema },
  'GET /v1/contracts/{id}/amendments': { status: '200', schema: cursorPageOf(amendmentViewSchema) },
  'GET /v1/contracts/{id}/amendments/{amendmentId}': { status: '200', schema: amendmentViewSchema },
  'POST /v1/contracts/{id}/amendments': { status: '201', schema: amendmentViewSchema },
  'POST /v1/contracts/{id}/amendments/{amendmentId}/sign': {
    status: '200',
    schema: amendmentViewSchema,
  },
  'GET /v1/contracts/{id}/milestones': { status: '200', schema: cursorPageOf(milestoneViewSchema) },
  'GET /v1/contracts/{id}/milestones/{milestoneId}': { status: '200', schema: milestoneViewSchema },
  'POST /v1/contracts/{id}/milestones': { status: '201', schema: milestoneViewSchema },
  'PATCH /v1/contracts/{id}/milestones/{milestoneId}': {
    status: '200',
    schema: milestoneViewSchema,
  },
};

/** Every command takes a strict body. */
const REQUEST_BODIES: Record<string, z.ZodTypeAny> = {
  'POST /v1/contracts/{id}/sign': signContractSchema,
  'POST /v1/contracts/{id}/cancel': cancelContractSchema,
  'POST /v1/approval-policies': createPolicySchema,
  'POST /v1/approval-policies/{id}/submit': policyTransitionSchema,
  'POST /v1/approval-policies/{id}/approve': policyTransitionSchema,
  'POST /v1/approval-policies/{id}/reject': policyRejectionSchema,
  'POST /v1/approval-policies/{id}/retire': policyTransitionSchema,
  'POST /v1/contracts/{id}/amendments': proposeAmendmentSchema,
  'POST /v1/contracts/{id}/amendments/{amendmentId}/sign': signAmendmentSchema,
  'POST /v1/contracts/{id}/milestones': planMilestoneSchema,
  'PATCH /v1/contracts/{id}/milestones/{milestoneId}': changeMilestoneSchema,
};

/** The commands that require an `Idempotency-Key` (docs/06 § 6.8). */
const IDEMPOTENT_COMMANDS: ReadonlySet<string> = new Set([
  'POST /v1/contracts/{id}/sign',
  'POST /v1/contracts/{id}/cancel',
  'POST /v1/approval-policies',
  'POST /v1/contracts/{id}/amendments',
  'POST /v1/contracts/{id}/amendments/{amendmentId}/sign',
  'POST /v1/contracts/{id}/milestones',
  'PATCH /v1/contracts/{id}/milestones/{milestoneId}',
]);

/** The commands that confirm the union's hierarchy with organization-service. */
const HIERARCHY_COMMANDS: ReadonlySet<string> = new Set([
  'POST /v1/approval-policies',
  'POST /v1/approval-policies/{id}/submit',
  'POST /v1/approval-policies/{id}/approve',
  'POST /v1/contracts/{id}/amendments/{amendmentId}/sign',
]);

/**
 * The commands whose refusal of a party for want of authority is an audit record
 * (`CONTRACT_AUTHORITY_REFUSED`): when it cannot be written the answer is 503 and nothing was done.
 */
const AUDITED_COMMANDS: ReadonlySet<string> = new Set([
  'POST /v1/contracts/{id}/amendments',
  'POST /v1/contracts/{id}/amendments/{amendmentId}/sign',
  'POST /v1/contracts/{id}/milestones',
  'PATCH /v1/contracts/{id}/milestones/{milestoneId}',
]);

/** The area whose closed reasons a command's refusals carry in `details[].code` (docs/06 § 6.7). */
const REFUSAL_AREA_OF: Record<string, RefusalArea> = {
  'POST /v1/contracts/{id}/sign': 'signature',
  'POST /v1/contracts/{id}/cancel': 'cancellation',
  'POST /v1/approval-policies': 'policy',
  'POST /v1/contracts/{id}/amendments': 'amendment',
  'POST /v1/contracts/{id}/amendments/{amendmentId}/sign': 'amendment',
  'POST /v1/contracts/{id}/milestones': 'milestone',
  'PATCH /v1/contracts/{id}/milestones/{milestoneId}': 'milestone',
};

/** `Retry-After` on a command's in-flight 409: optional, only that 409 carries it. */
const RETRY_AFTER_HEADER = {
  required: false,
  description:
    'Sent only when this Idempotency-Key is still being processed (CONFLICT): the seconds to ' +
    'wait before retrying with the same key. Absent on every other 409.',
  schema: { type: 'integer', minimum: RETRY_AFTER_MIN_SECONDS, maximum: RETRY_AFTER_MAX_SECONDS },
};

/** One status of a command: `details[]` typed by area, with the closed codes answered with it. */
function refusalErrorSchema(area: RefusalArea, status: number): z.ZodTypeAny | undefined {
  const codes = Object.entries(REFUSAL_REASONS[area])
    .filter(([, answered]) => answered === status)
    .map(([code]) => code);
  if (codes.length === 0) return undefined;
  return apiErrorSchema.extend({
    details: z
      .array(
        z
          .object({
            path: z.literal(area),
            code: z.enum(codes as [string, ...string[]]),
            message: z.string(),
          })
          .strict(),
      )
      .optional(),
  });
}

const REFUSAL_DETAILS_NOTE =
  ' When refused for a closed reason, `details` names it: one entry, `path` the area (signature, ' +
  'cancellation, policy, amendment, milestone) and `code` the reason, one of those listed here. Branch on `code` and ' +
  '`details[].code`, never on `message`. A refusal without a closed reason (a role the ' +
  'configuration does not grant) carries no `details`.';

const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/contracts': listContractsQuerySchema,
  'GET /v1/contracts/{id}/amendments': listAmendmentsQuerySchema,
  'GET /v1/approval-policies': listPoliciesQuerySchema,
  'GET /v1/approval-policies/pending-platform-approval': listPoliciesQuerySchema,
};

export const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The query or body does not match the published schema. Unknown parameters and fields are refused rather than ignored; on a command, a missing or malformed Idempotency-Key is a 400 too.',
  401: 'No credentials, or a token that is expired, unverifiable or issued for another audience.',
  403: 'Authenticated, but not permitted: a role neither the configuration (CONTRACT_READER_ROLES) nor the contractor side grants (INSUFFICIENT_ROLE), the oversight role, a service-to-service token, or a SYSTEM_ADMIN that has not selected an organization with X-Organization-Id. On sign and cancel: a role the employer’s `contract.signature` policy (sign), CONTRACT_CANCEL_ROLES (cancel) or the CONTRACTOR side does not grant, the platform administrator (never, whatever else the token holds), a user token without the platform user id, the contractor cancelling, and the separation of duties — a member of both parties, one person on both sides. On amendments and milestones: only the employer proposes an amendment (PROPOSER_NOT_EMPLOYER) or plans and changes a milestone (EDITOR_NOT_EMPLOYER), with a role CONTRACT_AMENDMENT_ROLES / CONTRACT_MILESTONE_ROLES names; signing an amendment is judged like signing the contract (including POLICY_AUTHOR_NOT_GOVERNING, MEMBER_OF_BOTH_PARTIES and SAME_PERSON_BOTH_SIDES).',
  404: 'Not found — also returned for a contract of which the caller’s organization is neither the employer nor the winning contractor, so its existence is never disclosed.',
  409: 'On sign (of the contract or of an amendment): another person for a side that has already signed (SIDE_ALREADY_SIGNED); on any command, `expectedVersion` that is not the current version (OPTIMISTIC_LOCK_FAILED — reload and retry), an Idempotency-Key reused with a different request or user (IDEMPOTENCY_KEY_REUSED) or still in flight (CONFLICT, with Retry-After).',
  422: 'Well-formed but refused by the lifecycle or by configuration (BUSINESS_RULE_VIOLATION): a contract that is not a draft (CONTRACT_NOT_DRAFT; a SIGNED contract is ended by no route); no `contract.signature` policy in force for the employer, so nobody may sign for it yet (SIGNATURE_POLICY_REQUIRED); two signers whose identities cannot be told apart (ACTOR_IDENTITY_UNKNOWN, fail closed); a cancellation reason outside the configured list (CANCEL_REASON_NOT_ALLOWED) or of a draft a party has signed (SIGNATURE_RECORDED). On amendments: a contract that is not signed (CONTRACT_NOT_SIGNED), an amendment that is no longer proposed (AMENDMENT_NOT_PROPOSED), a zero or negative change (AMENDMENT_DELTA_NOT_POSITIVE — no document allows a reduction, Q-100), a price with its amendments past the largest bigint (AMENDMENT_EXCEEDS_LIMIT), a reason outside the configured list (AMENDMENT_REASON_NOT_ALLOWED). On milestones: a contract that is not signed (CONTRACT_NOT_SIGNED), a milestone a statement refers to (MILESTONE_REFERENCED), a contract at its limit (MILESTONE_LIMIT_REACHED).',
  500: 'Unexpected server error.',
  503: 'On amendment and milestone commands: the refusal of a party for want of authority could not be recorded (UPSTREAM_UNAVAILABLE) and nothing was done — retry the same request; on signing an amendment, also organization-service could not confirm the hierarchy: the signature is refused, never assumed.',
  504: 'organization-service did not answer in time (UPSTREAM_TIMEOUT) while the employer’s signature of an amendment was being confirmed: nothing was signed.',
};

/** The same statuses on the approval-policy routes, which answer for other reasons (Q-70 (7)). */
export const POLICY_ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The query or body does not match the published schema. Unknown parameters and fields are refused rather than ignored; on a create, a missing or malformed Idempotency-Key is a 400 too.',
  401: ERROR_DESCRIPTIONS[401] as string,
  403: 'Authenticated, but not permitted: writing a policy is a UNION_ADMIN for its own organization or one beneath it, or a SYSTEM_ADMIN (an ORGANIZATION_ADMIN never writes its own); approving, rejecting and the platform queue are SYSTEM_ADMIN only, and with CONTRACT_POLICY_FOUR_EYES the approver is neither the author nor the submitter (a union-written policy is never approved by the person who wrote or submitted it); submitting and retiring belong to the organization that wrote the policy. Also: the oversight role, a service-to-service token, a user token without the platform user id where one is required, and a union acting outside its own organization.',
  404: 'Not found — also returned for a policy the caller may not see (neither its author organization, nor a contract reader of the organization it governs, nor a platform administrator).',
  409: 'The `expectedVersion` is not the policy’s current version, or another version of the same policy line was written at the same moment (OPTIMISTIC_LOCK_FAILED / CONFLICT — reload and retry); on a create, an Idempotency-Key reused with a different request or user (IDEMPOTENCY_KEY_REUSED) or still in flight (CONFLICT, with Retry-After).',
  422: 'Well-formed but refused (BUSINESS_RULE_VIOLATION): a transition the lifecycle does not have (DRAFT → PENDING_PLATFORM_APPROVAL → ACTIVE | REJECTED; ACTIVE → RETIRED), a step that names another organization’s role (AUTHORITY_NOT_GOVERNED_ORGANIZATION), or an author or submitter whose identity was not recorded (ACTOR_IDENTITY_UNKNOWN, fail closed).',
  500: 'Unexpected server error.',
  503: 'organization-service could not confirm the hierarchy (UPSTREAM_UNAVAILABLE): the write is refused, never assumed.',
  504: 'organization-service did not answer in time (UPSTREAM_TIMEOUT): the write is refused, never assumed.',
};

const DESCRIPTION =
  'The contract boundary (CON-003, ADR-068). The draft contract that a tender award creates: ' +
  'the system makes it when construction-service publishes TENDER_AWARDED, after reading the ' +
  'award — and its amount, which is on no event — from construction-service itself (ADR-061 ' +
  '§ 4); no user creates one. A contract is read, signed and (while a draft) cancelled by its ' +
  'two parties only: the employer’s organization and the winning contractor’s; anyone else ' +
  'gets 404. Each party signs separately — a recorded acceptance, not a legal signature ' +
  '(Q-95) — and the contract is SIGNED only when both have; the employer may cancel a draft ' +
  'for a closed reason. Who may sign for the employer is the `contract.signature` approval ' +
  'policy of its own organization (/v1/approval-policies): written by a union or the platform, ' +
  'put in force by a platform administrator who is not its author, and never an environment ' +
  'setting; with none in force nobody signs for the employer (422). Amounts are decimal strings of minor units (rials). ' +
  'A SIGNED contract is amended by its employer (a positive change to the price, with a closed ' +
  'reason code and a text), and the amendment takes effect only when both parties have signed it ' +
  'the way they signed the contract; the employer also plans milestones (a title, a planned day ' +
  'and an optional share in basis points) that both parties read. Statements with their ' +
  'separate technical and financial approvals, and the settlement boundary with ' +
  'economic-service follow (ADR-068 § 9); no money is ever held here.';

/** Builds the finished document for a booted application. */
export function buildContractOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rasta — Contract Service')
      .setDescription(DESCRIPTION)
      .setVersion(CONTRACT_VERSION)
      .addBearerAuth()
      .build(),
  );
  return enrichOpenApiDocument(document);
}

/**
 * The controllers and nothing else, so the generator needs no database, broker or JWKS
 * endpoint and produces the same bytes on every machine.
 */
@Module({
  controllers: [ContractController, AmendmentController, MilestoneController, PolicyController],
  providers: [
    { provide: ContractService, useValue: {} },
    { provide: AmendmentService, useValue: {} },
    { provide: MilestoneService, useValue: {} },
    { provide: PolicyService, useValue: {} },
    { provide: IdempotencyStore, useValue: {} },
  ],
})
class DocumentationModule {}

export async function buildDocumentationApp(): Promise<INestApplication> {
  const app = await NestFactory.create(DocumentationModule, { logger: false });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  return app;
}

export function enrichOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiError = toJsonSchema(apiErrorSchema) as never;

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!isOperation(operation)) continue;

      const key = `${method.toUpperCase()} ${path}`;

      // `addBearerAuth()` declares the scheme; it does not apply it. Without this the
      // contract would describe endpoints anybody can call.
      operation.security ??= [{ bearer: [] }];

      const query = QUERY_SCHEMAS[key];
      const body = REQUEST_BODIES[key];
      operation.parameters = operation.parameters ?? [];
      if (query) {
        operation.parameters = [...operation.parameters, ...toQueryParameters(query)];
      }
      if (body) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: toJsonSchema(body) } },
        };
      }
      const idempotent = IDEMPOTENT_COMMANDS.has(key);
      if (idempotent) {
        // Nest's `@ApiHeader` has no schema; replaced with the truth: required, bounded.
        operation.parameters = operation.parameters.filter(
          (parameter) => !isHeader(parameter, 'idempotency-key'),
        );
        operation.parameters.push({
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description:
            'Required, 8 to 255 characters. The same key with the same body from the same user returns the first response and does nothing again; with a different body or user, 409 IDEMPOTENCY_KEY_REUSED; while the first request is still in flight, 409 CONFLICT with Retry-After. Scoped to the organization, kept for CONTRACT_IDEMPOTENCY_TTL_HOURS (24 by default).',
          schema: { type: 'string', minLength: 8, maxLength: 255 },
        });
      }

      const response = RESPONSE_BODIES[key];
      operation.responses ??= {};
      if (response) {
        // Nest publishes a default `200` for every GET and `201` for every POST; only the status
        // the handler answers is kept.
        delete operation.responses['200'];
        delete operation.responses['201'];
        operation.responses[response.status] = {
          description: 'Success',
          content: { 'application/json': { schema: toJsonSchema(response.schema) } },
        };
      }

      const descriptions = path.startsWith('/v1/approval-policies')
        ? POLICY_ERROR_DESCRIPTIONS
        : ERROR_DESCRIPTIONS;
      for (const [status, description] of Object.entries(descriptions)) {
        // A route with no `{id}` names no existing row, so it cannot answer 404.
        if (status === '404' && !path.includes('{id}')) continue;
        // Only a route with a query or a body can answer 400 (the id is an opaque string).
        if (status === '400' && !query && !body) continue;
        // 409 and 422 are a command's: a read has no state to move and no rule to refuse.
        if ((status === '409' || status === '422') && !body) continue;
        // 503 and 504: only the commands that ask organization-service — and, for 503, the ones
        // whose refusal of a party is an audit record that may fail to be written.
        if (status === '503' && !HIERARCHY_COMMANDS.has(key) && !AUDITED_COMMANDS.has(key))
          continue;
        if (status === '504' && !HIERARCHY_COMMANDS.has(key)) continue;
        operation.responses[status] ??= {
          description,
          ...(status === '409' && idempotent
            ? { headers: { 'Retry-After': RETRY_AFTER_HEADER } }
            : {}),
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        };
      }

      // The closed reasons of a command, as an enum per status.
      const area = REFUSAL_AREA_OF[key];
      if (area) {
        for (const status of [403, 409, 422]) {
          const typed = refusalErrorSchema(area, status);
          if (!typed) continue;
          const existing = operation.responses[String(status)] as { description?: string };
          const listed = Object.entries(REFUSAL_REASONS[area])
            .filter(([, answered]) => answered === status)
            .map(([code]) => code)
            .join(', ');
          operation.responses[String(status)] = {
            ...existing,
            description: `${existing.description ?? ''}${REFUSAL_DETAILS_NOTE} (${area}: ${listed})`,
            content: { 'application/json': { schema: toJsonSchema(typed) } },
          };
        }
      }
    }
  }

  return document;
}

/**
 * The committed file's exact bytes: Prettier over two-space JSON, through the CLI so the
 * repository config applies exactly as `pnpm format:check` sees it.
 */
export function formatDocument(document: OpenAPIObject, filePath: string): string {
  const cli = require.resolve('prettier/bin/prettier.cjs');
  const result = spawnSync(
    process.execPath,
    [cli, '--parser', 'json', '--stdin-filepath', filePath],
    { input: JSON.stringify(document, null, 2), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`prettier failed to format the OpenAPI document: ${result.stderr}`);
  }
  return result.stdout;
}

interface MutableOperation {
  requestBody?: unknown;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
  security?: Record<string, string[]>[];
}

function isHeader(parameter: unknown, name: string): boolean {
  const candidate = parameter as { in?: string; name?: string };
  return candidate.in === 'header' && candidate.name?.toLowerCase() === name;
}

function isOperation(value: unknown): value is MutableOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toQueryParameters(schema: z.ZodTypeAny): unknown[] {
  const shape = objectShapeOf(schema);
  if (!shape) return [];

  return Object.entries(shape).map(([name, member]) => ({
    name,
    in: 'query',
    required: !member.isOptional(),
    schema: toJsonSchema(member),
  }));
}

function objectShapeOf(schema: z.ZodTypeAny): z.ZodRawShape | undefined {
  // JUSTIFIED-ANY: zod's `_def` is untyped across its type-kinds, and the walk
  // below re-checks the kind before reading a field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = schema;

  for (let depth = 0; depth < 10; depth += 1) {
    const typeName = current?._def?.typeName;
    if (typeName === z.ZodFirstPartyTypeKind.ZodObject) {
      return (current as z.ZodObject<z.ZodRawShape>).shape;
    }
    if (
      typeName === z.ZodFirstPartyTypeKind.ZodEffects ||
      typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
      typeName === z.ZodFirstPartyTypeKind.ZodDefault
    ) {
      current =
        typeName === z.ZodFirstPartyTypeKind.ZodEffects
          ? current._def.schema
          : current._def.innerType;
      continue;
    }
    return undefined;
  }

  return undefined;
}
