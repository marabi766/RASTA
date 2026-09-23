import { z } from 'zod';

import { normalizePersianText } from '@/lib/format';
import {
  UPDATE_ORGANIZATION_FIELDS,
  type UpdateOrganizationField,
  type UpdateOrganizationFormValues,
} from '@/lib/organization-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

export type { ReadResult };

/**
 * The organization this session is acting for, and edits to its own profile.
 *
 * Reads follow `assets.ts`; the write follows `usage.ts` and `drivers.ts`.
 * Nothing new is designed here. The one thing worth saying out loud is what
 * this module deliberately cannot do: `:id/move`, `:id/status` and
 * `:id/policies` are `UNION_ADMIN` endpoints, so they are not wrapped at all
 * rather than wrapped and hidden — a function that exists is a function
 * somebody will call.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string().nullable().default(null),
  externalCode: z.string().nullable().default(null),
  type: z.string(),
  status: z.string(),
  parentId: z.string().nullable().default(null),
  path: z.string().nullable().default(null),
  depth: z.number().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `metadata` is not declared, so Zod drops it: free-form, unrendered, and
 *  a React tree is serialized into the page (`docs/07` § 7.3). */
export type Organization = z.infer<typeof organizationSchema>;

export async function fetchOrganization(
  session: WebSession,
  organizationId: string,
): Promise<ReadResult<Organization>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path: `/v1/organizations/${encodeURIComponent(organizationId)}`,
      accessToken: session.accessToken,
    });

    const parsed = organizationSchema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Editing the profile
// ---------------------------------------------------------------------------

export function updateOrganizationFormValues(form: FormData): UpdateOrganizationFormValues {
  const read = (field: UpdateOrganizationField) => {
    const value = form.get(field);
    return typeof value === 'string' ? normalizePersianText(value) : '';
  };

  return {
    name: read('name'),
    shortName: read('shortName'),
    externalCode: read('externalCode'),
  };
}

/**
 * `shortName` and `externalCode` are nullable on the service, so an emptied
 * field means **clear it**, not "leave it alone". `name` has no null: emptying
 * it is a validation error, which is what `.min(1)` says.
 */
export const updateOrganizationFormSchema = z
  .object({
    name: z.string().trim().min(1, 'نام سازمان را وارد کنید').max(200),
    shortName: z
      .string()
      .trim()
      .max(200)
      .transform((value) => (value.length === 0 ? null : value))
      .nullable(),
    externalCode: z
      .string()
      .trim()
      .max(64)
      .transform((value) => (value.length === 0 ? null : value))
      .nullable(),
  })
  .strict();

export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationFormSchema>;

export type ParsedUpdateOrganizationForm =
  | { readonly ok: true; readonly request: UpdateOrganizationRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<UpdateOrganizationField, string>> };

export function parseUpdateOrganizationForm(
  values: UpdateOrganizationFormValues,
): ParsedUpdateOrganizationForm {
  const parsed = updateOrganizationFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };

  const fieldErrors: Partial<Record<UpdateOrganizationField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (
      typeof field === 'string' &&
      (UPDATE_ORGANIZATION_FIELDS as readonly string[]).includes(field)
    ) {
      fieldErrors[field as UpdateOrganizationField] ??= issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

export const UPDATE_ORGANIZATION_FIELD_MAPPING: FieldMapping<UpdateOrganizationField> = {
  paths: {
    name: 'name',
    shortName: 'shortName',
    externalCode: 'externalCode',
  },
  messages: {},
};

export function updateOrganization(
  session: WebSession,
  organizationId: string,
  request: UpdateOrganizationRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<{ id: string }, UpdateOrganizationField>> {
  return writeThroughGateway(session, {
    path: `/v1/organizations/${encodeURIComponent(organizationId)}`,
    method: 'PATCH',
    body: request,
    submissionId,
    schema: z.object({ id: z.string() }),
    mapping: UPDATE_ORGANIZATION_FIELD_MAPPING,
    fetchImpl,
  });
}
