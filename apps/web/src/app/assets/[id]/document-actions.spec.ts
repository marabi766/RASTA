/**
 * @jest-environment node
 */
import { createHash } from 'node:crypto';

import { BASELINE_FIELD } from '@/lib/form-fields';
import { FILE_FIELD, UPLOAD_TOKEN_FIELD } from '@/lib/asset-document-fields';
import {
  ATTACH_KEY_REUSED_MESSAGE,
  RESUME_FILE_CHANGED_MESSAGE,
  RESUME_KIND_CHANGED_MESSAGE,
  FILE_EMPTY_MESSAGE,
  FILE_MISSING_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  openUploadedDocument,
  sealAssetDocumentBaseline,
  sealUploadedDocument,
} from '@/server/asset-documents';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, isBoundSubmissionId, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_DOCUMENT_FORM } from './document-form-state';

/**
 * The attach-document form's write path (EXP-002 slice 7). Mirrors
 * `record-actions.spec.ts`: the order is the assertion, each refusal proves
 * nothing was uploaded or sent, and the asset is the page's own — bound by the
 * form, named by the baseline the page signed — never a field of it. Beyond the
 * records, the file's own chain: a file is not uploaded until the text is known
 * to be well-formed, and once it is registered a resend attaches the same
 * document under the same key instead of uploading again.
 */

const currentSession = jest.fn();
const uploadDocument = jest.fn();
const attachAssetDocument = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/asset-documents', () => {
  const actual = jest.requireActual('@/server/asset-documents');
  return {
    ...actual,
    uploadDocument: (...args: unknown[]) => uploadDocument(...args),
    attachAssetDocument: (...args: unknown[]) => attachAssetDocument(...args),
  };
});

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require('./document-actions') as typeof import('./document-actions');

const SESSION = {
  subject: 'user-1',
  username: 'manager',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const ASSET_ID = 'AST_01J00000000000000000000000';
const OTHER_ASSET_ID = 'AST_01J00000000000000000000099';

const pdf = () => new File(['%PDF-1.7 bytes'], 'title.pdf', { type: 'application/pdf' });

/** What the resume token vouches for about `pdf()`: its size and the SHA-256 of its bytes. */
const PDF_FINGERPRINT = {
  sizeBytes: Buffer.byteLength('%PDF-1.7 bytes'),
  sha256: createHash('sha256').update('%PDF-1.7 bytes').digest('hex'),
};

/** The rest of what a token for `pdf()` registered as `VALID` names. */
const REGISTERED_AS = { kind: 'OWNERSHIP_TITLE' as const, ...PDF_FINGERPRINT };

const VALID = { kind: 'OWNERSHIP_TITLE', title: 'سند مالکیت لودر', issuedAt: '', expiresAt: '' };

interface Options {
  csrf?: string | null;
  submission?: string | null;
  baseline?: string | null;
  uploaded?: string | null;
  file?: File | string | null;
}

function formData(fields: Record<string, string> = VALID, options: Options = {}): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  const baseline =
    options.baseline === undefined
      ? sealAssetDocumentBaseline(SESSION, { assetId: ASSET_ID })
      : options.baseline;
  if (baseline !== null) form.set(BASELINE_FIELD, baseline);
  if (options.uploaded) form.set(UPLOAD_TOKEN_FIELD, options.uploaded);
  const file = options.file === undefined ? pdf() : options.file;
  if (file !== null) form.set(FILE_FIELD, file);
  return form;
}

const submit = (form: FormData, assetId = ASSET_ID) =>
  actions.submitAttachDocument(assetId, IDLE_DOCUMENT_FORM, form);

const redirectedTo = async (promise: Promise<unknown>): Promise<URL> => {
  const error = await promise.then(
    () => {
      throw new Error('expected a redirect');
    },
    (caught: Error) => caught,
  );
  const match = /^NEXT_REDIRECT:(.*)$/.exec(error.message);
  if (!match) throw error;
  return new URL(match[1]!, 'http://localhost:3200');
};

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  uploadDocument.mockReset();
  uploadDocument.mockResolvedValue({
    kind: 'REGISTERED',
    documentId: 'DOC_1',
    fingerprint: PDF_FINGERPRINT,
  });
  attachAssetDocument.mockReset();
  attachAssetDocument.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'ADR_1' },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
});

