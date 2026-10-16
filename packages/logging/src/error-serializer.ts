import { scrubMessage, TRUNCATED_MESSAGE } from './redaction';

/**
 * Error serialisation for the logger.
 *
 * `pino.stdSerializers.err` copies an error's message, stack and every
 * enumerable property verbatim. A driver error echoing its DSN, or one quoting
 * a request header, therefore reached the log with its credential intact and
 * with no length bound — the `logMethod` hook only sees arguments that are
 * strings. This wraps it: text goes through {@link scrubMessage} (credentials
 * removed, length capped) and extra properties pass only if named below.
 */

/**
 * Own properties of an error that are logged besides `type`, `message`,
 * `stack`, `cause` and `aggregateErrors`. Everything else — a driver's `meta`,
 * a request or response object, a client — is dropped: such values carry
 * request data no key-based rule could name in advance.
 */
export const ERROR_PROPERTY_ALLOWLIST: readonly string[] = [
  'name',
  'code',
  'statusCode',
  'status',
  'errno',
  'syscall',
];

/** How many `cause` links are followed. Deeper ones are dropped. */
export const MAX_ERROR_CAUSE_DEPTH = 3;

/** How many members of an `AggregateError` are logged. */
export const MAX_AGGREGATE_ERRORS = 10;

/** How many stack frame lines are kept. */
export const MAX_STACK_FRAMES = 50;

/**
 * How much of a stack is looked at, in UTF-16 code units; the rest, and the
 * line the cut runs through, is dropped.
 */
export const MAX_STACK_SCAN = 64 * 1024;

const UNSERIALISABLE_ERROR = '[unserialisable error]';

const FRAME_LINE = /^\s+at /;

/** A serialised error, in the field names pino's own serializer uses. */
export interface SerializedError {
  type?: string;
  message?: string;
  stack?: string;
  cause?: unknown;
  aggregateErrors?: unknown[];
  [property: string]: unknown;
}

/**
 * The stack with the message part and every frame line scrubbed. The message
 * part is everything before the first frame line (it may span lines and may
 * itself quote text shaped like a frame); the frames are cut to
 * {@link MAX_STACK_FRAMES} and scrubbed as one block, so each part is capped.
 */
function scrubStack(stack: string): string {
  // Bounded before it is split: a stack is attacker-influenced text of any size.
  // The line the cut runs through is dropped, not scrubbed: a fragment can have
  // lost what marks its secret (a connection string's `@`) and be short enough
  // that nothing downstream knows it was cut (Codex on #290, r5 R5-1).
  const scanned = stack.length > MAX_STACK_SCAN;
  const lines = (scanned ? stack.slice(0, MAX_STACK_SCAN) : stack).split('\n');
  if (scanned) lines[lines.length - 1] = TRUNCATED_MESSAGE;
  let firstFrame = lines.findIndex((line) => FRAME_LINE.test(line));
  if (firstFrame === -1) firstFrame = lines.length;
  const head = scrubMessage(lines.slice(0, firstFrame).join('\n'));
  const frames = lines.slice(firstFrame, firstFrame + MAX_STACK_FRAMES);
  return frames.length === 0 ? head : `${head}\n${scrubMessage(frames.join('\n'))}`;
}

function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    // A throwing getter must not take the log line down with it.
    return undefined;
  }
}

function typeOf(value: object): string {
  const constructor = read(value, 'constructor');
  const constructorName = constructor === null ? undefined : read(Object(constructor), 'name');
  if (typeof constructorName === 'string' && constructorName !== '') return constructorName;
  const name = read(value, 'name');
  return typeof name === 'string' ? name : 'Object';
}

function serialize(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubMessage(value);
  if (typeof value !== 'object' || value === null) {
    // A thrown number, boolean, bigint, symbol, function: no text to leak.
    return typeof value === 'function' || typeof value === 'symbol' ? typeof value : value;
  }

  const out: SerializedError = { type: scrubMessage(typeOf(value)) };

  const message = read(value, 'message');
  if (typeof message === 'string') out.message = scrubMessage(message);
  const stack = read(value, 'stack');
  if (typeof stack === 'string') out.stack = scrubStack(stack);

  for (const key of ERROR_PROPERTY_ALLOWLIST) {
    const property = read(value, key);
    if (typeof property === 'string') out[key] = scrubMessage(property);
    else if (typeof property === 'number' || typeof property === 'boolean') out[key] = property;
  }

  if (depth < MAX_ERROR_CAUSE_DEPTH) {
    const cause = read(value, 'cause');
    if (cause !== undefined && cause !== null) {
      const serialized = serialize(cause, depth + 1);
      out.cause = serialized;
      // Like pino's own serializer (which #261's span tests rely on), the
      // message continues with the cause's: "outer: inner".
      const causeMessage = (serialized as SerializedError | null)?.message;
      if (typeof out.message === 'string' && typeof causeMessage === 'string') {
        out.message = `${out.message}: ${causeMessage}`;
      }
    }

    const members = read(value, 'errors');
    if (Array.isArray(members)) {
      out.aggregateErrors = members
        .slice(0, MAX_AGGREGATE_ERRORS)
        .map((member) => serialize(member, depth + 1));
    }
  }

  return out;
}

/**
 * Replaces `pino.stdSerializers.err`: same field names (`type`, `message`,
 * `stack`, `cause`, `aggregateErrors`, `code`…), but every text is scrubbed
 * and capped, causes and aggregate members are bounded, and properties outside
 * {@link ERROR_PROPERTY_ALLOWLIST} are dropped. A string or any other value
 * thrown in place of an error is handled the same way.
 */
export function scrubbedErrorSerializer(value: unknown): unknown {
  try {
    return serialize(value, 0);
  } catch {
    // A revoked proxy, a hostile `errors` array: log that, never throw.
    return { type: 'Error', message: UNSERIALISABLE_ERROR };
  }
}
