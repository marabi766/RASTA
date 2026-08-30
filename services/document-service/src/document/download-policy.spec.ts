import { canDownload, type DownloadCandidate } from './download-policy';

/**
 * The one decision standing between a private object and a working URL.
 *
 * Enumerated exhaustively rather than sampled, because a signed URL is a
 * bearer credential: once issued it works for whoever holds it, with no token
 * and no role. Every state the column can hold has a row here, including the
 * one that does not exist yet.
 */

const document = (overrides: Partial<DownloadCandidate> = {}): DownloadCandidate => ({
  id: 'DOC_1',
  status: 'REGISTERED',
  scanState: 'CLEAN',
  ...overrides,
});

const PERMISSIVE = { allowUnscanned: true };
const STRICT = { allowUnscanned: false };

describe('what may be downloaded', () => {
  it('allows a clean document', () => {
    expect(canDownload(document(), STRICT)).toEqual({ allowed: true });
  });
});

describe('what may never be downloaded, whatever the configuration', () => {
  it('refuses one whose scan has not run', () => {
    // ADR-014: "تا اتمام اسکن بدافزار، فایل قابل دانلود نیست". Serving bytes
    // nothing has looked at is the failure the rule exists to prevent.
    for (const policy of [STRICT, PERMISSIVE]) {
      const decision = canDownload(document({ scanState: 'PENDING' }), policy);
      expect(decision.allowed).toBe(false);
      expect(decision).toMatchObject({ reason: 'PENDING' });
    }
  });

  it('refuses an infected one, even where unscanned content is allowed', () => {
    // The important pairing: the permissive setting exists for `NOT_SCANNED`
    // and must not become a general override.
    for (const policy of [STRICT, PERMISSIVE]) {
      const decision = canDownload(document({ scanState: 'INFECTED' }), policy);
      expect(decision.allowed).toBe(false);
      expect(decision).toMatchObject({ reason: 'INFECTED' });
    }
  });

  it('refuses one whose scan errored', () => {
    // A failed scan is not a passed scan. Treating it as permission would make
    // every scanner outage a platform-wide bypass.
    for (const policy of [STRICT, PERMISSIVE]) {
      expect(canDownload(document({ scanState: 'FAILED' }), policy).allowed).toBe(false);
    }
  });

  it('refuses a deleted one, and reports it as absent', () => {
    // `DELETED` rather than a scan reason, so the caller is told it is gone
    // rather than that it is unsafe — and the service answers 404, because a
    // refusal would confirm it once existed.
    for (const scanState of ['CLEAN', 'PENDING', 'INFECTED', 'NOT_SCANNED']) {
      const decision = canDownload(document({ status: 'DELETED', scanState }), PERMISSIVE);
      expect(decision).toMatchObject({ allowed: false, reason: 'DELETED' });
    }
  });
});

describe('the one state configuration decides (Q-18)', () => {
  it('allows an unscanned document where the deployment permits it', () => {
    // The MVP position: no scanner exists, so refusing this too would make the
    // whole capability inert.
    expect(canDownload(document({ scanState: 'NOT_SCANNED' }), PERMISSIVE)).toEqual({
      allowed: true,
    });
  });

  it('refuses it where the deployment does not', () => {
    const decision = canDownload(document({ scanState: 'NOT_SCANNED' }), STRICT);
    expect(decision).toMatchObject({ allowed: false, reason: 'NOT_SCANNED' });
  });
});

describe('a state nobody has written a rule for', () => {
  it('fails closed', () => {
    // The property that matters when somebody adds a value to the enum and
    // forgets this file: the new state must not be downloadable by default.
    const decision = canDownload(document({ scanState: 'QUARANTINED' }), PERMISSIVE);
    expect(decision.allowed).toBe(false);
  });
});

describe('what a refusal tells the caller', () => {
  it('names the document and carries a message a person can act on', () => {
    const decision = canDownload(document({ scanState: 'PENDING' }), STRICT);
    expect(decision).toMatchObject({ allowed: false, documentId: 'DOC_1' });
    if (!decision.allowed) {
      expect(decision.message.length).toBeGreaterThan(20);
      // No object key, no bucket, no URL in anything a caller sees.
      expect(decision.message).not.toMatch(/documents\//);
    }
  });
});