const nothingSent = () => {
  expect(uploadDocument).not.toHaveBeenCalled();
  expect(attachAssetDocument).not.toHaveBeenCalled();
};

describe('what is refused before anything is uploaded or sent', () => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    expect(await submit(formData())).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    nothingSent();
  });

  it.each([null, 'someone-elses'])('refuses CSRF token %j', async (csrf) => {
    expect(await submit(formData(VALID, { csrf }))).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    nothingSent();
  });

  it('refuses a submission id the client chose, one never issued, and one minted for somebody else', async () => {
    for (const submission of [
      null,
      'chosen-by-the-client',
      `sub_${'A'.repeat(38)}`,
      mintSubmissionId({ ...SESSION, subject: 'someone-else' }),
      mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' }),
    ]) {
      expect(await submit(formData(VALID, { submission }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
    }
    nothingSent();
  });

  it('checks the session, then CSRF, then the submission id, then the baseline, then the form — in that order', async () => {
    const broken = { kind: '', title: '' };
    expect(await submit(formData(broken, { csrf: 'wrong', submission: 'wrong' }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    currentSession.mockResolvedValue(null);
    expect(await submit(formData(broken, { csrf: 'wrong' }))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    currentSession.mockResolvedValue(SESSION);
    expect(await submit(formData(broken, { submission: 'wrong' }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(await submit(formData(broken, { baseline: 'wrong' }))).toEqual({
      kind: 'REFUSED',
      reason: 'BASELINE',
    });
    nothingSent();
  });

  it('refuses a baseline that is missing, forged, somebody else’s or from an earlier login', async () => {
    const genuine = sealAssetDocumentBaseline(SESSION, { assetId: ASSET_ID });
    for (const baseline of [
      null,
      'chosen-by-the-client',
      `${genuine.slice(0, -2)}AA`,
      sealAssetDocumentBaseline({ ...SESSION, subject: 'someone-else' }, { assetId: ASSET_ID }),
      sealAssetDocumentBaseline(
        { ...SESSION, csrfToken: 'the-token-before-re-login' },
        { assetId: ASSET_ID },
      ),
    ]) {
      expect(await submit(formData(VALID, { baseline }))).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
    }
    nothingSent();
  });

  it('refuses another asset’s genuine baseline, and an action bound to another asset than the baseline names', async () => {
    expect(
      await submit(
        formData(VALID, {
          baseline: sealAssetDocumentBaseline(SESSION, { assetId: OTHER_ASSET_ID }),
        }),
      ),
    ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
    // The bound id is sent by the browser: rewritten, it no longer matches what the page signed.
    expect(await submit(formData(), OTHER_ASSET_ID)).toEqual({
      kind: 'REFUSED',
      reason: 'BASELINE',
    });
    nothingSent();
  });

  it('refuses an uploaded-document token that is forged, for another submission, for another asset, or somebody else’s', async () => {
    const submission = mintSubmissionId(SESSION);
    const genuine = sealUploadedDocument(SESSION, {
      assetId: ASSET_ID,
      submissionId: submission,
      documentId: 'DOC_1',
      ...REGISTERED_AS,
    });
    for (const uploaded of [
      'chosen-by-the-client',
      `${genuine.slice(0, -2)}AA`,
      // Genuine, but minted for another submission of this person's.
      sealUploadedDocument(SESSION, {
        assetId: ASSET_ID,
        submissionId: mintSubmissionId(SESSION),
        documentId: 'DOC_1',
        ...REGISTERED_AS,
      }),
      // Genuine, but for another machine.
      sealUploadedDocument(SESSION, {
        assetId: OTHER_ASSET_ID,
        submissionId: submission,
        documentId: 'DOC_1',
        ...REGISTERED_AS,
      }),
      sealUploadedDocument(
        { ...SESSION, subject: 'someone-else' },
        { assetId: ASSET_ID, submissionId: submission, documentId: 'DOC_1', ...REGISTERED_AS },
      ),
    ]) {
      expect(await submit(formData(VALID, { submission, uploaded }))).toEqual({
        kind: 'REFUSED',
        reason: 'UPLOAD',
      });
    }
    nothingSent();
  });
});

describe('the form is judged before the file moves', () => {
  it.each([
    ['no kind', { ...VALID, kind: '' }, 'kind'],
    ['a one-letter title', { ...VALID, title: 'س' }, 'title'],
    ['an impossible date', { ...VALID, expiresAt: '2026-02-31' }, 'expiresAt'],
  ])('uploads nothing for %s', async (_name, fields, field) => {
    const state = await submit(formData(fields));
    expect(state).toMatchObject({ kind: 'INVALID', resume: null });
    expect(Object.keys((state as { fieldErrors: object }).fieldErrors)).toEqual([field]);
    nothingSent();
  });

  it('keeps what the person typed, and the submission id, on the invalid form', async () => {
    const submission = mintSubmissionId(SESSION);
    const state = await submit(
      formData({ ...VALID, title: 'س', expiresAt: '2027-01-01' }, { submission }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { kind: 'OWNERSHIP_TITLE', title: 'س', expiresAt: '2027-01-01' },
    });
  });

  it.each([
    ['no file', null, FILE_MISSING_MESSAGE],
    ['an empty selection', new File([], '', { type: '' }), FILE_MISSING_MESSAGE],
    [
      'an empty selection as the action transport delivers it',
      new File([], 'undefined', { type: 'application/octet-stream' }),
      FILE_MISSING_MESSAGE,
    ],
    [
      'a file with no bytes',
      new File([], 'empty.pdf', { type: 'application/pdf' }),
      FILE_EMPTY_MESSAGE,
    ],
  ])('says so on the file for %s, and uploads nothing', async (_name, file, message) => {
    expect(await submit(formData(VALID, { file }))).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { file: message },
    });
    nothingSent();
  });

  it('judges the text and the file together, so one round shows every problem', async () => {
    const state = await submit(formData({ ...VALID, title: '' }, { file: null }));
    expect(Object.keys((state as { fieldErrors: object }).fieldErrors).sort()).toEqual([
      'file',
      'title',
    ]);
  });
});

describe('what is uploaded and attached, and to which asset', () => {
  it('uploads the person’s file for the page’s own asset, however the form is rewritten', async () => {
    const tampered = formData({
      ...VALID,
      assetId: OTHER_ASSET_ID,
      id: OTHER_ASSET_ID,
      documentId: 'DOC_FORGED',
      ownerResourceId: OTHER_ASSET_ID,
    });
    await redirectedTo(submit(tampered));

    expect(uploadDocument).toHaveBeenCalledTimes(1);
    const [session, call] = uploadDocument.mock.calls[0]!;
    expect(session).toBe(SESSION);
    expect(call).toMatchObject({ assetId: ASSET_ID, kind: 'OWNERSHIP_TITLE' });
    expect((call as { file: File }).file.name).toBe('title.pdf');
    expect(JSON.stringify([attachAssetDocument.mock.calls[0]?.slice(1, 3)])).not.toMatch(
      /DOC_FORGED|AST_01J00000000000000000000099/,
    );
  });

  it('attaches the document the upload produced, with the form’s body, under the form’s submission id', async () => {
    const submission = mintSubmissionId(SESSION);
    await redirectedTo(
      submit(
        formData({ ...VALID, issuedAt: '2026-10-01', expiresAt: '2027-10-01' }, { submission }),
      ),
    );

    expect(uploadDocument.mock.calls[0]![1]).toMatchObject({ submissionId: submission });
    expect(attachAssetDocument).toHaveBeenCalledTimes(1);
    const [session, assetId, documentId, body, key] = attachAssetDocument.mock.calls[0]!;
    expect(session).toBe(SESSION);
    expect(assetId).toBe(ASSET_ID);
    expect(documentId).toBe('DOC_1');
    expect(body).toEqual({
      kind: 'OWNERSHIP_TITLE',
      title: 'سند مالکیت لودر',
      issuedAt: '2026-09-30T20:30:00.000Z',
      expiresAt: '2027-09-30T20:30:00.000Z',
    });
    expect(key).toBe(submission);
  });

  it('lands on a fresh read of the asset, with a flash only this session can read for this asset', async () => {
    const target = await redirectedTo(submit(formData()));
    expect(target.pathname).toBe(`/assets/${ASSET_ID}`);
    const flash = target.searchParams.get('flash');
    expect(readFlash(SESSION, flash, ASSET_ID, ['documentAttached'])).toBe('documentAttached');
    expect(readFlash(SESSION, flash, OTHER_ASSET_ID, ['documentAttached'])).toBeUndefined();
    expect(
      readFlash({ ...SESSION, subject: 'someone-else' }, flash, ASSET_ID, ['documentAttached']),
    ).toBeUndefined();
  });
});

describe('a resend is not a second upload', () => {
  const submission = mintSubmissionId(SESSION);
  const resumeFor = (documentId = 'DOC_1') =>
    sealUploadedDocument(SESSION, {
      assetId: ASSET_ID,
      submissionId: submission,
      documentId,
      ...REGISTERED_AS,
    });

  it('gives back a token for the registered document whenever the attach does not succeed', async () => {
    const outcomes = [
      [
        { kind: 'INVALID', fieldErrors: { title: 'خطا' }, message: null, correlationId: 'c' },
        'INVALID',
      ],
      [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'c' }, 'FAILED'],
      [{ kind: 'UNKNOWN_OUTCOME', correlationId: 'c' }, 'UNCONFIRMED'],
      [{ kind: 'IN_PROGRESS', retryAfterSeconds: 1, correlationId: 'c' }, 'UNCONFIRMED'],
    ] as const;
    for (const [answer, expectedKind] of outcomes) {
      attachAssetDocument.mockResolvedValueOnce(answer);
      const state = (await submit(formData(VALID, { submission }))) as {
        kind: string;
        resume: string;
      };
      expect(state.kind).toBe(expectedKind);
      expect(
        openUploadedDocument(SESSION, state.resume, {
          assetId: ASSET_ID,
          submissionId: submission,
        }),
      ).toMatchObject({
        documentId: 'DOC_1',
      });
    }
  });

  it('attaches the same document under the same key and does not upload — even with no file in the form', async () => {
    await redirectedTo(submit(formData(VALID, { submission, uploaded: resumeFor(), file: null })));

    expect(uploadDocument).not.toHaveBeenCalled();
    const [, assetId, documentId, , key] = attachAssetDocument.mock.calls[0]!;
    expect([assetId, documentId, key]).toEqual([ASSET_ID, 'DOC_1', submission]);
  });

  it('lets the person correct the text of a refused attach and attach the same document', async () => {
    await redirectedTo(
      submit(
        formData(
          { ...VALID, title: 'عنوان اصلاح‌شده' },
          { submission, uploaded: resumeFor(), file: null },
        ),
      ),
    );
    expect(attachAssetDocument.mock.calls[0]![3]).toMatchObject({ title: 'عنوان اصلاح‌شده' });
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('keeps the token on a form that is still invalid, so the next send still skips the upload', async () => {
    const token = resumeFor();
    const state = await submit(
      formData({ ...VALID, title: '' }, { submission, uploaded: token, file: null }),
    );
    expect(state).toMatchObject({ kind: 'INVALID', resume: token });
    nothingSent();
  });
});

describe('a resend must still be the submission its token vouches for (Codex r1 on #225)', () => {
  const submission = mintSubmissionId(SESSION);
  const token = () =>
    sealUploadedDocument(SESSION, {
      assetId: ASSET_ID,
      submissionId: submission,
      documentId: 'DOC_1',
      ...REGISTERED_AS,
    });

  const startedAfresh = (state: unknown, message: string) => {
    expect(state).toMatchObject({
      kind: 'INVALID',
      message,
      resume: null,
      fieldErrors: {},
      values: expect.objectContaining({ title: VALID.title }),
    });
    // A new submission id, bound to this session: the next send is not the refused one.
    const fresh = (state as { submissionId: string }).submissionId;
    expect(fresh).not.toBe(submission);
    expect(isBoundSubmissionId(fresh, SESSION)).toBe(true);
  };

  it('puts the kind and the size and digest of the registered file into the token it gives back', async () => {
    attachAssetDocument.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'c' });
    const state = (await submit(formData(VALID, { submission }))) as { resume: string };
    expect(
      openUploadedDocument(SESSION, state.resume, { assetId: ASSET_ID, submissionId: submission }),
    ).toEqual({
      assetId: ASSET_ID,
      submissionId: submission,
      documentId: 'DOC_1',
      ...REGISTERED_AS,
    });
  });

  it('refuses a changed kind, attaches nothing, and starts afresh — the old file is not attached under the new label', async () => {
    const state = await submit(
      formData({ ...VALID, kind: 'PHOTO' }, { submission, uploaded: token(), file: null }),
    );

    startedAfresh(state, RESUME_KIND_CHANGED_MESSAGE);
    expect(attachAssetDocument).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses a different file in the post — it would be ignored while the person believes it was attached', async () => {
    const other = new File(['%PDF-1.7 other bytes!'], 'other.pdf', { type: 'application/pdf' });
    const state = await submit(formData(VALID, { submission, uploaded: token(), file: other }));

    startedAfresh(state, RESUME_FILE_CHANGED_MESSAGE);
    expect(attachAssetDocument).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses a file of the same size and another digest', async () => {
    const sameSize = new File(['%PDF-1.7 bytez'], 'same-size.pdf', { type: 'application/pdf' });
    expect(sameSize.size).toBe(PDF_FINGERPRINT.sizeBytes);

    startedAfresh(
      await submit(formData(VALID, { submission, uploaded: token(), file: sameSize })),
      RESUME_FILE_CHANGED_MESSAGE,
    );
    expect(attachAssetDocument).not.toHaveBeenCalled();
  });

  it('accepts the very same file in the post: the digest matches, nothing is uploaded again', async () => {
    await redirectedTo(submit(formData(VALID, { submission, uploaded: token(), file: pdf() })));

    expect(uploadDocument).not.toHaveBeenCalled();
    expect(attachAssetDocument.mock.calls[0]![2]).toBe('DOC_1');
  });

  it('still lets the title and the dates be corrected: the kind is what the file was stored under, the text is not', async () => {
    await redirectedTo(
      submit(
        formData(
          { ...VALID, title: 'عنوان اصلاح‌شده' },
          { submission, uploaded: token(), file: null },
        ),
      ),
    );
    expect(attachAssetDocument.mock.calls[0]![3]).toMatchObject({ title: 'عنوان اصلاح‌شده' });
  });

  it('judges the text first: a bad title is the title’s error, not a kind mismatch', async () => {
    const state = await submit(
      formData(
        { ...VALID, kind: 'PHOTO', title: '' },
        { submission, uploaded: token(), file: null },
      ),
    );
    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { title: expect.any(String) } });
  });
});

describe('a lost answer is not a dead end, and never a second reference (Codex r1 on #225)', () => {
  it('answers the key conflict a resend meets with a plain sentence and a fresh submission id', async () => {
    // The first send attached DOC_1 and its answer never arrived: the browser has
    // no token. The resend uploads and registers DOC_2, and the key is taken.
    const submission = mintSubmissionId(SESSION);
    uploadDocument.mockResolvedValueOnce({
      kind: 'REGISTERED',
      documentId: 'DOC_2',
      fingerprint: PDF_FINGERPRINT,
    });
    attachAssetDocument.mockResolvedValueOnce({
      kind: 'INVALID',
      fieldErrors: {},
      message: ATTACH_KEY_REUSED_MESSAGE,
      correlationId: 'c-409',
    });

    const state = (await submit(formData(VALID, { submission }))) as {
      kind: string;
      submissionId: string;
      message: string;
      resume: string | null;
    };

    expect(state).toMatchObject({
      kind: 'INVALID',
      message: ATTACH_KEY_REUSED_MESSAGE,
      resume: null,
      values: expect.objectContaining({ title: VALID.title }),
    });
    expect(state.submissionId).not.toBe(submission);
    expect(isBoundSubmissionId(state.submissionId, SESSION)).toBe(true);
    // The message tells the person to look at the list first, in words.
    expect(ATTACH_KEY_REUSED_MESSAGE).toMatch(/فهرست مدارک/);
    expect(ATTACH_KEY_REUSED_MESSAGE).toMatch(/فرم تازه/);
    // Exactly one attach was tried; the service refused it, so there is one reference at most.
    expect(attachAssetDocument).toHaveBeenCalledTimes(1);
  });

  it('lets the next send, with the fresh id and the file chosen again, go through under that new key', async () => {
    const first = mintSubmissionId(SESSION);
    uploadDocument.mockResolvedValueOnce({
      kind: 'REGISTERED',
      documentId: 'DOC_2',
      fingerprint: PDF_FINGERPRINT,
    });
    attachAssetDocument.mockResolvedValueOnce({
      kind: 'INVALID',
      fieldErrors: {},
      message: ATTACH_KEY_REUSED_MESSAGE,
      correlationId: 'c-409',
    });
    const refused = (await submit(formData(VALID, { submission: first }))) as {
      submissionId: string;
    };

    uploadDocument.mockResolvedValueOnce({
      kind: 'REGISTERED',
      documentId: 'DOC_3',
      fingerprint: PDF_FINGERPRINT,
    });
    await redirectedTo(submit(formData(VALID, { submission: refused.submissionId })));

    const [, , documentId, , key] = attachAssetDocument.mock.calls.at(-1)!;
    expect([documentId, key]).toEqual(['DOC_3', refused.submissionId]);
    expect(key).not.toBe(first);
  });

  it('does not treat any other refusal of the attach as a conflict: the same submission id stays', async () => {
    const submission = mintSubmissionId(SESSION);
    attachAssetDocument.mockResolvedValueOnce({
      kind: 'INVALID',
      fieldErrors: { title: 'خطا' },
      message: null,
      correlationId: 'c',
    });
    const state = (await submit(formData(VALID, { submission }))) as {
      submissionId: string;
      resume: string;
    };
    expect(state.submissionId).toBe(submission);
    expect(state.resume).toEqual(expect.any(String));
  });
});

describe('what the services answered', () => {
  it('words document-service’s refusal on the file, and leaves nothing to resume', async () => {
    uploadDocument.mockResolvedValue({ kind: 'REFUSED', message: FILE_TOO_LARGE_MESSAGE });
    expect(await submit(formData())).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { file: FILE_TOO_LARGE_MESSAGE },
      resume: null,
    });
    expect(attachAssetDocument).not.toHaveBeenCalled();
  });

  it.each([
    [
      { kind: 'FORBIDDEN', correlationId: 'c1' },
      { kind: 'FORBIDDEN', correlationId: 'c1' },
    ],
    [
      { kind: 'FAILED', status: 503, correlationId: 'c2' },
      { kind: 'FAILED', status: 503, correlationId: 'c2', resume: null },
    ],
    [
      { kind: 'UNCONFIRMED', correlationId: 'c3' },
      { kind: 'UNCONFIRMED', correlationId: 'c3', resume: null },
    ],
  ])('says %j of the upload as %j, and attaches nothing', async (outcome, expected) => {
    uploadDocument.mockResolvedValue(outcome);
    expect(await submit(formData())).toEqual(expected);
    expect(attachAssetDocument).not.toHaveBeenCalled();
  });

  it('answers another organization’s machine, at the attach, with the same state as a missing one — a correlation id and nothing else', async () => {
    attachAssetDocument.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-x' });
    expect(await submit(formData())).toEqual({ kind: 'NOT_FOUND', correlationId: 'corr-x' });
  });

  it('says a forbidden role at the attach as forbidden', async () => {
    attachAssetDocument.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-f' });
    expect(await submit(formData())).toEqual({ kind: 'FORBIDDEN', correlationId: 'corr-f' });
  });

  it('says it when the file is registered and the reference was refused with no field to blame', async () => {
    attachAssetDocument.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: null,
      correlationId: 'c',
    });
    const state = (await submit(formData())) as { kind: string; message: string; resume: string };
    expect(state.kind).toBe('INVALID');
    expect(state.message).toContain('فایل بارگذاری شد');
    expect(state.resume).toEqual(expect.any(String));
  });
});
