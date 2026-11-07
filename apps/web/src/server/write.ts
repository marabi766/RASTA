import { createHash } from 'node:crypto';
import { ERROR_STATUS, UNSUPPORTED_CHARACTERS } from '@rasta/contracts';
import type { z } from 'zod';

import { toPersianDigits } from '@/lib/format';
import {
  callGateway,
  GatewayNeverSentError,
  GatewayOutcomeUnknownError,
  GatewayRequestError,
  type GatewayProblem,
} from './gateway';
import { tenantCredential } from './session-organization';
import { webServerEnv } from './env';
import { inheritUnconfirmed } from './unconfirmed-retry';
import type { WebSession } from './session';
import { ownValue, ownText } from '@/lib/own-key';

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
   * The write **provably did nothing** in this attempt (FU-189, PR-880 F2;
   * checklist A1) — the one answer a form may render as "nothing changed":
   *
   *   - a refusal the platform proved ({@link isProvenRefusal}: a documented
   *     `4xx` code answered with its own status) that no kind above names —
   *     `429 RATE_LIMIT_EXCEEDED`, `401`, `409 REPLAY_WINDOW_CLOSED` …;
   *   - `neverSent`: the request provably never left this portal (connection
   *     refused, DNS …), so it reached nothing.
   *
   * Never a `5xx` the platform answered: a post-commit read can fail, and an
   * upstream reset after the commit surfaces as `503`, so every such answer is
   * `UNKNOWN_OUTCOME` — decided here, once, for every caller, so a caller that
   * maps this kind to "failed, you can resend" is right by construction
   * (`write-classifier.guard.spec.ts` holds every gateway write to this writer).
   */
  | {
      readonly kind: 'UNAVAILABLE';
      readonly status: number;
      readonly correlationId: string;
      /**
       * The platform error `code` (docs/06 § 6.7) of the proven refusal; absent on `neverSent`.
       */
      readonly code?: string;
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
 * Whether a `4xx` answer **proves** that this attempt wrote nothing (PR-830 r1
 * F1, checklist A1): its body parsed as the platform's error, and its `code` is
 * one of the platform's documented codes answered with that code's own status
 * (`ERROR_STATUS`, the one table every service's exception filter answers by).
 * Everything else — no body, a body that is not the platform's error (a
 * proxy's or load balancer's page), a code the platform does not document, or
 * a documented code under another status — proves nothing about the write and
 * is `UNKNOWN_OUTCOME`, never "nothing changed". One rule for every write, so
 * no caller can reach a refusal state on weaker evidence.
 */
export function isProvenRefusal(status: number, code: string | undefined | null): boolean {
  if (status < 400 || status >= 500 || typeof code !== 'string') return false;
  return ownValue(ERROR_STATUS, code) === status;
}

/**
 * How a service's error details map onto a form.
 *
 * `paths` says which request-body path belongs to which field. `messages`
 * translates the service messages this portal knows. A message it does not
 * know is **never** shown: the service's sentence is English, may carry an
 * internal ticket number («open question Q-110») and may echo what the person
 * typed, so the form says {@link GENERIC_REFUSAL_MESSAGE} (or the mapping's own
 * `fallback`) instead, and a sanitised diagnostic is logged
 * ({@link reportUnmappedMessage}) so the gap is found without the text leaking.
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
   * Said for anything the tables above do not cover, in place of
   * {@link GENERIC_REFUSAL_MESSAGE}: a form that can say something more
   * specific than the generic sentence. Either way the service's own sentence
   * is never rendered.
   */
  readonly fallback?: string;
}

/**
 * What a form says for a refusal it has no sentence for (and no `fallback` of
 * its own). Persian, closed, names nothing: the reader is told the request was
 * not accepted and what to do; the correlation id on the page finds the rest.
 */
export const GENERIC_REFUSAL_MESSAGE =
  'درخواست پذیرفته نشد. اطلاعات واردشده را بررسی کنید، صفحه را تازه کنید و دوباره تلاش کنید.';

/**
 * Closed messages that more than one service emits and that mean the same
 * thing everywhere, so no module has to remember to list them.
 * `UNSUPPORTED_CHARACTERS` is the shared text rule's one refusal
 * (`@rasta/contracts`).
 */
