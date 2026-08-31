/**
 * The clamd wire protocol, as pure functions.
 *
 * Everything here is framing and parsing: no socket, no clock, no filesystem.
 * That is deliberate. The parsing is where a scanner gets a verdict wrong, and
 * every interesting case — a truncated reply, a reply with no terminator, a
 * signature name containing the word `OK`, an engine error dressed as a
 * finding — is a string, so every one of them belongs in a unit test rather
 * than in an integration suite that can only produce the replies a healthy
 * clamd happens to send.
 *
 * ## The `z` prefix, and why not `n`
 *
 * clamd accepts commands in three forms: bare (`SCAN`), newline-terminated
 * (`nSCAN`) and NUL-terminated (`zSCAN`). The bare form is deprecated and its
 * behaviour on a command it does not recognise is version-dependent. `z` is
 * used throughout because a NUL is unambiguous in a way a newline is not: a
 * signature name may not contain one, so a reply can be split on it without
 * the parser having to guess whether a line break belongs to the message or
 * ends it.
 *
 * ## Reference
 *
 * `man clamd`, section "Clamd protocol". The reply grammar this file
 * implements, in full:
 *
 *   `stream: OK\0`                               nothing matched
 *   `stream: <signature> FOUND\0`                a match
 *   `stream: <message> ERROR\0`                  the engine failed
 *   `INSTREAM size limit exceeded. ERROR\0`      the body was over StreamMaxLength
 *   `UNKNOWN COMMAND\0`                          the command was not understood
 */

/** Sent to start a stream scan. NUL-terminated, per the `z` command form. */
export const INSTREAM_COMMAND = 'zINSTREAM\0';
export const VERSION_COMMAND = 'zVERSION\0';
export const PING_COMMAND = 'zPING\0';

/** Ends the stream. A zero-length chunk header, and the only way to say "done". */
export const INSTREAM_TERMINATOR = Buffer.from([0, 0, 0, 0]);

/**
 * The prefix clamd uses for a limit it stopped at rather than a threat it
 * found.
 *
 * `AlertExceedsMax yes` in `clamd.conf` is what makes these appear at all;
 * with it off the same scan answers `OK`, which is the reason the option is
 * set and the reason this constant exists. Matched as a prefix because the
 * suffix names which limit (`.MaxFileSize`, `.MaxRecursion`, …) and the
 * consequence is the same for all of them.
 */
export const LIMITS_EXCEEDED_PREFIX = 'Heuristics.Limits.Exceeded';

/**
 * Frames one chunk of an INSTREAM body.
 *
 * A four-byte big-endian length followed by the bytes. A zero length ends the
 * stream, so a zero-length chunk may never be sent as data — clamd would treat
 * it as the terminator and scan a truncated object, then answer `OK` about
 * bytes it never saw.
 */
export function frameChunk(chunk: Uint8Array): Buffer {
  if (chunk.length === 0) {
    throw new Error('An INSTREAM chunk may not be empty: a zero length terminates the stream');
  }
  if (chunk.length > MAX_CHUNK_BYTES) {
    throw new Error(`An INSTREAM chunk may not exceed ${MAX_CHUNK_BYTES} bytes`);
  }

  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(chunk.length, 0);
  return Buffer.concat([header, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)]);
}

/**
 * The largest chunk the length header can express.
 *
 * clamd's own limit is lower and configurable; this is the one the wire format
 * imposes, and framing a larger buffer would silently truncate the length
 * rather than fail.
 */
export const MAX_CHUNK_BYTES = 0xffffffff;

export type ClamdReply =
  | { readonly kind: 'CLEAN' }
  | { readonly kind: 'FOUND'; readonly signature: string }
  | { readonly kind: 'LIMITS_EXCEEDED'; readonly signature: string }
  | { readonly kind: 'ERROR'; readonly message: string }
  | { readonly kind: 'UNPARSEABLE'; readonly detail: string };

/**
 * Interprets one INSTREAM reply.
 *
 * ## Everything that is not recognised is `UNPARSEABLE`
 *
 * There is no default that resolves to clean, and that is the single most
 * important property of this function. A parser that fell through to "no
 * signature was mentioned, so nothing was found" would answer `CLEAN` for a
 * truncated reply, for a reply from a future clamd, and for a reply that
 * arrived while the connection was being reset — all of which are cases where
 * nobody knows what the bytes are.
 *
 * ## Why the terminator is required
 *
 * A reply without its trailing NUL is a reply that has not finished arriving.
 * `stream: Some-Signature FOU` parses as neither OK nor FOUND, but
 * `stream: OK` — the prefix of a longer message that has not landed yet —
 * would parse as clean if the terminator were treated as optional. It is not.
 */
