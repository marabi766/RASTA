/**
 * The EICAR test file, assembled at run time.
 *
 * ## What EICAR is
 *
 * A 68-byte printable string, standardised by the European Institute for
 * Computer Antivirus Research, that every antivirus engine is expected to
 * report as a detection. It is **not** malware: it contains no exploit and no
 * payload, and running it on DOS prints a line of text. It exists precisely so
 * that "does the scanner actually detect anything" can be answered without
 * handling a real sample, and answering that question is the only way to prove
 * this integration end to end. A test that asserted an infection by injecting
 * a fake `FOUND` reply would prove the mock.
 *
 * ## Why it is split into two base64 halves
 *
 * Because it must not be committed as a scannable literal. The whole point of
 * the string is that scanners match it, so a repository containing it in plain
 * form is a repository that desktop antivirus quarantines on checkout — the
 * file disappears, the clone looks corrupt, and the developer has no idea why.
 * Two base64 fragments joined in memory match nothing on disk while producing
 * the exact bytes when they are needed.
 *
 * ## Where the bytes are allowed to go
 *
 * Memory, and then straight over HTTP to MinIO. They are never written to the
 * filesystem of the machine running the suite — there is no `writeFile` here
 * and there must not be one, because on a Windows developer machine that would
 * be handing Defender a file it is required to quarantine. The object is
 * removed from the bucket by the suite's own cleanup.
 *
 * The scanning itself happens inside the Linux ClamAV container, which is
 * where a scanner is supposed to look at things.
 */

/**
 * `X5O!P%@AP[4\PZX54(P^)7CC)7}$` and
 * `EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`, encoded and kept apart.
 */
const FIRST_HALF = 'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FS';
const SECOND_HALF = 'LVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=';

/** The standard test artefact, in memory only. */
export function eicarBytes(): Buffer {
  const bytes = Buffer.concat([
    Buffer.from(FIRST_HALF, 'base64'),
    Buffer.from(SECOND_HALF, 'base64'),
  ]);

  // A guard on the fragments rather than a comment about them. A mistyped
  // character would produce a buffer no engine matches, and the suite would
  // then "prove" that an infected document is refused while actually having
  // uploaded something harmless and unremarkable.
  if (bytes.length !== 68) {
    throw new Error(`The EICAR fragments assembled to ${bytes.length} bytes rather than 68`);
  }

  return bytes;
}

/**
 * EICAR inside an Office document, which is what an infected upload looks like.
 *
 * ## Why it has to be wrapped at all
 *
 * `finalize` establishes the real content type from the object's first bytes
 * and refuses anything that is not an accepted document format. The bare EICAR
 * string is not one, so it can never become a registered document — which
 * means the infected path cannot be reached with it, and a test that tried
 * would be proving the magic-number check rather than the scanner.
 *
 * ## Why a ZIP rather than a PDF
 *
 * The first attempt embedded the string in a PDF body and ClamAV answered
 * `OK`. Its `Eicar-Test-Signature` matches the file *as a whole* — the EICAR
 * specification defines the artefact as those 68 bytes and nothing else — so a
 * PDF that merely contains them is not EICAR and is correctly not detected.
 *
 * A DOCX is a ZIP, ClamAV unpacks archives and scans each member, and a member
 * whose content is exactly EICAR is exactly EICAR. So this builds a minimal
 * stored ZIP whose single entry is `word/document.xml` — which is also what
 * makes `detectMime` read it as a DOCX rather than as an anonymous archive.
 *
 * It is also the more honest threat model. Nobody uploads a bare executable to
 * a contract field; they upload an Office document with something inside it,
 * and unpacking the container is the work a scanner is there to do.
 */
export function eicarInsideDocx(): Buffer {
  return storedZip('word/document.xml', eicarBytes());
}

/**
 * A ZIP with one uncompressed entry, built by hand.
 *
 * Stored rather than deflated so the bytes are exactly predictable, and hand-
 * built rather than pulled from a library so the fixture adds no dependency
 * whose output could change under it. Enough of the format for ClamAV to
 * unpack: local header, data, central directory, end-of-central-directory.
 */
function storedZip(name: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'latin1');
  const crc = crc32(data);
  // A fixed DOS timestamp, so the same fixture is byte-identical on every run
  // and a failure is never "the clock moved".
  const dosTime = 0x2821;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // PK\3\4
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(dosTime, 12); // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra length
  const localPart = Buffer.concat([local, nameBytes, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // PK\1\2
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(dosTime, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralPart = Buffer.concat([central, nameBytes]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // PK\5\6
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, end]);
}

/** The MIME `detectMime` reads from the fixture above. */
export const EICAR_DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The signature name ClamAV reports for it, for an exact assertion. */
export const EICAR_SIGNATURE_PATTERN = /Eicar/i;

/**
 * CRC-32, because a ZIP entry carries one and unpackers check it.
 *
 * `node:zlib` exposes `crc32` only from Node 22.2, and this repository builds
 * against 22 — but a fixture that breaks on an older local Node is a fixture
 * that wastes somebody's afternoon, and the table is eight lines.
 */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
