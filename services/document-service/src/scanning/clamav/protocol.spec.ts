import {
  INSTREAM_TERMINATOR,
  LIMITS_EXCEEDED_PREFIX,
  frameChunk,
  isPong,
  parseInstreamReply,
  parseVersionReply,
  signatureAgeSeconds,
} from './protocol';

/**
 * The clamd protocol, exercised on strings.
 *
 * This is where a scanner gets a verdict wrong, and none of the interesting
 * cases can be produced on demand by a healthy clamd: a truncated reply, a
 * reply from a future version, a signature whose name contains `OK`, an engine
 * error that mentions a filename. An integration suite proves the happy path
 * against a real engine; this proves the ones that matter.
 *
 * The single property every test below is really defending: **nothing that is
 * not an explicit `OK` may parse as clean.**
 */

const NUL = '\0';

describe('parsing an INSTREAM reply', () => {
  describe('the pass', () => {
    it('reads the exact reply clamd sends for a file that matched nothing', () => {
      // Captured from clamav/clamav@sha256:f0954d6790… over a real socket.
      expect(parseInstreamReply(`stream: OK${NUL}`)).toEqual({ kind: 'CLEAN' });
    });

    it('tolerates the trailing whitespace some builds add', () => {
      expect(parseInstreamReply(`stream: OK \n${NUL}`)).toEqual({ kind: 'CLEAN' });
    });
  });

  describe('the match', () => {
    it('reads the signature name and nothing else', () => {
      expect(parseInstreamReply(`stream: Eicar-Test-Signature FOUND${NUL}`)).toEqual({
        kind: 'FOUND',
        signature: 'Eicar-Test-Signature',
      });
    });

    it('keeps a signature name containing dots and dashes intact', () => {
      expect(parseInstreamReply(`stream: Win.Test.EICAR_HDB-1 FOUND${NUL}`)).toEqual({
        kind: 'FOUND',
        signature: 'Win.Test.EICAR_HDB-1',
      });
    });

    it('is not fooled by a signature name that contains OK', () => {
      // A naive `includes('OK')` check reads this as clean, which would be a
      // silent pass for a real detection.
      expect(parseInstreamReply(`stream: Doc.Dropper.OK-Agent FOUND${NUL}`)).toEqual({
        kind: 'FOUND',
        signature: 'Doc.Dropper.OK-Agent',
      });
    });

    it('refuses a match that names no signature rather than reporting one', () => {
      // A finding nobody can act on. Recorded as unparseable — not as clean,
      // and not as a nameless threat that would reach notification-service.
      expect(parseInstreamReply(`stream:  FOUND${NUL}`)).toEqual({
        kind: 'UNPARSEABLE',
        detail: 'a match was reported with no signature name',
      });
    });
  });

  describe('a limit the engine stopped at', () => {
    it('is neither a pass nor a threat', () => {
      const reply = parseInstreamReply(`stream: ${LIMITS_EXCEEDED_PREFIX}.MaxFileSize FOUND${NUL}`);

      // The whole reason `AlertExceedsMax yes` is set: without it this scan
      // answers `OK`. With it, the engine says it stopped looking — which must
      // not become CLEAN, and must not become a fabricated infection either.
      expect(reply).toEqual({
        kind: 'LIMITS_EXCEEDED',
        signature: `${LIMITS_EXCEEDED_PREFIX}.MaxFileSize`,
      });
    });

    it('covers every limit the prefix names, not just the one seen first', () => {
      for (const limit of ['MaxRecursion', 'MaxFiles', 'MaxScanSize', 'MaxFileSize']) {
        expect(
          parseInstreamReply(`stream: ${LIMITS_EXCEEDED_PREFIX}.${limit} FOUND${NUL}`),
        ).toEqual({ kind: 'LIMITS_EXCEEDED', signature: `${LIMITS_EXCEEDED_PREFIX}.${limit}` });
      }
    });
  });

  describe('errors', () => {
    it('reads an engine error and strips the stream prefix', () => {
      expect(parseInstreamReply(`stream: Can't allocate memory ERROR${NUL}`)).toEqual({
        kind: 'ERROR',
        message: "Can't allocate memory",
      });
    });

    it('reads the size refusal, which carries no stream prefix at all', () => {
      // Real reply when a body exceeds clamd's own StreamMaxLength. Without an
      // error branch checked before the `stream:` requirement, it would fall
      // through to unparseable and lose the reason.
      expect(parseInstreamReply(`INSTREAM size limit exceeded. ERROR${NUL}`)).toEqual({
        kind: 'ERROR',
        message: 'INSTREAM size limit exceeded.',
      });
    });

    it('reads the reply to a command clamd does not know', () => {
      expect(parseInstreamReply(`UNKNOWN COMMAND${NUL}`)).toEqual({
        kind: 'ERROR',
        message: 'the scanner did not recognise the command',
      });
    });

    it('does not read a filename in an error as a signature', () => {
      const reply = parseInstreamReply(`stream: /tmp/x.pdf: Bad file descriptor ERROR${NUL}`);
      expect(reply.kind).toBe('ERROR');
    });
  });

  describe('everything unrecognised fails closed', () => {
    // The table that matters. Each of these is a reply nobody can interpret,
    // and every one of them must be UNPARSEABLE rather than CLEAN — because a
    // parser that fell through to "no signature was mentioned, so nothing was
    // found" would pass a truncated reply as a clean bill of health.
    const cases: Array<[string, string]> = [
      ['an empty reply', ''],
      ['a reply that has not finished arriving', 'stream: OK'],
      ['a truncated match', 'stream: Some-Signature FOU'],
      ['only a terminator', NUL],
      ['whitespace and a terminator', `   ${NUL}`],
      ['a reply for something other than a stream', `/tmp/file: OK${NUL}`],
      ['a reply from a protocol this parser does not speak', `PONG${NUL}`],
      ['two messages on one connection', `stream: OK${NUL}stream: OK${NUL}`],
      ['a verdict word this parser does not know', `stream: MAYBE${NUL}`],
    ];

    it.each(cases)('refuses %s', (_label, raw) => {
      expect(parseInstreamReply(raw).kind).toBe('UNPARSEABLE');
    });

    it('never returns CLEAN for any of them', () => {
      for (const [, raw] of cases) {
        expect(parseInstreamReply(raw).kind).not.toBe('CLEAN');
      }
    });
  });
});

