/**
 * @jest-environment node
 */

import {
  MAX_EVIDENCE_ITEMS,
  REVIEWER_NOTE_HINT,
  SUPPLIER_COMMANDS,
  SUPPLIER_COMMAND_CONSEQUENCES,
  SUPPLIER_COMMAND_LABELS,
  SUPPLIER_NOTICES,
  SUPPLIER_NOTICE_TEXT,
  approveFormValues,
  parseApproveForm,
  parseRegisterForm,
  parseRejectForm,
  parseReinstateForm,
  parseSubmitForm,
  parseSuspendForm,
  reasonFormValues,
  registerFormValues,
  rejectFormValues,
  submitFormValues,
} from './supplier-commands';

/**
 * How a supplier form is read and checked before anything is sent, and the
 * spelling of these screens: the standard orthography (`orthography.spec.ts`).
 */

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
  }
  return data;
}

describe('registration', () => {
  it('reads the name (letters and spaces normalised) and every ticked category', () => {
    expect(
      registerFormValues(
        form({
          displayName: '  تعمير‌گاه   البرز ',
          capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
        }),
      ),
    ).toEqual({
      displayName: 'تعمیر‌گاه البرز',
      capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
    });
  });

  it.each([
    [{ displayName: 'ا', capabilities: ['GOODS_SUPPLY'] }, 'displayName'],
    [{ displayName: 'x'.repeat(201), capabilities: ['GOODS_SUPPLY'] }, 'displayName'],
    [{ displayName: 'نام خوب', capabilities: [] }, 'capabilities'],
    [{ displayName: 'نام خوب', capabilities: ['NOT_A_CAPABILITY'] }, 'capabilities'],
    [{ displayName: 'نام خوب', capabilities: ['GOODS_SUPPLY', 'GOODS_SUPPLY'] }, 'capabilities'],
    [
      { displayName: `نام${String.fromCodePoint(0x202e)}بد`, capabilities: ['GOODS_SUPPLY'] },
      'displayName',
    ],
  ])('names the field that is wrong for %j', (values, wrong) => {
    const parsed = parseRegisterForm(values);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : Object.keys(parsed.fieldErrors)).toContain(wrong);
  });

  it('sends exactly the service’s two fields', () => {
    const parsed = parseRegisterForm({ displayName: 'نام خوب', capabilities: ['CONTRACTING'] });
    expect(parsed).toEqual({
      ok: true,
      body: { displayName: 'نام خوب', capabilities: ['CONTRACTING'] },
    });
  });
});

describe('a qualification request', () => {
  const read = (fields: Record<string, string>) => submitFormValues(form(fields));

  it('skips an evidence row with nothing in it and keeps the order of the rest', () => {
    const values = read({
      capability: 'GOODS_SUPPLY',
      evidenceDocumentId_0: ' DOC_A ',
      evidenceLabel_0: 'پروانه',
      evidenceDocumentId_2: 'DOC_B',
    });
    expect(values.evidence).toEqual([
      { documentId: 'DOC_A', label: 'پروانه' },
      { documentId: 'DOC_B', label: '' },
    ]);
  });

  it('reads at most the twenty rows the service takes', () => {
    const fields: Record<string, string> = { capability: 'GOODS_SUPPLY' };
    for (let i = 0; i < 30; i += 1) fields[`evidenceDocumentId_${i}`] = `DOC_${i}`;
    expect(read(fields).evidence).toHaveLength(MAX_EVIDENCE_ITEMS);
  });

  it('sends no statement, no label and no evidence it was not given — evidence is optional', () => {
    expect(parseSubmitForm(read({ capability: 'GOODS_SUPPLY' }))).toEqual({
      ok: true,
      body: { capability: 'GOODS_SUPPLY', evidence: [] },
    });
  });

  it('sends the statement and each document with its label only when written', () => {
    const parsed = parseSubmitForm(
      read({
        capability: 'CONTRACTING',
        statement: 'سابقه ده ساله',
        evidenceDocumentId_0: 'DOC_A',
        evidenceLabel_0: 'پروانه',
        evidenceDocumentId_1: 'DOC_B',
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      body: {
        capability: 'CONTRACTING',
        statement: 'سابقه ده ساله',
        evidence: [{ documentId: 'DOC_A', label: 'پروانه' }, { documentId: 'DOC_B' }],
      },
    });
  });

  it.each([
    [{ capability: '' }, 'capability'],
    [{ capability: 'OTHER' }, 'capability'],
    [{ capability: 'GOODS_SUPPLY', statement: 'x'.repeat(2001) }, 'statement'],
    [{ capability: 'GOODS_SUPPLY', evidenceLabel_0: 'برچسب بی‌سند' }, 'evidence'],
    [{ capability: 'GOODS_SUPPLY', evidenceDocumentId_0: 'D'.repeat(65) }, 'evidence'],
    [
      { capability: 'GOODS_SUPPLY', evidenceDocumentId_0: `DOC${String.fromCodePoint(0x200c)}1` },
      'evidence',
    ],
    [
      { capability: 'GOODS_SUPPLY', evidenceDocumentId_0: 'DOC_A', evidenceDocumentId_1: 'DOC_A' },
      'evidence',
    ],
  ])('names the field that is wrong for %j', (fields, wrong) => {
    const parsed = parseSubmitForm(read(fields));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : Object.keys(parsed.fieldErrors)).toContain(wrong);
  });
});

