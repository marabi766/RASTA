import { Module, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import { ProjectController } from '../project/project.controller';
import { ProjectService } from '../project/project.service';
import { NeedService } from '../project/need.service';
import { ProjectLifecycleController } from '../project/lifecycle.controller';
import { ExecutionService } from '../project/execution.service';
import { PolicyController } from '../approval/policy.controller';
import { ApprovalController } from '../approval/approval.controller';
import { PolicyService } from '../approval/policy.service';
import { ApprovalService } from '../approval/approval.service';
import { ProgressService } from '../progress/progress.service';
import {
  approvalViewSchema,
  createPolicySchema,
  decisionSchema,
  inboxQuerySchema,
  listPoliciesQuerySchema,
  policyRejectionSchema,
  policyTransitionSchema,
  policyViewSchema,
  projectApprovalsQuerySchema,
  projectCommandSchema,
} from '../approval/dto';
import {
  createProgressSchema,
  listProgressQuerySchema,
  progressTransitionSchema,
  progressViewSchema,
} from '../progress/dto';
import {
  cancelProjectSchema,
  createNeedSchema,
  createProjectSchema,
  listNeedsQuerySchema,
  listProjectsQuerySchema,
  needViewSchema,
  projectSummaryViewSchema,
  projectViewSchema,
  submitNeedSchema,
  updateNeedSchema,
  updateProjectSchema,
  withdrawNeedSchema,
} from '../project/dto';

/**
 * The published contract of construction-service — **OpenAPI first**.
 *
 * `docs/api/construction-service.openapi.json` is committed, so an API change
 * shows in a PR's diff and a client can be generated without running anything.
 * Three checks keep it honest, the arrangement notification-service made:
 *
 *   - `document.spec.ts` regenerates it from the documentation module below
 *     and requires the committed bytes to match;
 *   - `test/openapi.int-spec.ts` builds it from the **real** `AppModule` —
 *     real guards, real router — and requires the same bytes, so the
 *     documentation module cannot drift from the application;
 *   - the same suite provokes every documented status against the real API.
 *
 * Payload shapes come from the Zod schemas the pipes validate with
 * (`src/project/dto.ts`), converted by `zod-schema.ts`; Nest supplies paths,
 * methods and parameters from the decorators.
 *
 * Regenerate after changing the API: `pnpm --filter @rasta/construction-service openapi:generate`.
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

/**
 * Success responses, each with the status the handler actually answers,
 * written beside the schema rather than derived from the method: the two
 * creations answer `201`, everything else `200`.
 */
export const RESPONSE_BODIES: Record<string, { status: '200' | '201'; schema: z.ZodTypeAny }> = {
  'POST /v1/projects': { status: '201', schema: projectViewSchema },
  'GET /v1/projects': { status: '200', schema: cursorPageOf(projectSummaryViewSchema) },
  'GET /v1/projects/{id}': { status: '200', schema: projectViewSchema },
  'PATCH /v1/projects/{id}': { status: '200', schema: projectViewSchema },
  'POST /v1/projects/{id}/cancel': { status: '200', schema: projectViewSchema },
  'POST /v1/projects/{id}/needs': { status: '201', schema: needViewSchema },
  'GET /v1/projects/{id}/needs': { status: '200', schema: cursorPageOf(needViewSchema) },
  'PATCH /v1/projects/{id}/needs/{needId}': { status: '200', schema: needViewSchema },
  'POST /v1/projects/{id}/needs/{needId}/submit': { status: '200', schema: needViewSchema },
  'POST /v1/projects/{id}/needs/{needId}/withdraw': { status: '200', schema: needViewSchema },
  'POST /v1/projects/{id}/approvals': { status: '200', schema: projectViewSchema },
  'GET /v1/projects/{id}/approvals': { status: '200', schema: z.array(approvalViewSchema) },
  'POST /v1/projects/{id}/start': { status: '200', schema: projectViewSchema },
  'POST /v1/projects/{id}/complete': { status: '200', schema: projectViewSchema },
  'POST /v1/projects/{id}/progress': { status: '201', schema: progressViewSchema },
  'GET /v1/projects/{id}/progress': { status: '200', schema: cursorPageOf(progressViewSchema) },
  'POST /v1/projects/{id}/progress/{reportId}/submit': {
    status: '200',
    schema: progressViewSchema,
  },
  'POST /v1/projects/{id}/progress/{reportId}/discard': {
    status: '200',
    schema: progressViewSchema,
  },
  'POST /v1/approval-policies': { status: '201', schema: policyViewSchema },
  'GET /v1/approval-policies': { status: '200', schema: cursorPageOf(policyViewSchema) },
  'GET /v1/approval-policies/{id}': { status: '200', schema: policyViewSchema },
  'GET /v1/approval-policies/pending-platform-approval': {
    status: '200',
    schema: cursorPageOf(policyViewSchema),
  },
  'POST /v1/approval-policies/{id}/submit': { status: '200', schema: policyViewSchema },
  'POST /v1/approval-policies/{id}/approve': { status: '200', schema: policyViewSchema },
  'POST /v1/approval-policies/{id}/reject': { status: '200', schema: policyViewSchema },
  'POST /v1/approval-policies/{id}/retire': { status: '200', schema: policyViewSchema },
  'GET /v1/approvals': { status: '200', schema: cursorPageOf(approvalViewSchema) },
  'GET /v1/approvals/{id}': { status: '200', schema: approvalViewSchema },
  'POST /v1/approvals/{id}/decision': { status: '200', schema: approvalViewSchema },
};

const REQUEST_BODIES: Record<string, z.ZodTypeAny> = {
  'POST /v1/projects': createProjectSchema,
  'PATCH /v1/projects/{id}': updateProjectSchema,
  'POST /v1/projects/{id}/cancel': cancelProjectSchema,
  'POST /v1/projects/{id}/needs': createNeedSchema,
  'PATCH /v1/projects/{id}/needs/{needId}': updateNeedSchema,
  'POST /v1/projects/{id}/needs/{needId}/submit': submitNeedSchema,
  'POST /v1/projects/{id}/needs/{needId}/withdraw': withdrawNeedSchema,
  'POST /v1/projects/{id}/approvals': projectCommandSchema,
  'POST /v1/projects/{id}/start': projectCommandSchema,
  'POST /v1/projects/{id}/complete': projectCommandSchema,
  'POST /v1/projects/{id}/progress': createProgressSchema,
  'POST /v1/projects/{id}/progress/{reportId}/submit': progressTransitionSchema,
  'POST /v1/projects/{id}/progress/{reportId}/discard': progressTransitionSchema,
  'POST /v1/approval-policies': createPolicySchema,
  'POST /v1/approval-policies/{id}/submit': policyTransitionSchema,
  'POST /v1/approval-policies/{id}/approve': policyTransitionSchema,
  'POST /v1/approval-policies/{id}/reject': policyRejectionSchema,
  'POST /v1/approval-policies/{id}/retire': policyTransitionSchema,
  'POST /v1/approvals/{id}/decision': decisionSchema,
};

const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/projects': listProjectsQuerySchema,
  'GET /v1/projects/{id}/needs': listNeedsQuerySchema,
  'GET /v1/projects/{id}/approvals': projectApprovalsQuerySchema,
  'GET /v1/projects/{id}/progress': listProgressQuerySchema,
  'GET /v1/approval-policies': listPoliciesQuerySchema,
  'GET /v1/approval-policies/pending-platform-approval': listPoliciesQuerySchema,
  'GET /v1/approvals': inboxQuerySchema,
};