const COMMON_MESSAGES: Readonly<Record<string, string>> = {
  [UNSUPPORTED_CHARACTERS]:
    'نویسه‌ی غیرمجاز دارد؛ حروف فارسی و لاتین، رقم و نشانه‌های معمول (مانند «،» و «؛») مجازند',
  'Name contains unsupported characters':
    'نام نویسه‌ی غیرمجاز دارد؛ حروف فارسی و لاتین، فاصله و نیم‌فاصله مجازند',
};

/**
 * Zod's own default sentences, which a service's validation pipe passes through
 * when a DTO field has no message of its own («String must contain at most 200
 * character(s)»). Closed wording with a number at most, so each has a Persian
 * rendering that repeats nothing the person typed.
 */
const COMMON_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpMatchArray) => string]> = [
  [
    /^String must contain at least (\d+) character\(s\)$/,
    (m) => `این متن دست‌کم ${toPersianDigits(m[1]!)} نویسه باشد`,
  ],
  [
    /^String must contain at most (\d+) character\(s\)$/,
    (m) => `این متن حداکثر ${toPersianDigits(m[1]!)} نویسه باشد`,
  ],
  [/^Required$/, () => 'این فیلد لازم است'],
  [/^Invalid enum value\b/, () => 'مقدار انتخاب‌شده معتبر نیست'],
  [/^Invalid$/, () => 'مقدار واردشده معتبر نیست'],
  [/^Expected \w+, received \w+$/, () => 'مقدار واردشده معتبر نیست'],
];

/**
 * Logs that a service sentence had no Persian rendering — and nothing of the
 * sentence itself (AGENTS.md S-09: an unmapped message may echo input).
 * Status, closed error code, request-body path (a field name, not a value), the
 * sentence's length and a short SHA-256 prefix: enough to count how often the
 * same gap occurs and to grep a mapping table for it, not enough to read it.
 */
export function reportUnmappedMessage(args: {
  readonly status: number | undefined;
  readonly code: string;
  readonly path: string | null;
  readonly message: string;
}): void {
  console.error(
    JSON.stringify({
      event: 'web.unmapped_service_message',
      status: args.status ?? null,
      code: args.code,
      path: args.path,
      messageLength: args.message.length,
      messageSha256: createHash('sha256').update(args.message).digest('hex').slice(0, 16),
    }),
  );
}

function commonPatternText(message: string): string | undefined {
  for (const [pattern, say] of COMMON_PATTERNS) {
    const match = message.match(pattern);
    if (match) return say(match);
  }
  return undefined;
}