describe('the decisions and the suspension', () => {
  it('approval sends the private note only when written', () => {
    expect(parseApproveForm(approveFormValues(form({})))).toEqual({ ok: true, body: {} });
    expect(parseApproveForm(approveFormValues(form({ note: ' مستندات کامل ' })))).toEqual({
      ok: true,
      body: { note: 'مستندات کامل' },
    });
    expect(parseApproveForm({ note: 'x'.repeat(2001) }).ok).toBe(false);
  });

  it('rejection needs a stated reason of at least eight characters, the note is optional', () => {
    expect(parseRejectForm(rejectFormValues(form({ reason: 'کوتاه' }))).ok).toBe(false);
    expect(parseRejectForm(rejectFormValues(form({ reason: 'x'.repeat(501) }))).ok).toBe(false);
    expect(parseRejectForm(rejectFormValues(form({ reason: 'سند پیوست خوانا نیست' })))).toEqual({
      ok: true,
      body: { reason: 'سند پیوست خوانا نیست' },
    });
    expect(
      parseRejectForm(rejectFormValues(form({ reason: 'سند پیوست خوانا نیست', note: 'یادداشت' }))),
    ).toEqual({ ok: true, body: { reason: 'سند پیوست خوانا نیست', note: 'یادداشت' } });
  });

  it.each([parseSuspendForm, parseReinstateForm])(
    'a suspension or reinstatement needs a reason of eight to five hundred characters',
    (parse) => {
      expect(parse(reasonFormValues(form({}))).ok).toBe(false);
      expect(parse({ reason: '1234567' }).ok).toBe(false);
      expect(parse({ reason: '12345678' })).toEqual({ ok: true, body: { reason: '12345678' } });
      expect(parse({ reason: 'x'.repeat(500) }).ok).toBe(true);
      expect(parse({ reason: 'x'.repeat(501) }).ok).toBe(false);
    },
  );
});

describe('the words', () => {
  it('every command has a label and a consequence, and every notice has a text', () => {
    for (const command of SUPPLIER_COMMANDS) {
      expect(SUPPLIER_COMMAND_LABELS[command].length).toBeGreaterThan(3);
      expect(SUPPLIER_COMMAND_CONSEQUENCES[command].length).toBeGreaterThan(40);
    }
    for (const notice of SUPPLIER_NOTICES) {
      expect(SUPPLIER_NOTICE_TEXT[notice].text.length).toBeGreaterThan(10);
    }
  });
});

describe('the decision note has one audience, in every sentence that mentions it', () => {
  // supplier-service omits `decisionNote` for the supplier's audience (views.ts), so no text may
  // promise it to the supplier: the hint and both decision consequences say "platform reviewers only".
  const PRIVATE = ['بازبین', 'منتشر نمی‌شود'] as const;

  it.each([
    ['the hint', REVIEWER_NOTE_HINT],
    ['the approval consequence', SUPPLIER_COMMAND_CONSEQUENCES.APPROVE_QUALIFICATION],
    ['the rejection consequence', SUPPLIER_COMMAND_CONSEQUENCES.REJECT_QUALIFICATION],
  ])('%s says the note is private to platform reviewers', (_name, text) => {
    for (const part of PRIVATE) expect(text).toContain(part);
    expect(text).not.toMatch(/یادداشت[^.؛]*(برای|و) تأمین‌کننده است/);
  });

  it('the approval consequence and the hint agree: reviewers only, never the supplier', () => {
    const approval = SUPPLIER_COMMAND_CONSEQUENCES.APPROVE_QUALIFICATION;
    expect(approval).toContain('نه تأمین‌کننده');
    expect(REVIEWER_NOTE_HINT).toContain('نه تأمین‌کننده');
    expect(approval).not.toContain('برای سابقه و تأمین‌کننده');
  });
});