/** The four create endpoints that accept an optional `Idempotency-Key`. */
const IDEMPOTENT = new Set([
  'POST /v1/projects',
  'POST /v1/projects/{id}/needs',
  'POST /v1/projects/{id}/progress',
  'POST /v1/approval-policies',
]);

/** Operations that act on an existing row and so can lose a compare-and-set. */
const VERSIONED = new Set([
  'PATCH /v1/projects/{id}',
  'POST /v1/projects/{id}/cancel',
  'PATCH /v1/projects/{id}/needs/{needId}',
  'POST /v1/projects/{id}/needs/{needId}/submit',
  'POST /v1/projects/{id}/needs/{needId}/withdraw',
  'POST /v1/projects/{id}/approvals',
  'POST /v1/projects/{id}/start',
  'POST /v1/projects/{id}/complete',
  'POST /v1/projects/{id}/progress/{reportId}/submit',
  'POST /v1/projects/{id}/progress/{reportId}/discard',
  'POST /v1/approval-policies/{id}/submit',
  'POST /v1/approval-policies/{id}/approve',
  'POST /v1/approval-policies/{id}/reject',
  'POST /v1/approval-policies/{id}/retire',
  'POST /v1/approvals/{id}/decision',
]);

/** Commands with no version that can still be refused by the lifecycle (422). */
const LIFECYCLE_CREATES = new Set([
  'POST /v1/projects/{id}/needs',
  'POST /v1/projects/{id}/progress',
]);

