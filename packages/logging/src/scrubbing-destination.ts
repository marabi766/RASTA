import type { DestinationStream } from 'pino';
import { scrubMessage } from './redaction';

/**
 * The last point before a log line leaves the process.
 *
 * Whatever built the line — pino's interpolation, a serializer, a child
 * binding, a mixin, a plain object field — the exact string pino is about to
 * write passes through here. Every string in it (keys and values) is scrubbed
 * of credentials and capped, and a line that is too long is not written at all.
 * Nothing is parsed into values, so numbers (bigint included) are untouched.
 */

/** The longest line written, in UTF-16 code units. A longer one is replaced. */
export const MAX_LOG_LINE_LENGTH = 64 * 1024;

/** The longest single string kept in a line; longer ones are cut and marked. */
export const MAX_LOG_STRING_LENGTH = 16 * 1024;

/** Written whenever a line cannot be scrubbed or logging itself fails. */
export const FALLBACK_LINE = '{"level":"error","msg":"log record dropped: not serialisable"}\n';

const METADATA = Symbol.for('pino.metadata');
const BACKSLASH = 0x5c;
const QUOTE = 0x22;

function oversizeLine(length: number): string {
  return `{"level":"error","msg":"log record dropped: line too long","length":${length}}\n`;
}

/**
 * Scrubs every JSON string literal of one serialised line. One forward pass:
 * each literal is found by scanning to its closing quote, decoded only when it
 * holds an escape (so `Bearer\nLEAK` is seen as the text it is), scrubbed, and
 * re-encoded only if the scrub changed it. Throws on a line that is not
 * well-formed (an unterminated literal or a bad escape).
 */
export function scrubLine(line: string): string {
  if (line.length > MAX_LOG_LINE_LENGTH) return oversizeLine(line.length);

  let out = '';
  let copied = 0;
  let at = 0;
  for (;;) {
    const open = line.indexOf('"', at);
    if (open === -1) break;

    let close = open + 1;
    let escaped = false;
    for (;;) {
      if (close >= line.length) throw new SyntaxError('unterminated string in log line');
      const code = line.charCodeAt(close);
      if (code === QUOTE) break;
      if (code === BACKSLASH) {
        escaped = true;
        close++;
      }
      close++;
    }

    const body = line.slice(open + 1, close);
    const text = escaped ? (JSON.parse(`"${body}"`) as string) : body;
    const scrubbed = scrubMessage(text, MAX_LOG_STRING_LENGTH);
    if (scrubbed !== text) {
      out += `${line.slice(copied, open)}${JSON.stringify(scrubbed)}`;
      copied = close + 1;
    }
    at = close + 1;
  }
  return copied === 0 ? line : `${out}${line.slice(copied)}`;
}

/** Writes {@link FALLBACK_LINE}; a destination that fails again is left alone. */
export function writeFallback(destination: DestinationStream): void {
  try {
    if ((destination as unknown as Record<symbol, unknown>)[METADATA] === true) {
      (destination as unknown as { lastLevel?: number }).lastLevel = 50;
    }
    destination.write(FALLBACK_LINE);
  } catch {
    // Logging must never be what takes the caller down.
  }
}

/**
 * Wraps a destination so every line written to it is first passed through
 * {@link scrubLine}. A multistream is wrapped as a whole, so each of its
 * members receives the scrubbed line. Metadata pino attaches for destinations
 * that ask for it is the unscrubbed input of the line: `lastMsg` is scrubbed,
 * `lastObj` and `lastLogger` are withheld.
 */
export function scrubbingDestination(inner: DestinationStream): DestinationStream {
  const write = (chunk: unknown): void => {
    let line: string;
    try {
      line = scrubLine(String(chunk));
    } catch {
      line = FALLBACK_LINE;
    }
    try {
      inner.write(line);
    } catch {
      writeFallback(inner);
    }
  };

  return new Proxy(inner, {
    get(target, property) {
      if (property === 'write') return write;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
    set(target, property, value) {
      if (property === 'lastMsg') {
        let msg: unknown;
        try {
          msg = typeof value === 'string' ? scrubMessage(value, MAX_LOG_STRING_LENGTH) : undefined;
        } catch {
          msg = undefined;
        }
        return Reflect.set(target, property, msg, target);
      }
      if (property === 'lastObj') return Reflect.set(target, property, {}, target);
      if (property === 'lastLogger') return Reflect.set(target, property, undefined, target);
      return Reflect.set(target, property, value, target);
    },
  });
}