export function mapProblemToFields<F extends string>(
  problem: GatewayProblem,
  mapping: FieldMapping<F>,
  status?: number,
): { fieldErrors: FieldErrors<F>; message: string | null } {
  const fieldErrors: FieldErrors<F> = {};
  const unplaced: string[] = [];
  const textOf = (message: string, path: string | null): string => {
    const known =
      ownText(mapping.messages, message) ??
      mapping.patterns?.find(([pattern]) => pattern.test(message))?.[1] ??
      ownText(COMMON_MESSAGES, message) ??
      commonPatternText(message) ??
      ownText(mapping.byCode, problem.code);
    if (known !== undefined) return known;
    // Nothing maps this sentence: say the generic one, never the service's.
    reportUnmappedMessage({ status, code: problem.code, path, message });
    return mapping.fallback ?? GENERIC_REFUSAL_MESSAGE;
  };

  for (const detail of problem.details ?? []) {
    const field = ownValue(mapping.paths, detail.path);
    const text = ownText(mapping.byDetailCode, detail.code) ?? textOf(detail.message, detail.path);
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
  return { fieldErrors, message: textOf(problem.message, null) };
}

interface WriteCallBase<S extends z.ZodTypeAny, F extends string> {
  readonly path: string;
  readonly body: unknown;
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

/**
 * The default, and the shape every write takes unless it says otherwise: the
 * submission id is **required** and sent as `Idempotency-Key` (see
 * `submission.ts`), so a resend replays rather than repeats.
 */
interface KeyedWriteCall<S extends z.ZodTypeAny, F extends string> extends WriteCallBase<S, F> {
  readonly idempotency?: 'KEYED';
  /** The submission id — sent as `Idempotency-Key`; see `submission.ts`. */
  readonly submissionId: string;
  /** The last instant this write may be executed under its key; see `GatewayCall.replayDeadline`. */
  readonly replayDeadline?: number;
}

/**
 * The one exception, stated at the call: an endpoint that takes no key
 * (supplier-service's six writes). No key is sent — sending one would suggest a
 * resend is safe, and it is not — and the caller owns what an ambiguous answer
 * means. `submissionId` cannot be given here, so a key cannot be half-wired.
 */
interface UnkeyedWriteCall<S extends z.ZodTypeAny, F extends string> extends WriteCallBase<S, F> {
  readonly idempotency: 'NONE';
  readonly submissionId?: never;
  /** A deadline belongs to a key; with none sent there is nothing to bound. */
  readonly replayDeadline?: never;
}

/**
 * A write. Leaving out `submissionId` does not compile unless the call says
 * `idempotency: 'NONE'` (`write.type-spec.ts` proves both directions; Codex
 * review of PR 366, finding 5).
 */
export type WriteCall<S extends z.ZodTypeAny, F extends string> =
  KeyedWriteCall<S, F> | UnkeyedWriteCall<S, F>;

export async function writeThroughGateway<S extends z.ZodTypeAny, F extends string>(
  session: WebSession,
  call: WriteCall<S, F>,
): Promise<WriteResult<z.infer<S>, F>> {
  // Sent while retrying a send whose outcome is unknown: only a success or "in
  // progress" is about that send; every other answer is about this attempt only
  // (`unconfirmed-retry.ts`, FU-173).
  return inheritUnconfirmed(await dispatchWrite(session, call));
}

async function dispatchWrite<S extends z.ZodTypeAny, F extends string>(
  session: WebSession,
  call: WriteCall<S, F>,
): Promise<WriteResult<z.infer<S>, F>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path: call.path,
      method: call.method ?? 'POST',
      body: call.body,
      credential: tenantCredential(session),
      idempotencyKey: call.idempotency === 'NONE' ? undefined : call.submissionId,
      replayDeadline: call.idempotency === 'NONE' ? undefined : call.replayDeadline,
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
    // No byte left this portal: known, and known to have done nothing.
    if (error instanceof GatewayNeverSentError) {
      return { kind: 'UNAVAILABLE', status, correlationId, neverSent: true };
    }
    // The request reached the platform. Before any status is mapped to a
    // refusal, everything that does not PROVE this attempt wrote nothing is
    // unconfirmed (PR-830 r1 F1, FU-189): a bodyless 403/404, an unknown or
    // mismatched code — and every `5xx`, whose body is never read: a 500 from a
    // read after the commit, a 502/503 from a reset after it, a 504
    // (UPSTREAM_TIMEOUT: the gateway forwarded it and gave up waiting). Below
    // this line every answer is a `4xx` carrying a documented code.
    if (!isProvenRefusal(status, problem?.code)) {
      return { kind: 'UNKNOWN_OUTCOME', correlationId };
    }
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
      return {
        kind: 'UNAVAILABLE',
        status,
        correlationId,
        code: problem.code,
        replayWindowClosed: true,
      };
    }
    if (status === 403) {
      const reasons = (problem?.details ?? []).flatMap((detail) =>
        detail.code !== undefined ? [detail.code] : [],
      );
      return { kind: 'FORBIDDEN', correlationId, ...(reasons.length > 0 ? { reasons } : {}) };
    }
    if (status === 404) return { kind: 'NOT_FOUND', correlationId };
    if ((status === 400 || status === 422 || status === 409) && problem) {
      return {
        kind: 'INVALID',
        correlationId,
        ...mapProblemToFields(problem, call.mapping, status),
      };
    }
    return {
      kind: 'UNAVAILABLE',
      status,
      correlationId,
      ...(problem ? { code: problem.code } : {}),
    };
  }
}
