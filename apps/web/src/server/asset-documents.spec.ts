/**
 * @jest-environment node
 */
import {
  EMPTY_ATTACH_DOCUMENT_FORM,
  FILE_FIELD,
  type DocumentKind,
} from '@/lib/asset-document-fields';

import {
  DOCUMENT_CLASS_BY_KIND,
  FILE_CONTENT_MISMATCH_MESSAGE,
  ATTACH_KEY_REUSED_MESSAGE,
  FILE_EMPTY_MESSAGE,
  FILE_MISSING_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  FILE_TYPE_NOT_ACCEPTED_MESSAGE,
  UPLOAD_EXPIRED_MESSAGE,
  attachAssetDocument,
  attachDocumentFormValues,
  canAttachAssetDocuments,
  chosenFile,
  fingerprintOf,
  resumeMismatch,
  documentValidityAt,
  openAssetDocumentBaseline,
  openUploadedDocument,
  parseAttachDocumentForm,
  sealAssetDocumentBaseline,
  sealUploadedDocument,
  uploadDocument,
} from './asset-documents';
import type { WebSession } from './session';

/**
 * The attach-document command: who is offered the form, what a person may type
 * and in what words a mistake is reported, the signed tokens a form carries, the
 * four-step chain a file travels (what is sent to which service, in which order,
 * and what each failure leaves behind), and what the services say, in Persian.
 *
 * The form's rules are a courtesy that saves a round trip; the services are the
 * enforcement (`asset-documents.contract.spec.ts` pins the two together).
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

const ASSET = 'AST_01J00000000000000000000000';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const UPLOADED = {
  assetId: ASSET,
  submissionId: SUBMISSION,
  documentId: 'DOC_1',
  kind: 'OWNERSHIP_TITLE' as const,
  sizeBytes: 8,
  sha256: 'a'.repeat(64),
};
const SIGNED_URL =
  'http://storage.test:9000/rasta-documents/org/obj?X-Amz-Signature=secret-signature';

const FORM = {
  ...EMPTY_ATTACH_DOCUMENT_FORM,
  kind: 'OWNERSHIP_TITLE',
  title: 'سند مالکیت لودر',
};

describe('who is offered the form', () => {
  it.each([
    [['ORGANIZATION_ADMIN'], true],
    [['FLEET_MANAGER'], true],
    [['UNION_ADMIN'], true],
    [['OPERATOR'], false],
    [['DRIVER', 'OPERATOR'], false],
    [[], false],
  ])('%j: %s', (roles, expected) => {
    expect(canAttachAssetDocuments(roles)).toBe(expected);
  });
});

describe('the form', () => {
  it('reads every text field, and a missing one as blank', () => {
    const form = new FormData();
    form.set('title', 'X');
    expect(attachDocumentFormValues(form)).toEqual({ ...EMPTY_ATTACH_DOCUMENT_FORM, title: 'X' });
  });

  it('turns what was typed into the body the service takes, dates as Tehran midnight', () => {
    expect(
      parseAttachDocumentForm({
        kind: 'INSURANCE_POLICY',
        title: '  بیمه‌نامهٔ   شخص ثالث ',
        issuedAt: '2026-10-01',
        expiresAt: '2027-10-01',
      }),
    ).toEqual({
      ok: true,
      body: {
        kind: 'INSURANCE_POLICY',
        title: 'بیمه‌نامهٔ شخص ثالث',
        issuedAt: '2026-09-30T20:30:00.000Z',
        expiresAt: '2027-09-30T20:30:00.000Z',
      },
    });
  });

  it('leaves a blank date out of the body', () => {
    const parsed = parseAttachDocumentForm(FORM);
    expect(parsed).toEqual({
      ok: true,
      body: { kind: 'OWNERSHIP_TITLE', title: 'سند مالکیت لودر' },
    });
  });

  it('does not invent a rule the service does not have: an expiry before the issue date is sent', () => {
    expect(
      parseAttachDocumentForm({ ...FORM, issuedAt: '2026-10-01', expiresAt: '2025-01-01' }).ok,
    ).toBe(true);
  });

  it.each([
    ['no kind', { kind: '' }, 'kind'],
    ['an unknown kind', { kind: 'SECRET' }, 'kind'],
    ['a blank title', { title: '   ' }, 'title'],
    ['a one-letter title', { title: 'س' }, 'title'],
    ['a title over 200 characters', { title: 'س'.repeat(201) }, 'title'],
    [
      'a title with a right-to-left override',
      { title: `سند${String.fromCodePoint(0x202e)}x` },
      'title',
    ],
    [
      'an Arabic letter mark in the title',
      { title: `سند${String.fromCodePoint(0x061c)}ی` },
      'title',
    ],
    ['a title with a script tag', { title: '<script>x</script>' }, 'title'],
    ['an impossible date', { issuedAt: '2026-02-31' }, 'issuedAt'],
    ['text for an expiry', { expiresAt: 'فردا' }, 'expiresAt'],
  ] as const)('refuses %s, on the field that holds it', (_name, over, field) => {
    const parsed = parseAttachDocumentForm({ ...FORM, ...over });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(Object.keys(parsed.fieldErrors)).toEqual([field]);
  });
});

describe('the file the person chose', () => {
  const formWith = (value: FormDataEntryValue | null) => {
    const form = new FormData();
    if (value !== null) form.set(FILE_FIELD, value);
    return form;
  };

  it('is any file with a name and some bytes — its type and size are the service’s to judge', () => {
    const file = new File(['%PDF-1.7'], 'title.pdf', { type: 'application/pdf' });
    expect(chosenFile(formWith(file), FILE_FIELD)).toEqual({ ok: true, file });
    // A type and size no table here knows are not refused here.
    const odd = new File([new Uint8Array(30 * 1024 * 1024)], 'huge.bin', { type: 'x/odd' });
    expect(chosenFile(formWith(odd), FILE_FIELD).ok).toBe(true);
  });

  it.each([
    ['no file field at all', null, FILE_MISSING_MESSAGE],
    ['a text value where a file belongs', 'not-a-file', FILE_MISSING_MESSAGE],
    [
      'the empty selection a browser sends for no file',
      new File([], '', { type: '' }),
      FILE_MISSING_MESSAGE,
    ],
    [
      'the empty selection React’s action transport hands over: a zero-byte file named "undefined"',
      new File([], 'undefined', { type: 'application/octet-stream' }),
      FILE_MISSING_MESSAGE,
    ],
    [
      'a file with no bytes',
      new File([], 'empty.pdf', { type: 'application/pdf' }),
      FILE_EMPTY_MESSAGE,
    ],
  ])('refuses %s', (_name, value, message) => {
    expect(chosenFile(formWith(value), FILE_FIELD)).toEqual({ ok: false, message });
  });
});

describe('which document-service class a kind is stored under', () => {
  it('names a class for every kind, and the narrowest for a kind that says nothing about the file', () => {
    expect(Object.keys(DOCUMENT_CLASS_BY_KIND).sort()).toEqual(
      [
        'OWNERSHIP_TITLE',
        'REGISTRATION_CARD',
        'INSURANCE_POLICY',
        'TECHNICAL_INSPECTION',
        'PURCHASE_INVOICE',
        'MANUAL',
        'PHOTO',
        'OTHER',
      ].sort(),
    );
    for (const kind of [
      'OWNERSHIP_TITLE',
      'REGISTRATION_CARD',
      'PURCHASE_INVOICE',
      'MANUAL',
      'OTHER',
    ]) {
      expect(DOCUMENT_CLASS_BY_KIND[kind as DocumentKind]).toBe('OTHER');
    }
  });
});

describe('the tokens a form carries', () => {
  it('opens a baseline this session was given, and nothing else', () => {
    const token = sealAssetDocumentBaseline(SESSION, { assetId: ASSET });
    expect(openAssetDocumentBaseline(SESSION, token)).toEqual(
      expect.objectContaining({ assetId: ASSET }),
    );
    expect(openAssetDocumentBaseline({ ...SESSION, subject: 'someone-else' }, token)).toBeNull();
    expect(openAssetDocumentBaseline({ ...SESSION, csrfToken: 'earlier-login' }, token)).toBeNull();
    expect(openAssetDocumentBaseline(SESSION, `${token.slice(0, -2)}AA`)).toBeNull();
    expect(openAssetDocumentBaseline(SESSION, null)).toBeNull();
  });

  it('opens an uploaded-document token only for exactly this machine and this submission', () => {
    const token = sealUploadedDocument(SESSION, UPLOADED);
    const expected = { assetId: ASSET, submissionId: SUBMISSION };
    expect(openUploadedDocument(SESSION, token, expected)).toEqual(
      expect.objectContaining({ documentId: 'DOC_1' }),
    );
    expect(openUploadedDocument(SESSION, token, { ...expected, assetId: 'AST_OTHER' })).toBeNull();
    expect(
      openUploadedDocument(SESSION, token, { ...expected, submissionId: 'sub_OTHER' }),
    ).toBeNull();
    expect(
      openUploadedDocument({ ...SESSION, subject: 'someone-else' }, token, expected),
    ).toBeNull();
    expect(openUploadedDocument(SESSION, 'forged', expected)).toBeNull();
  });

  it('cannot be passed off as a baseline, or the other way round', () => {
    const baseline = sealAssetDocumentBaseline(SESSION, { assetId: ASSET });
    const uploaded = sealUploadedDocument(SESSION, UPLOADED);
    expect(
      openUploadedDocument(SESSION, baseline, { assetId: ASSET, submissionId: SUBMISSION }),
    ).toBeNull();
    expect(openAssetDocumentBaseline(SESSION, uploaded)).toBeNull();
  });
});

describe('a document’s own validity, on the server’s clock', () => {
  const now = new Date('2027-01-01T00:00:00.000Z');
  it.each([
    ['no expiry never expires', null, 'NO_EXPIRY'],
    ['before the expiry', '2027-06-01T00:00:00.000Z', 'CURRENT'],
    ['at the expiry instant', '2027-01-01T00:00:00.000Z', 'EXPIRED'],
    ['after the expiry', '2026-06-01T00:00:00.000Z', 'EXPIRED'],
    ['an expiry that cannot be read is not current', 'soon', 'EXPIRED'],
  ])('%s', (_name, expiresAt, expected) => {
    expect(documentValidityAt(expiresAt, now)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A gateway that answers each call from `answers` in order, recording what it was sent. */