export function parseInstreamReply(raw: string): ClamdReply {
  if (raw.length === 0) {
    return { kind: 'UNPARSEABLE', detail: 'empty reply' };
  }
  if (!raw.endsWith('\0')) {
    return { kind: 'UNPARSEABLE', detail: 'reply was not NUL-terminated' };
  }

  // A single reply, not a stream of them. More than one NUL means the
  // connection carried something this exchange did not ask for.
  const body = raw.slice(0, -1);
  if (body.includes('\0')) {
    return { kind: 'UNPARSEABLE', detail: 'reply contained more than one message' };
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { kind: 'UNPARSEABLE', detail: 'reply was only a terminator' };
  }

  if (trimmed === 'UNKNOWN COMMAND') {
    return { kind: 'ERROR', message: 'the scanner did not recognise the command' };
  }

  // Errors are checked before findings. `INSTREAM size limit exceeded. ERROR`
  // has no `stream:` prefix and would otherwise fall through to unparseable,
  // and an engine error that happened to mention a file name must never be
  // read as a signature.
  if (trimmed.endsWith(' ERROR')) {
    const message = trimmed
      .slice(0, -' ERROR'.length)
      .replace(/^stream:\s*/, '')
      .trim();
    return { kind: 'ERROR', message: message.length > 0 ? message : 'unspecified engine error' };
  }

  if (!trimmed.startsWith('stream:')) {
    return { kind: 'UNPARSEABLE', detail: 'reply did not name the stream it answers for' };
  }

  const answer = trimmed.slice('stream:'.length).trim();

  if (answer === 'OK') {
    return { kind: 'CLEAN' };
  }

  // A finding with no name is not a finding anybody can act on, and it is
  // certainly not a clean bill of health. Checked as its own case because
  // trimming collapses `stream:  FOUND` to exactly `FOUND`, which the suffix
  // test below would miss and the fall-through would report less precisely.
  if (answer === 'FOUND') {
    return { kind: 'UNPARSEABLE', detail: 'a match was reported with no signature name' };
  }

  if (answer.endsWith(' FOUND')) {
    const signature = answer.slice(0, -' FOUND'.length).trim();
    if (signature.length === 0) {
      return { kind: 'UNPARSEABLE', detail: 'a match was reported with no signature name' };
    }
    if (signature.startsWith(LIMITS_EXCEEDED_PREFIX)) {
      return { kind: 'LIMITS_EXCEEDED', signature };
    }
    return { kind: 'FOUND', signature };
  }

  return { kind: 'UNPARSEABLE', detail: 'reply was neither a pass, a match nor an error' };
}

export interface ClamdVersion {
  /** e.g. `1.5.4`. */
  readonly engineVersion: string;
  /** The daily database build number, e.g. `28108`. */
  readonly signatureVersion: string;
  /** When that database was built. */
  readonly signatureBuiltAt: Date;
}

/**
 * Reads `zVERSION`.
 *
 * The reply is three fields separated by `/`:
 *
 *   `ClamAV 1.5.4/28108/Sun Aug 30 06:27:10 2026\0`
 *
 * All three matter and all three are required. The engine version goes on the
 * row for attribution; the database number is what a re-scan campaign targets;
 * the build date is what freshness is measured from. A clamd built without a
 * database answers with the engine alone (`ClamAV 1.5.4\0`), and that is a
 * scanner that cannot conclude anything — so it is a parse failure here rather
 * than a version with two fields missing.
 */
export function parseVersionReply(raw: string): ClamdVersion | null {
  if (!raw.endsWith('\0')) return null;

  const body = raw.slice(0, -1).trim();
  const parts = body.split('/');
  if (parts.length !== 3) return null;

  const engine = (parts[0] ?? '').trim();
  const signatureVersion = (parts[1] ?? '').trim();
  const builtAtText = (parts[2] ?? '').trim();

  const engineMatch = /^ClamAV\s+(\S+)$/.exec(engine);
  if (!engineMatch) return null;

  // The database number is a build counter. Anything else — a word, a date, an
  // empty field — means the reply is not the one this parser was written for.
  if (!/^\d+$/.test(signatureVersion)) return null;

  const builtAt = parseBuildDate(builtAtText);
  if (!builtAt) return null;

  return {
    engineVersion: engineMatch[1] as string,
    signatureVersion,
    signatureBuiltAt: builtAt,
  };
}

/**
 * Reads the CVD build date, as UTC.
 *
 * clamd prints it with no zone designator — `Sun Aug 30 06:27:10 2026` — which
 * `new Date()` would interpret in **this process's** local time. That makes
 * signature age a function of the developer's timezone: the same reply
 * measures two hours old on a UTC machine and five and a half on one at
 * UTC+3:30, and on a machine west of UTC it measures *younger* than it is,
 * which is the direction that fails open.
 *
 * So the zone is supplied rather than inferred. The pinned ClamAV image sets
 * `TZ=Etc/UTC` (its own default, and the compose and Kubernetes definitions
 * keep it), so the string genuinely is UTC and this reading is exact — and,
 * more importantly, it is the same number on every machine that parses it.
 *
 * A clamd deliberately run in another zone would be misread by at most the
 * offset, against a freshness threshold measured in days. That is recorded in
 * ADR-049 rather than defended against by guessing.
 */
function parseBuildDate(text: string): Date | null {
  // Only when the string carries no zone of its own. A future clamd that
  // started emitting ISO-8601 with an offset must not have `UTC` appended to
  // an already-qualified timestamp.
  const qualified = /(UTC|GMT|[+-]\d{2}:?\d{2}|Z)$/.test(text) ? text : `${text} UTC`;
  const parsed = new Date(qualified);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Reads `zPING`. Anything but `PONG` is a scanner that is not answering. */
export function isPong(raw: string): boolean {
  return raw.replace(/\0/g, '').trim() === 'PONG';
}

/**
 * How old a signature database is, in whole seconds.
 *
 * Clamped at zero. A database built "in the future" is clock skew between this
 * process and the machine that built the CVD, and reporting a negative age
 * would make every freshness comparison pass — the direction that fails open.
 */
export function signatureAgeSeconds(builtAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - builtAt.getTime()) / 1000));
}
