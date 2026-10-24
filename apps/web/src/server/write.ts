import type { z } from 'zod';
import {
  callGateway,
  GatewayNeverSentError,
  GatewayOutcomeUnknownError,
  GatewayRequestError,
  type GatewayProblem,
} from './gateway';
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
  | {
      readonly kind: 'FORBIDDEN';
      readonly correlationId: string;
      /**
       * The closed reasons the refusal named in `details[].code` (docs/06
       * § 6.7), present only when it named any — a separation-of-duties
       * refusal, for one, which a form says in its own fixed words. Never the
       * service's sentence.
       */
      readonly reasons?: readonly string[];
    }
  /** The thing written *about* is not visible to this person — the platform's
   *  non-disclosure 404. */
  | { readonly kind: 'NOT_FOUND'; readonly correlationId: string }
  /**
   * Refused before it could act: nothing was written. `neverSent` is set when
   * the request provably never left this portal (connection refused, DNS …):
   * unlike a 503 the platform answered, which may follow a commit, that one is
   * known not to have reached anything — a write need not remember it as
   * unresolved.
   */
  | {
      readonly kind: 'UNAVAILABLE';
      readonly status: number;
      readonly correlationId: string;
      readonly neverSent?: true;
      /**
       * The owning service refused because the replay deadline this write carried is behind its own
       * clock (`409 REPLAY_WINDOW_CLOSED`, PM decision D-065). A proven refusal of THIS attempt: nothing
       * was written by it. It says nothing about an earlier attempt under the same key.
       */
      readonly replayWindowClosed?: true;
    }
  /**
   * Sent, and possibly committed, but not confirmed (Codex post-merge review
   * of #106): the connection failed after dispatch, this portal's deadline
   * passed, the gateway's own upstream timed out (504), or a 2xx came back
   * that could not be read or did not look like the resource. A form must
   * not say nothing changed — a retry could apply the change twice.
   */
  | { readonly kind: 'UNKNOWN_OUTCOME'; readonly correlationId: string }
  /**
   * Another request with this submission id is still being processed (round
   * 1 on PR 171): the service answered `409 CONFLICT` **with** `Retry-After`.
   * Nothing is wrong with the form, and the first request's outcome is not
   * known yet — sending the same form again after the wait answers it (the
   * same id replays the first request's result). A `409` without
   * `Retry-After` is a conflict waiting will not change, and stays `INVALID`.
   */
  | {
      readonly kind: 'IN_PROGRESS';
      readonly retryAfterSeconds: number;
      readonly correlationId: string;
    };

/**
 * The longest wait a form holds its button for, whatever `Retry-After` says:
 * the platform sends one second, and a wrong header must not lock a form.
 */
export const MAX_IN_PROGRESS_WAIT_SECONDS = 30;

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
  /**
   * Sentences that carry a value — an id, a count — matched whole, after
   * `messages` and before `byCode`. For a service whose refusals differ only
   * in their sentence (every business rule is the same code), so the portal
   * can say which rule in its own words; each pattern is pinned against the
   * service's source by a contract spec, and the sentence is never shown.
   */
  readonly patterns?: readonly (readonly [RegExp, string])[];
  /**
   * What is said for a sentence `messages` does not know, keyed by the
   * platform error code of the response (`INVALID_STATE_TRANSITION`, …). The
   * code is the part of an error body a client may rely on; the sentence is
   * not. A code with no entry keeps the old rule: the sentence is shown as it
   * arrived.
   */
  readonly byCode?: Readonly<Record<string, string>>;
  /**
   * What is said for a **detail** that carries its own closed `code`
   * (`details[].code`), keyed by that code. Preferred over the sentence: a
   * code is part of the API and a sentence is not, so the wording here cannot
   * be broken by the service rewording its English (`OPEN_ASSIGNMENT`, …).
   */
  readonly byDetailCode?: Readonly<Record<string, string>>;
  /**
   * Said for anything the tables above do not cover. When set, the service's
   * own sentence is never rendered: a form whose text could echo a stranger's
   * characters (a bidi control in a detail) keeps the list closed.
   */
  readonly fallback?: string;
}