function gateway(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = answers.shift();
    if (!next) throw new Error('unexpected gateway call');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

function storage(answer: Response | Error) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    bytes: number;
    redirect?: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      bytes: (init?.body as Uint8Array | undefined)?.byteLength ?? -1,
      redirect: init?.redirect,
    });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, fetchImpl };
}

const intent = () =>
  json(201, {
    uploadIntentId: 'UPI_1',
    uploadUrl: SIGNED_URL,
    expiresAt: '2026-10-05T10:00:00.000Z',
    maxBytes: 8,
  });
const registered = () => json(201, { id: 'DOC_1', scanState: 'PENDING' });

const FILE = new File(['%PDF-1.7'], 'title.pdf', { type: 'application/pdf' });

const upload = (
  g: ReturnType<typeof gateway>,
  s: ReturnType<typeof storage>,
  file = FILE,
  kind: DocumentKind = 'OWNERSHIP_TITLE',
) =>
  uploadDocument(SESSION, {
    assetId: ASSET,
    kind,
    file,
    submissionId: SUBMISSION,
    fetchImpl: g.fetchImpl,
    storageFetchImpl: s.fetchImpl,
  });

describe('the chain a file travels', () => {
  it('asks document-service, puts the bytes in storage, registers the document — in that order', async () => {
    const g = gateway([intent(), registered()]);
    const s = storage(new Response(null, { status: 200 }));

    const outcome = await upload(g, s);

    expect(outcome).toEqual({
      kind: 'REGISTERED',
      documentId: 'DOC_1',
      fingerprint: await fingerprintOf(FILE),
    });
    expect(g.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /v1/documents/upload-url',
      'POST /v1/documents',
    ]);
    // What is declared is what the browser said — no limit of the portal's own.
    expect(g.calls[0]!.body).toEqual({
      documentClass: 'OTHER',
      contentType: 'application/pdf',
      sizeBytes: 8,
      filename: 'title.pdf',
    });
    expect(s.calls).toEqual([
      {
        url: SIGNED_URL,
        method: 'PUT',
        headers: { 'content-type': 'application/pdf' },
        bytes: 8,
        redirect: 'error',
      },
    ]);
    // The registered document is tied to the machine, by reference only.
    expect(g.calls[1]!.body).toEqual({
      uploadIntentId: 'UPI_1',
      ownerResourceType: 'Asset',
      ownerResourceId: ASSET,
    });
    // Both gateway calls carry the session's token and the submission as the key.
    for (const call of g.calls) {
      expect(call.headers.authorization).toBe('Bearer access-token-value');
      expect(call.headers['idempotency-key']).toBe(SUBMISSION);
    }
  });

  it.each([
    ['INSURANCE_POLICY', 'INSURANCE_POLICY'],
    ['TECHNICAL_INSPECTION', 'INSPECTION_REPORT'],
    ['PHOTO', 'DAMAGE_PHOTO'],
    ['MANUAL', 'OTHER'],
  ] as const)('files a %s under the class %s', async (kind, documentClass) => {
    const g = gateway([intent(), registered()]);
    await upload(g, storage(new Response(null, { status: 200 })), FILE, kind);
    expect((g.calls[0]!.body as { documentClass: string }).documentClass).toBe(documentClass);
  });

  it('never puts the signed URL anywhere but the storage request', async () => {
    const g = gateway([intent(), registered()]);
    const s = storage(new Response(null, { status: 200 }));
    await upload(g, s);
    expect(JSON.stringify(g.calls[1])).not.toContain('secret-signature');
  });

  it.each([
    [
      'a type this class does not take',
      'This content type is not accepted for this document class',
      FILE_TYPE_NOT_ACCEPTED_MESSAGE,
    ],
    [
      'a size over the class limit',
      'The declared size exceeds the limit for this document class',
      FILE_TOO_LARGE_MESSAGE,
    ],
    ['an empty file', 'An empty file cannot be uploaded', FILE_EMPTY_MESSAGE],
  ])(
    'words document-service’s refusal of %s — and sends nothing to storage',
    async (_what, sentence, persian) => {
      const g = gateway([json(422, { code: 'BUSINESS_RULE_VIOLATION', message: sentence })]);
      const s = storage(new Response(null, { status: 200 }));

      expect(await upload(g, s)).toEqual({ kind: 'REFUSED', message: persian });
      expect(s.calls).toHaveLength(0);
      expect(g.calls).toHaveLength(1);
    },
  );

  it('says a sentence it does not know as it arrived — visibly foreign, not hidden', async () => {
    const g = gateway([
      json(422, { code: 'BUSINESS_RULE_VIOLATION', message: 'A brand new rule' }),
    ]);
    expect(await upload(g, storage(new Response(null, { status: 200 })))).toEqual({
      kind: 'REFUSED',
      message: 'A brand new rule',
    });
  });

  it('words a refused file name on the file', async () => {
    const g = gateway([
      json(400, {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        details: [{ path: 'filename', message: 'Contains unsupported characters' }],
      }),
    ]);
    const outcome = await upload(g, storage(new Response(null, { status: 200 })));
    expect(outcome.kind).toBe('REFUSED');
  });

  it('answers a forbidden role as forbidden, and leaves nothing behind', async () => {
    const g = gateway([
      json(403, { code: 'FORBIDDEN', message: 'no' }, { 'x-correlation-id': 'c' }),
    ]);
    const outcome = await upload(g, storage(new Response(null, { status: 200 })));
    expect(outcome.kind).toBe('FORBIDDEN');
  });

  it.each([
    ['storage refuses the bytes', new Response(null, { status: 403 })],
    ['storage cannot be reached', new TypeError('fetch failed')],
  ])(
    'when %s: nothing is registered, and the document is never asked for',
    async (_what, answer) => {
      const g = gateway([intent()]);
      const outcome = await upload(g, storage(answer));
      expect(outcome.kind).toBe('FAILED');
      expect(g.calls).toHaveLength(1);
    },
  );

  it('refuses an upload URL that is not HTTP(S), without calling anything', async () => {
    const g = gateway([json(201, { uploadIntentId: 'UPI_1', uploadUrl: 'file:///etc/passwd' })]);
    const s = storage(new Response(null, { status: 200 }));
    expect((await upload(g, s)).kind).toBe('FAILED');
    expect(s.calls).toHaveLength(0);
  });

  it.each([
    [
      'content that is not the declared type',
      'The uploaded content does not match the declared content type',
      FILE_CONTENT_MISMATCH_MESSAGE,
    ],
    ['an intent that expired', 'This upload intent has expired', UPLOAD_EXPIRED_MESSAGE],
    [
      'a size over the limit found in storage',
      'The uploaded object exceeds the limit for this class',
      FILE_TOO_LARGE_MESSAGE,
    ],
  ])('words document-service’s refusal at registration of %s', async (_what, sentence, persian) => {
    const g = gateway([
      intent(),
      json(422, { code: 'BUSINESS_RULE_VIOLATION', message: sentence }),
    ]);
    const outcome = await upload(g, storage(new Response(null, { status: 200 })));
    expect(outcome).toEqual({ kind: 'REFUSED', message: persian });
  });

  it('says a registration that was sent and not confirmed is unconfirmed — never "nothing was saved"', async () => {
    const g = gateway([intent(), new TypeError('terminated')]);
    const outcome = await upload(g, storage(new Response(null, { status: 200 })));
    expect(outcome.kind).toBe('UNCONFIRMED');
  });
});