describe('framing an INSTREAM chunk', () => {
  it('writes a four-byte big-endian length before the bytes', () => {
    const framed = frameChunk(Buffer.from([0xaa, 0xbb, 0xcc]));

    expect(framed).toHaveLength(7);
    expect(framed.readUInt32BE(0)).toBe(3);
    expect([...framed.subarray(4)]).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('refuses an empty chunk, because a zero length ends the stream', () => {
    // The subtle one. A zero-length frame is the terminator, so sending an
    // empty chunk as data would make clamd scan a truncated object and answer
    // `OK` about bytes it never saw.
    expect(() => frameChunk(Buffer.alloc(0))).toThrow(/may not be empty/);
  });

  it('frames a view into a larger buffer without dragging the rest along', () => {
    // `subarray` is what the client streams with, and a naive `Buffer.from`
    // over the view's underlying ArrayBuffer would send the whole object in
    // every frame.
    const backing = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const framed = frameChunk(backing.subarray(2, 5));

    expect(framed.readUInt32BE(0)).toBe(3);
    expect([...framed.subarray(4)]).toEqual([3, 4, 5]);
  });

  it('terminates with four zero bytes', () => {
    expect([...INSTREAM_TERMINATOR]).toEqual([0, 0, 0, 0]);
  });
});

describe('parsing a VERSION reply', () => {
  it('reads engine, database number and build date from the real reply', () => {
    // Captured from the pinned image.
    const parsed = parseVersionReply(`ClamAV 1.5.4/28108/Sun Aug 30 06:27:10 2026${NUL}`);

    expect(parsed).not.toBeNull();
    expect(parsed?.engineVersion).toBe('1.5.4');
    expect(parsed?.signatureVersion).toBe('28108');
    expect(parsed?.signatureBuiltAt.toISOString()).toBe('2026-08-30T06:27:10.000Z');
  });

  it('reads the build date as UTC, not as the parsing machine local time', () => {
    // clamd prints no zone designator. Left to `new Date()`, the same reply
    // would measure two hours old on a UTC runner and five and a half on a
    // developer machine at UTC+3:30 — and *younger* than it really is west of
    // UTC, which is the direction that fails open. This assertion is the one
    // that fails if the zone is ever inferred again.
    const parsed = parseVersionReply(`ClamAV 1.5.4/28108/Sun Aug 30 06:27:10 2026${NUL}`);

    expect(parsed?.signatureBuiltAt.toISOString()).toBe('2026-08-30T06:27:10.000Z');
  });

  it('does not re-qualify a timestamp that already carries a zone', () => {
    const parsed = parseVersionReply(`ClamAV 1.5.4/28108/2026-08-30T06:27:10+02:00${NUL}`);

    expect(parsed?.signatureBuiltAt.toISOString()).toBe('2026-08-30T04:27:10.000Z');
  });

  it('refuses a clamd with no database loaded', () => {
    // `ClamAV 1.5.4` with no database fields is a scanner that cannot conclude
    // anything. Refused here rather than returned with two nulls, so no caller
    // has to remember to check them.
    expect(parseVersionReply(`ClamAV 1.5.4${NUL}`)).toBeNull();
  });

  const rejected: Array<[string, string]> = [
    ['a reply that has not finished arriving', 'ClamAV 1.5.4/28108/Sun Aug 30 06:27:10 2026'],
    ['a database field that is not a build number', `ClamAV 1.5.4/unknown/Sun Aug 30 2026${NUL}`],
    ['an unparseable build date', `ClamAV 1.5.4/28108/not-a-date${NUL}`],
    ['a product that is not ClamAV', `SomeScanner 1.0/1/Sun Aug 30 2026${NUL}`],
    ['an empty reply', ''],
    ['too many fields', `ClamAV 1.5.4/28108/Sun Aug 30 2026/extra${NUL}`],
  ];

  it.each(rejected)('refuses %s', (_label, raw) => {
    expect(parseVersionReply(raw)).toBeNull();
  });
});

describe('PING', () => {
  it('accepts the reply clamd sends', () => {
    expect(isPong(`PONG${NUL}`)).toBe(true);
  });

  it.each([
    ['', 'nothing'],
    ['PON\0', 'a truncated reply'],
    ['PONGPONG\0', 'two replies'],
  ])('refuses %s (%s)', (raw) => {
    expect(isPong(raw)).toBe(false);
  });
});

describe('signature age', () => {
  const now = new Date('2026-08-31T12:00:00.000Z');

  it('is the whole seconds since the database was built', () => {
    expect(signatureAgeSeconds(new Date('2026-08-31T11:00:00.000Z'), now)).toBe(3600);
  });

  it('is zero for a database built in the future rather than negative', () => {
    // Clock skew between this process and the machine that built the CVD. A
    // negative age would make every freshness comparison pass, which is the
    // direction that fails open.
    expect(signatureAgeSeconds(new Date('2026-09-01T12:00:00.000Z'), now)).toBe(0);
  });

  it('grows with a database that is genuinely old', () => {
    expect(signatureAgeSeconds(new Date('2026-08-01T12:00:00.000Z'), now)).toBe(30 * 24 * 3600);
  });
});
