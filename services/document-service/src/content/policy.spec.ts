import {
  CLASS_POLICY,
  DOCUMENT_CLASSES,
  assertDeclarationAllowed,
  assertObjectAllowed,
  policyFor,
  sanitizeFilename,
} from './policy';

/**
 * The allowlist, the size ceilings and the filename sanitiser.
 *
 * Two checks that look alike and are not: the declaration check runs on the
 * client's *claims* before a credential is issued, and the object check runs
 * on what storage actually holds. Both are tested, because passing one and
 * skipping the other is exactly how a mismatched upload gets registered.
 */

const oneMb = 1024 * 1024;
const SERVICE_CEILING = 25 * oneMb;

describe('the class policies themselves', () => {
  it('defines one for every class, with a non-empty allowlist', () => {
    for (const documentClass of DOCUMENT_CLASSES) {
      const policy = policyFor(documentClass);
      expect(policy.allowed.length).toBeGreaterThan(0);
      expect(policy.maxBytes).toBeGreaterThan(0);
    }
  });

  it('accepts no executable or markup format anywhere', () => {
    // The allowlist is the whole defence: a format that is not on it cannot be
    // uploaded, so nothing later has to be careful about rendering it.
    const everyAllowed = Object.values(CLASS_POLICY).flatMap((policy) => [...policy.allowed]);
    for (const mime of everyAllowed) {
      expect(mime).not.toMatch(/html|javascript|x-msdownload|x-sh|octet-stream/);
    }
  });

  it('keeps a photograph class from accepting a spreadsheet', () => {
    // Not a security rule but a filing one: a document under the wrong class
    // is a document nobody finds again.
    expect(CLASS_POLICY.DAMAGE_PHOTO.allowed).not.toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});

describe('checking what a client says it will upload', () => {
  it('accepts a declaration inside the policy', () => {
    expect(() =>
      assertDeclarationAllowed('CONTRACT', 'application/pdf', oneMb, SERVICE_CEILING),
    ).not.toThrow();
  });

  it('accepts it whatever the casing', () => {
    expect(() =>
      assertDeclarationAllowed('CONTRACT', 'APPLICATION/PDF', oneMb, SERVICE_CEILING),
    ).not.toThrow();
  });

  it('refuses a type the class does not accept', () => {
    expect(() =>
      assertDeclarationAllowed('CONTRACT', 'image/webp', oneMb, SERVICE_CEILING),
    ).toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }) as unknown as Error);
  });

  it('refuses an empty file', () => {
    // Refused at all three layers — here, at finalize, and by a CHECK
    // constraint — because an empty file passes a naive extension check and
    // occupies a row that looks like a document.
    expect(() =>
      assertDeclarationAllowed('CONTRACT', 'application/pdf', 0, SERVICE_CEILING),
    ).toThrow();
    expect(() =>
      assertDeclarationAllowed('CONTRACT', 'application/pdf', -1, SERVICE_CEILING),
    ).toThrow();
  });

  it('refuses a size over the class ceiling', () => {
    expect(() =>
      assertDeclarationAllowed('OTHER', 'application/pdf', 6 * oneMb, SERVICE_CEILING),
    ).toThrow();
  });

  it('applies the service ceiling when it is the lower of the two', () => {
    // A deployment that lowers `DOCUMENT_MAX_BYTES` must actually lower it,
    // not be overridden by a more generous class.
    expect(() =>
      assertDeclarationAllowed('TENDER_DOCUMENT', 'application/pdf', 20 * oneMb, 5 * oneMb),
    ).toThrow();
  });
});

describe('checking what storage actually holds', () => {
  it('accepts an object matching its class', () => {
    expect(() =>
      assertObjectAllowed('DAMAGE_PHOTO', 'image/png', 2 * oneMb, SERVICE_CEILING),
    ).not.toThrow();
  });

  it('refuses a detected type the class does not accept', () => {
    // The case the declaration check cannot catch: the client declared
    // something allowed and uploaded something else.
    expect(() =>
      assertObjectAllowed('DAMAGE_PHOTO', 'application/pdf', oneMb, SERVICE_CEILING),
    ).toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }) as unknown as Error);
  });

  it('refuses a zero-byte object', () => {
    expect(() => assertObjectAllowed('CONTRACT', 'application/pdf', 0, SERVICE_CEILING)).toThrow();
  });

  it('refuses an object larger than declared limits allow', () => {
    // Size comes from storage metadata here, so this is the check that catches
    // a client that declared one megabyte and uploaded fifty.
    expect(() =>
      assertObjectAllowed('OTHER', 'application/pdf', 50 * oneMb, SERVICE_CEILING),
    ).toThrow();
  });
});

describe('sanitising a filename for display', () => {
  it('keeps an ordinary name intact', () => {
    expect(sanitizeFilename('قرارداد-۱۴۰۴.pdf')).toBe('قرارداد-۱۴۰۴.pdf');
  });

  it('strips any path a client attached', () => {
    // Not a traversal defence — the name never reaches a path — but it stops a
    // directory appearing in a UI or a Content-Disposition header.
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\secret.pdf')).toBe('secret.pdf');
  });

  it('removes the override characters that make a name lie about its type', () => {
    // U+202E reverses what follows, so `exe.pdf` renders as `fdp.exe` — the
    // classic way a filename in a UI disagrees with the file.
    const deceptive = `invoice\u202Efdp.exe`;
    expect(sanitizeFilename(deceptive)).not.toContain('\u202E');
  });

  it('removes control characters', () => {
    expect(sanitizeFilename('report\u0000\u001b.pdf')).toBe('report.pdf');
  });

  it('replaces characters that break a header or a filesystem', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.pdf')).toBe('a_b_c_d_e_f_g_h.pdf');
  });

  it('never returns an empty name', () => {
    // A blank Content-Disposition filename makes a browser invent one.
    expect(sanitizeFilename('   ')).toBe('document');
    expect(sanitizeFilename('/')).toBe('document');
  });

  it('bounds the length', () => {
    expect(sanitizeFilename('x'.repeat(500))).toHaveLength(200);
  });
});