describe('the reference on the machine', () => {
  it('posts to the machine’s path with the document, the form’s body and the submission as the key', async () => {
    const g = gateway([json(201, { id: 'ADR_1', documentId: 'DOC_1' })]);

    const result = await attachAssetDocument(
      SESSION,
      ASSET,
      'DOC_1',
      { kind: 'OWNERSHIP_TITLE', title: 'سند مالکیت لودر' },
      SUBMISSION,
      g.fetchImpl,
    );

    expect(result.kind).toBe('CREATED');
    expect(g.calls).toHaveLength(1);
    expect(new URL(g.calls[0]!.url).pathname).toBe(`/v1/assets/${ASSET}/documents`);
    expect(g.calls[0]!.body).toEqual({
      documentId: 'DOC_1',
      kind: 'OWNERSHIP_TITLE',
      title: 'سند مالکیت لودر',
    });
    expect(g.calls[0]!.headers['idempotency-key']).toBe(SUBMISSION);
  });

  it('encodes the asset id into the path rather than interpolating it', async () => {
    const g = gateway([json(201, { id: 'ADR_1' })]);
    await attachAssetDocument(
      SESSION,
      'a/../b',
      'DOC_1',
      { kind: 'OTHER', title: 'مدرک' },
      SUBMISSION,
      g.fetchImpl,
    );
    expect(new URL(g.calls[0]!.url).pathname).toBe('/v1/assets/a%2F..%2Fb/documents');
  });

  it('places the service’s field errors on the form’s fields', async () => {
    const g = gateway([
      json(400, {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        details: [{ path: 'title', message: 'Contains unsupported characters' }],
      }),
    ]);
    const result = await attachAssetDocument(
      SESSION,
      ASSET,
      'DOC_1',
      { kind: 'OTHER', title: 'مدرک' },
      SUBMISSION,
      g.fetchImpl,
    );
    expect(result).toMatchObject({ kind: 'INVALID', fieldErrors: { title: expect.any(String) } });
  });

  it('words a reused key', async () => {
    const g = gateway([
      json(409, {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used with a different request body',
      }),
    ]);
    const result = await attachAssetDocument(
      SESSION,
      ASSET,
      'DOC_1',
      { kind: 'OTHER', title: 'مدرک' },
      SUBMISSION,
      g.fetchImpl,
    );
    expect(result).toMatchObject({ kind: 'INVALID', message: ATTACH_KEY_REUSED_MESSAGE });
  });

  it('answers another organization’s machine as a missing one', async () => {
    const g = gateway([json(404, { code: 'NOT_FOUND', message: 'Asset not found' })]);
    const result = await attachAssetDocument(
      SESSION,
      ASSET,
      'DOC_1',
      { kind: 'OTHER', title: 'مدرک' },
      SUBMISSION,
      g.fetchImpl,
    );
    expect(result.kind).toBe('NOT_FOUND');
  });
});