export function mapProblemToFields<F extends string>(
  problem: GatewayProblem,
  mapping: FieldMapping<F>,
): { fieldErrors: FieldErrors<F>; message: string | null } {
  const fieldErrors: FieldErrors<F> = {};
  const unplaced: string[] = [];
  const textOf = (message: string): string =>
    mapping.messages?.[message] ??
    mapping.patterns?.find(([pattern]) => pattern.test(message))?.[1] ??
    mapping.byCode?.[problem.code] ??
    mapping.fallback ??
    message;

  for (const detail of problem.details ?? []) {
    const field = mapping.paths[detail.path];
    const text =
      (detail.code !== undefined ? mapping.byDetailCode?.[detail.code] : undefined) ??
      textOf(detail.message);
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
  return { fieldErrors, message: textOf(problem.message) };
}

export interface WriteCall<S extends z.ZodTypeAny, F extends string> {
  readonly path: string;
  readonly body: unknown;
  /**
   * The submission id — sent as `Idempotency-Key`; see `submission.ts`. Left out
   * for a service that takes no key (supplier-service's six writes): sending one
   * would suggest a retry is safe, and it is not.
   */
  readonly submissionId?: string;
  /** The last instant this write may be executed under its key (needs `submissionId`); see `GatewayCall.replayDeadline`. */
  readonly replayDeadline?: number;
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
      replayDeadline: call.replayDeadline,
      fetchImpl: call.fetchImpl,
    });

    const parsed = call.schema.safeParse(response.data);
    // A 2xx: the write happened, but its answer is not one this portal can
    // show — so it cannot be confirmed either.
    if (!parsed.success) return { kind: 'UNKNOWN_OUTCOME', correlationId: response.correlationId };
    return { kind: 'CREATED', data: parsed.data, correlationId: response.correlationId };
  } catch (error) {
    if (!(error instanceof GatewayRequestError)) throw error;

    const { status, correlationId, problem } = error;
    if (error instanceof GatewayOutcomeUnknownError)
      return { kind: 'UNKNOWN_OUTCOME', correlationId };
    // UPSTREAM_TIMEOUT: the gateway forwarded the write and gave up waiting —
    // the same unknown, one hop further on.
    if (status === 504) return { kind: 'UNKNOWN_OUTCOME', correlationId };
    if (status === 409 && problem?.code === 'CONFLICT' && error.retryAfterSeconds !== null) {
      return {
        kind: 'IN_PROGRESS',
        retryAfterSeconds: Math.min(
          Math.max(error.retryAfterSeconds, 1),
          MAX_IN_PROGRESS_WAIT_SECONDS,
        ),
        correlationId,
      };
    }
    // Before the generic 409 below, which would turn it into a message on a field.
    if (status === 409 && problem?.code === 'REPLAY_WINDOW_CLOSED') {
      return { kind: 'UNAVAILABLE', status, correlationId, replayWindowClosed: true };
    }
    if (status === 403) {
      const reasons = (problem?.details ?? []).flatMap((detail) =>
        detail.code !== undefined ? [detail.code] : [],
      );
      return { kind: 'FORBIDDEN', correlationId, ...(reasons.length > 0 ? { reasons } : {}) };
    }
    if (status === 404) return { kind: 'NOT_FOUND', correlationId };
    if ((status === 400 || status === 422 || status === 409) && problem) {
      return { kind: 'INVALID', correlationId, ...mapProblemToFields(problem, call.mapping) };
    }
    if (error instanceof GatewayNeverSentError) {
      return { kind: 'UNAVAILABLE', status, correlationId, neverSent: true };
    }
    return { kind: 'UNAVAILABLE', status, correlationId };
  }
}
