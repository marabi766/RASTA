import { canDownload, type DownloadCandidate } from './download-policy';

/**
 * The one decision standing between a private object and a working URL.
 *
 * Enumerated exhaustively rather than sampled, because a signed URL is a
 * bearer credential: once issued it works for whoever holds it, with no token
 * and no role. Every state the column can hold has a row here, including the
 * ones that do not exist yet.
 *
 * The function takes no configuration argument, which is itself the property
 * under test: there is no second parameter a deployment could pass to make any
 * of the refusals below come out the other way.
 */

const document = (overrides: Partial<DownloadCandidate> = {}): DownloadCandidate => ({
  id: 'DOC_1',
  status: 'REGISTERED',
  scanState: 'CLEAN',
  ...overrides,
});

describe('the only state that authorizes a download', () => {
  it('allows a document a scanner found clean', () => {
    expect(canDownload(document({ scanState: 'CLEAN' }))).toEqual({ allowed: true });
  });

  it('allows nothing else, whatever the state', () => {
    // The exhaustive form of the invariant: `CLEAN` is the sole `allowed: true`
    // in the function, so any state added later is refused until somebody
    // deliberately writes a rule for it.
    const everyOtherState = [
      'PENDING',
      'NOT_SCANNED',
      'INFECTED',
      'FAILED',
      'QUARANTINED',
      'SOMETHING_INVENTED_LATER',
      '',
    ];

    for (const scanState of everyOtherState) {
      expect(canDownload(document({ scanState })).allowed).toBe(false);
    }
  });
});

describe('what may never be downloaded', () => {
  it('refuses one whose scan has not run', () => {
    // ADR-014: «تا اتمام اسکن بدافزار، فایل قابل دانلود نیست». Serving bytes
    // nothing has looked at is the failure the rule exists to prevent.
    expect(canDownload(document({ scanState: 'PENDING' }))).toMatchObject({
      allowed: false,
      reason: 'PENDING',
    });
  });

  it('refuses one nothing inspected, which is the MVP stub verdict (Q-18)', () => {
    // The correction this file exists to lock down. `NOT_SCANNED` means no
    // scan completed, so ADR-014 refuses it — and because the MVP scanner
    // records exactly this, no document in an MVP deployment is downloadable.
    // That is an accepted, documented limitation, not a bug to configure away.
    expect(canDownload(document({ scanState: 'NOT_SCANNED' }))).toMatchObject({
      allowed: false,
      reason: 'NOT_SCANNED',
    });
  });

  it('refuses an infected one', () => {
    expect(canDownload(document({ scanState: 'INFECTED' }))).toMatchObject({
      allowed: false,
      reason: 'INFECTED',
    });
  });

  it('refuses one whose scan errored', () => {
    // A failed scan is not a passed scan. Treating it as permission would make
    // every scanner outage a platform-wide bypass.
    expect(canDownload(document({ scanState: 'FAILED' }))).toMatchObject({
      allowed: false,
      reason: 'FAILED',
    });
  });

  it('refuses a quarantined one, with its own reason', () => {
    expect(canDownload(document({ scanState: 'QUARANTINED' }))).toMatchObject({
      allowed: false,
      reason: 'QUARANTINED',
    });
  });

  it('refuses a deleted one, and reports it as absent', () => {
    // `DELETED` rather than a scan reason, so the caller is told it is gone
    // rather than that it is unsafe — and the service answers 404, because a
    // refusal would confirm it once existed. Checked first, so it wins even
    // over a document a scanner had cleared.
    for (const scanState of ['CLEAN', 'PENDING', 'INFECTED', 'NOT_SCANNED', 'QUARANTINED']) {
      expect(canDownload(document({ status: 'DELETED', scanState }))).toMatchObject({
        allowed: false,
        reason: 'DELETED',
      });
    }
  });
});

describe('a state nobody has written a rule for', () => {
  it('fails closed', () => {
    // The property that matters when somebody adds a value to the enum and
    // forgets this file: the new state must not be downloadable by default.
    expect(canDownload(document({ scanState: 'AWAITING_SECOND_OPINION' })).allowed).toBe(false);
  });
});

describe('what a refusal tells the caller', () => {
  it('names the document and carries a message a person can act on', () => {
    const decision = canDownload(document({ scanState: 'NOT_SCANNED' }));
    expect(decision).toMatchObject({ allowed: false, documentId: 'DOC_1' });
    if (!decision.allowed) {
      expect(decision.message.length).toBeGreaterThan(20);
      // No object key, no bucket, no URL in anything a caller sees.
      expect(decision.message).not.toMatch(/documents\//);
    }
  });

  it('does not claim a scan happened when none did', () => {
    // The message is read by operators and shown in the UI. "Not scanned" must
    // not be worded as though an engine had examined the file and deferred.
    const decision = canDownload(document({ scanState: 'NOT_SCANNED' }));
    if (!decision.allowed) {
      expect(decision.message).toMatch(/has not been scanned/i);
      expect(decision.message).not.toMatch(/clean|safe|passed|verified/i);
    }
  });
});
