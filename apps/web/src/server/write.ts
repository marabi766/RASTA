import type { z } from 'zod';
import { callGateway, GatewayRequestError, type GatewayProblem } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';

/**
 * Writing through the gateway, and turning every way it can end into
 * something a form can render (ADR-058 § 3, ADR-059 § 3, docs/16 § ۱۶٫۱۱).
 *
 * The read modules established the shape: the gateway and the service decide,
 * the portal renders the outcome. A write has more outcomes than a read, and
 * the one that matters most is the 400/422 — the service saying *which field*
 * is wrong. That has to land back on the field, in the person's language,
 * with the service's own words kept where they are the truth. Nothing here
 * is swallowed into "something went wrong".
 */

/** A field-level problem, keyed by the form's own field name. */
export type FieldErrors<F extends string> = Partial<Record<F, string>>;

export type WriteResult<T, F extends string> =
  | { readonly kind: 'CREATED'; readonly data: T; readonly correlationId: string }
  /** The service refused the content. Field errors where it named a field; a
   *  message for the form where it did not. */
  | {
      readonly kind: 'INVALID';
      readonly fieldErrors: FieldErrors<F>;
      readonly message: string | null;
      readonly correlationId: string;
    }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** The thing written *about* is not visible to this person — the platform's
   *  non-disclosure 404. */
  | { readonly kind: 'NOT_FOUND'; readonly correlationId: string }
  | { readonly kind: 'UNAVAILABLE'; readonly status: number; readonly correlationId: string }
  | { readonly kind: 'MALFORMED'; readonly correlationId: string };

/**
 * How a service's error details map onto a form.
 *
 * `paths` says which request-body path belongs to which field. `messages`
 * translates the service messages this portal knows; a message it does not
 * know is shown as it arrived — visibly foreign, never hidden — because the
 * service's sentence is the truth and a stale dictionary is not.
 */
export interface FieldMapping<F extends string> {
  readonly paths: Readonly<Record<string, F>>;
  readonly messages?: Readonly<Record<string, string>>;
}

export function mapProblemToFields<F extends string>(
  problem: GatewayProblem,
  mapping: FieldMapping<F>,
): { fieldErrors: FieldErrors<F>; message: string | null } {
  const fieldErrors: FieldErrors<F> = {};
  const unplaced: string[] = [];

  for (const detail of problem.details ?? []) {
    const field = mapping.paths[detail.path];
    const text = mapping.messages?.[detail.message] ?? detail.message;
    if (field === undefined) {
      unplaced.push(text);
      continue;
    }
    // First problem per field. A second one on the same field is usually a
    // consequence of the first, and two messages under one input read as noise.
    if (fieldErrors[field] === undefined) fieldErrors[field] = text;
  }

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  if (unplaced.length > 0) return { fieldErrors, message: unplaced.join(' ') };
  if (hasFieldErrors) return { fieldErrors, message: null };
  // No details at all — a business rule, a 422 with only a sentence.
  return { fieldErrors, message: mapping.messages?.[problem.message] ?? problem.message };
}

export interface WriteCall<S extends z.ZodTypeAny, F extends string> {
  readonly path: string;
  readonly body: unknown;
  /** The submission id — sent as `Idempotency-Key`; see `submission.ts`. */
  readonly submissionId: string;
  /** What the created resource must look like; everything else is dropped. */
  readonly schema: S;
  readonly mapping: FieldMapping<F>;
  /**
   * `POST` unless stated otherwise. An update is a `PATCH` and a status
   * change is often a `POST` sub-resource, so this is a per-call choice
   * rather than a fact about the module — `usage-records`, the first caller,
   * never had to say it.
   */
  readonly method?: 'POST' | 'PATCH' | 'PUT';
  /** For tests. The real thing is the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export async function writeThroughGateway<S extends z.ZodTypeAny, F extends string>(
  session: WebSession,
  call: WriteCall<S, F>,
): Promise<WriteResult<z.infer<S>, F>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path: call.path,
      method: call.method ?? 'POST',
      body: call.body,
      accessToken: session.accessToken,
      idempotencyKey: call.submissionId,
      fetchImpl: call.fetchImpl,
    });

    const parsed = call.schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'CREATED', data: parsed.data, correlationId: response.correlationId };
  } catch (error) {
    if (!(error instanceof GatewayRequestError)) throw error;

    const { status, correlationId, problem } = error;
    if (status === 403) return { kind: 'FORBIDDEN', correlationId };
    if (status === 404) return { kind: 'NOT_FOUND', correlationId };
    if ((status === 400 || status === 422 || status === 409) && problem) {
      return { kind: 'INVALID', correlationId, ...mapProblemToFields(problem, call.mapping) };
    }
    return { kind: 'UNAVAILABLE', status, correlationId };
  }
}