describe('what the resume token vouches for (Codex r1 on #225)', () => {
  it('names the kind, the size and the digest of the registered file, and refuses a token that lacks any', () => {
    const token = sealUploadedDocument(SESSION, UPLOADED);
    expect(
      openUploadedDocument(SESSION, token, { assetId: ASSET, submissionId: SUBMISSION }),
    ).toEqual(UPLOADED);

    // A token minted without them — the shape before this round — does not open.
    const { signPayload } = jest.requireActual(
      './signed-payload',
    ) as typeof import('./signed-payload');
    const old = signPayload(
      SESSION,
      'asset-document-uploaded',
      { assetId: ASSET, submissionId: SUBMISSION, documentId: 'DOC_1' },
      3600,
    );
    expect(
      openUploadedDocument(SESSION, old, { assetId: ASSET, submissionId: SUBMISSION }),
    ).toBeNull();
  });

  it('fingerprints the bytes: the size and the SHA-256, whatever the file is called', async () => {
    const a = await fingerprintOf(new File(['abc'], 'one.pdf'));
    const b = await fingerprintOf(new File(['abc'], 'two.pdf', { type: 'application/pdf' }));
    expect(a).toEqual({
      sizeBytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    expect(b).toEqual(a);
    expect(await fingerprintOf(new File(['abd'], 'one.pdf'))).not.toEqual(a);
  });

  const fp = { sizeBytes: UPLOADED.sizeBytes, sha256: UPLOADED.sha256 };

  it.each([
    ['the same kind and no file in the post', { kind: 'OWNERSHIP_TITLE', file: null }, null],
    ['the same kind and the same file', { kind: 'OWNERSHIP_TITLE', file: fp }, null],
    ['another kind', { kind: 'PHOTO', file: null }, 'KIND'],
    ['another kind, whatever the file', { kind: 'PHOTO', file: fp }, 'KIND'],
    [
      'the same kind and a file of another size',
      { kind: 'OWNERSHIP_TITLE', file: { ...fp, sizeBytes: 9 } },
      'FILE',
    ],
    [
      'the same kind and a file of another digest',
      { kind: 'OWNERSHIP_TITLE', file: { ...fp, sha256: 'b'.repeat(64) } },
      'FILE',
    ],
  ] as const)('is a resend of the same document for %s: %s', (_what, attempt, expected) => {
    expect(resumeMismatch(UPLOADED, attempt)).toBe(expected);
  });
});