/**
 * Operations that ask organization-service whether the target organization is
 * within the author's union (Q-70 (7)): when a policy is written, submitted
 * and approved, and again when a union-written policy is used to open an
 * approval round. An unconfirmable answer refuses them.
 */
const HIERARCHY_CHECKED = new Set([
  'POST /v1/approval-policies',
  'POST /v1/approval-policies/{id}/submit',
  'POST /v1/approval-policies/{id}/approve',
  'POST /v1/projects/{id}/approvals',
  'POST /v1/projects/{id}/complete',
]);

/** A create that can lose a race on a unique key (409 CONFLICT, retry). */
const RACING_CREATES = new Set(['POST /v1/approval-policies']);

export const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The request does not match the published schema. Unknown fields are refused rather than ignored, so `organizationId`, `status` or an actor field in a body is a 400. Also: an operationType outside a configured CONSTRUCTION_OPERATION_TYPES list, and an operating area PostGIS considers invalid.',
  401: 'No credentials, or a token that is expired, unverifiable or issued for another audience.',
  403: 'Authenticated, but not permitted: a role the configuration does not grant (INSUFFICIENT_ROLE), the oversight role, a service-to-service token, a SYSTEM_ADMIN that has not selected an organization with X-Organization-Id, on a decision, a caller who can see the project but is not the authority the approval names; on an approval policy, an author who is not a union or platform administrator, a union writing for an organization not beneath it, a caller other than the author organization submitting or retiring it, a non-SYSTEM_ADMIN approving or rejecting it, or the person who wrote or submitted it approving it (four eyes; a union-written policy always); on requesting approval or completing, a union-written policy in force whose union no longer governs the organization (re-confirmed at use).',
  404: 'Not found — also returned for a project, need, progress report, policy or approval that belongs to another organization (and, for an approval, whose authority the caller is not), so its existence is never disclosed.',
  409: 'Conflict: `expectedVersion` is not the current version (OPTIMISTIC_LOCK_FAILED — reload and retry), an Idempotency-Key reused with a different request (IDEMPOTENCY_KEY_REUSED) or still in flight (CONFLICT), two policy versions created at once (CONFLICT — retry), or the policy in force changed while an approval round was being opened (OPTIMISTIC_LOCK_FAILED — retry).',
  422: 'Well-formed but refused by the lifecycle (BUSINESS_RULE_VIOLATION): a transition the state machine does not have; requesting approval with no active policy or no step for the estimate (the platform never approves by default) or without the configured preconditions; deciding a step that is not PENDING; starting when a contract is required; completing below 100% progress; progress that goes down; progress outside IN_PROGRESS.',
  500: 'Unexpected server error.',
  503: 'organization-service could not confirm the union hierarchy (UPSTREAM_UNAVAILABLE); the policy write, or the approval round a union-written policy would open, is refused — never assumed (Q-70 (7), fail closed).',
  504: 'organization-service did not answer in time (UPSTREAM_TIMEOUT); the policy write, or the approval round, is refused.',
};

const DESCRIPTION =
  'Civil-works projects (CON-001): drafting with needs, configurable approvals, execution, ' +
  'progress reports and completion. Approval authorities come from approval_policy rows the ' +
  'union writes and the platform administrator approves (Q-70 (7)) — an (organization, role) ' +
  'per step, in order, by estimate ' +
  'range — never from code, and the platform never creates an authority or approves by ' +
  'default: no policy, no applicable step, silence or a timeout is a refusal, and only the ' +
  'authority a step names may decide it (ADR-023, ADR-063). Every change is a compare-and-set ' +
  'on `version` and publishes its event on rasta.construction.v1 in the same transaction. ' +
  'Project fields, roles, preconditions, start and completion rules, and progress rules are ' +
  'provisional answers to docs/24 Q-68 to Q-73, each configurable. Every read and write is ' +
  'confined to the organization the request acts for, except that an authority of another ' +
  'organization sees and decides the steps addressed to it.';

/** Builds the finished document for a booted application. */
export function buildConstructionOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rasta — Construction Service')
      .setDescription(DESCRIPTION)
      .setVersion(CONTRACT_VERSION)
      .addBearerAuth()
      .build(),
  );
  return enrichOpenApiDocument(document);
}

/**
 * The controllers and nothing else, so the generator needs no database,
 * broker or JWKS endpoint and produces the same bytes on every machine.
 */
@Module({
  controllers: [
    ProjectController,
    ProjectLifecycleController,
    PolicyController,
    ApprovalController,
  ],
  providers: [
    { provide: ProjectService, useValue: {} },
    { provide: NeedService, useValue: {} },
    { provide: ExecutionService, useValue: {} },
    { provide: PolicyService, useValue: {} },
    { provide: ApprovalService, useValue: {} },
    { provide: ProgressService, useValue: {} },
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

      // `addBearerAuth()` declares the scheme; it does not apply it. Without
      // this the contract would describe endpoints anybody can call.
      operation.security ??= [{ bearer: [] }];

      // The header is read with `@Headers`, which Nest documents as a required
      // parameter with no schema. Replaced with the truth: optional, bounded.
      operation.parameters = (operation.parameters ?? []).filter(
        (parameter) => !isHeader(parameter, 'idempotency-key'),
      );
      if (IDEMPOTENT.has(key)) {
        operation.parameters.push({
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description:
            'Optional. The same key with the same body returns the first response; with a different body, 409 IDEMPOTENCY_KEY_REUSED. Kept for CONSTRUCTION_IDEMPOTENCY_TTL_HOURS (24 by default).',
          schema: toJsonSchema(z.string().min(1).max(255)),
        });
      }

      const query = QUERY_SCHEMAS[key];
      if (query) {
        operation.parameters = [...operation.parameters, ...toQueryParameters(query)];
      }

      const body = REQUEST_BODIES[key];
      if (body) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: toJsonSchema(body) } },
        };
      }

      const response = RESPONSE_BODIES[key];
      operation.responses ??= {};
      if (response) {
        // Nest publishes a default `201` for every POST and `200` for every
        // GET; only the status the handler answers is kept.
        delete operation.responses['200'];
        delete operation.responses['201'];
        operation.responses[response.status] = {
          description: 'Success',
          content: { 'application/json': { schema: toJsonSchema(response.schema) } },
        };
      }

      for (const [status, description] of Object.entries(ERROR_DESCRIPTIONS)) {
        // A route with no `{id}` names no existing row, so it cannot answer 404.
        if (status === '404' && !path.includes('{id}')) continue;
        if (
          status === '409' &&
          !VERSIONED.has(key) &&
          !IDEMPOTENT.has(key) &&
          !RACING_CREATES.has(key)
        ) {
          continue;
        }
        if (status === '422' && !VERSIONED.has(key) && !LIFECYCLE_CREATES.has(key)) continue;
        if ((status === '503' || status === '504') && !HIERARCHY_CHECKED.has(key)) continue;
        operation.responses[status] ??= {
          description,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        };
      }
    }
  }

  return document;
}

/**
 * The committed file's exact bytes: Prettier over two-space JSON, through the
 * CLI so the repository config applies exactly as `pnpm format:check` sees it.
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

function isOperation(value: unknown): value is MutableOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHeader(value: unknown, name: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { in?: unknown }).in === 'header' &&
    String((value as { name?: unknown }).name).toLowerCase() === name
  );
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
