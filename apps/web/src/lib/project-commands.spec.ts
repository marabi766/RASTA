/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as commands from './project-commands';
import { IN_PROGRESS_WRITE_MESSAGE } from './in-progress-write';
import { UNCONFIRMED_WRITE_MESSAGE } from './unconfirmed-write';
import {
  CANCEL_UNCONFIRMED_MESSAGE,
  ESTIMATE_MESSAGE,
  ESTIMATE_TOO_LARGE_MESSAGE,
  NOTHING_CHANGED_MESSAGE,
  PROJECT_COMMANDS,
  PROJECT_COMMAND_CONSEQUENCES,
  PROJECT_COMMAND_LABELS,
  PROJECT_NOTICES,
  PROJECT_NOTICE_TEXT,
  approvalStatusLabel,
  commandsFrom,
  noFormValues,
  normalizeProjectValues,
  parseCancelForm,
  parseCreateForm,
  parseEditForm,
  parseEstimate,
  parseGrantForm,
  parseNoForm,
  parseRejectForm,
  projectFailureText,
  projectFormValues,
  workflowLabel,
  type ProjectField,
} from './project-commands';
import { SESSION_REFUSAL_MESSAGES } from './session-refusal';

const VALID = {
  title: 'بازسازی پل',
  operationType: 'خاکبرداری',
  locationDescription: 'کیلومتر ۱۲ جاده',
  scopeOfWork: 'شرح کار پروژه',
  estimatedCost: '',
};

describe('the create form', () => {
  it('reads a valid form, leaving the estimate out when it is empty', () => {
    expect(parseCreateForm(VALID)).toEqual({
      ok: true,
      body: {
        title: 'بازسازی پل',
        operationType: 'خاکبرداری',
        locationDescription: 'کیلومتر ۱۲ جاده',
        scopeOfWork: 'شرح کار پروژه',
      },
    });
  });

  it('sends the estimate as whole minor units, in any digits and with any grouping', () => {
    for (const typed of ['1500000', '۱٬۵۰۰٬۰۰۰', '1,500,000', '١٥٠٠٠٠٠']) {
      expect(parseCreateForm({ ...VALID, estimatedCost: typed })).toMatchObject({
        ok: true,
        body: { estimatedCostMinor: '1500000' },
      });
    }
    expect(parseCreateForm({ ...VALID, estimatedCost: '0' })).toMatchObject({
      ok: true,
      body: { estimatedCostMinor: '0' },
    });
  });

  it('names every field that is wrong, one message each, and keeps nothing else', () => {
    const result = parseCreateForm({
      title: '',
      operationType: 'ا',
      locationDescription: ' ',
      scopeOfWork: '',
      estimatedCost: 'abc',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual([
      'estimatedCost',
      'locationDescription',
      'operationType',
      'scopeOfWork',
      'title',
    ]);
    expect(result.fieldErrors.estimatedCost).toBe(ESTIMATE_MESSAGE);
  });

  it.each([['-5'], ['1.5'], ['1/2'], ['9223372036854775808']])(
    'refuses the estimate %j',
    (typed) => {
      const result = parseEstimate(typed);
      expect(result.ok).toBe(false);
    },
  );

  it('says a too-large estimate in its own words', () => {
    expect(parseEstimate('9223372036854775808')).toEqual({
      ok: false,
      message: ESTIMATE_TOO_LARGE_MESSAGE,
    });
  });

  it('normalises lines and trims the prose when it reads the form', () => {
    const form = new FormData();
    form.set('title', '  پل‌  ي  ');
    form.set('operationType', 'x');
    form.set('locationDescription', 'y');
    form.set('scopeOfWork', '  شرح\nدو خط  ');
    form.set('estimatedCost', ' 5 ');
    const values = projectFormValues(form);
    expect(values.title).toBe('پل‌ ی');
    expect(values.scopeOfWork).toBe('شرح\nدو خط');
    expect(values.estimatedCost).toBe('5');
  });
});

describe('the edit form', () => {
  const none = new Set<ProjectField>();

  it('sends only the changed fields', () => {
    const unchanged = new Set<ProjectField>([
      'operationType',
      'locationDescription',
      'estimatedCost',
    ]);
    expect(
      parseEditForm({ ...VALID, title: 'عنوان تازه', scopeOfWork: 'شرح تازه' }, unchanged),
    ).toEqual({
      ok: true,
      body: { title: 'عنوان تازه', scopeOfWork: 'شرح تازه' },
    });
  });

  it('clears the estimate with null and sets it with a string', () => {
    const rest = new Set<ProjectField>([
      'title',
      'operationType',
      'locationDescription',
      'scopeOfWork',
    ]);
    expect(parseEditForm({ ...VALID, estimatedCost: '' }, rest)).toEqual({
      ok: true,
      body: { estimatedCostMinor: null },
    });
    expect(parseEditForm({ ...VALID, estimatedCost: '۷۰۰' }, rest)).toEqual({
      ok: true,
      body: { estimatedCostMinor: '700' },
    });
  });

  it('refuses a form where nothing changed, naming no field but the first', () => {
    const all = new Set<ProjectField>(Object.keys(VALID) as ProjectField[]);
    expect(parseEditForm(VALID, all)).toEqual({
      ok: false,
      fieldErrors: { title: NOTHING_CHANGED_MESSAGE },
    });
  });

  it('checks a changed field and not an untouched one', () => {
    const result = parseEditForm(
      { ...VALID, title: 'ا', scopeOfWork: '' },
      new Set(['scopeOfWork']),
    );
    expect(result).toMatchObject({ ok: false, fieldErrors: { title: expect.any(String) } });
    expect(Object.keys((result as { fieldErrors: object }).fieldErrors)).toEqual(['title']);
  });

  it('sends every field when none is known to be unchanged', () => {
    const result = parseEditForm({ ...VALID, estimatedCost: '5' }, none);
    expect(result).toMatchObject({ ok: true });
    expect(Object.keys((result as { body: object }).body).sort()).toEqual([
      'estimatedCostMinor',
      'locationDescription',
      'operationType',
      'scopeOfWork',
      'title',
    ]);
  });

  it('normalises a record the same way a form is read, so an untouched field compares equal', () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...VALID, title: 'پل  ي' })) form.set(key, value);
    expect(projectFormValues(form)).toEqual(normalizeProjectValues({ ...VALID, title: 'پل  ي' }));
  });
});

describe('the other commands', () => {
  it('needs the cancel reason and the tick, and sends the reason only', () => {
    expect(parseCancelForm({ reason: 'بودجه تامین نشد', confirm: 'yes' })).toEqual({
      ok: true,
      body: { reason: 'بودجه تامین نشد' },
    });
    expect(parseCancelForm({ reason: 'بودجه تامین نشد', confirm: '' })).toEqual({
      ok: false,
      fieldErrors: { confirm: CANCEL_UNCONFIRMED_MESSAGE },
    });
    expect(parseCancelForm({ reason: 'کوتاه', confirm: 'yes' })).toMatchObject({
      ok: false,
      fieldErrors: { reason: expect.any(String) },
    });
  });

  it('needs a rejection reason of eight characters', () => {
    expect(parseRejectForm({ reason: 'برآورد نادرست' }).ok).toBe(true);
    expect(parseRejectForm({ reason: '' }).ok).toBe(false);
  });

  it('sends a grant with both optional fields, either or neither', () => {
    expect(parseGrantForm({ decisionNumber: '', conditions: '' })).toEqual({ ok: true, body: {} });
    expect(parseGrantForm({ decisionNumber: '12', conditions: '' })).toEqual({
      ok: true,
      body: { decisionNumber: '12' },
    });
    expect(parseGrantForm({ decisionNumber: '12', conditions: 'شرط' })).toEqual({
      ok: true,
      body: { decisionNumber: '12', conditions: 'شرط' },
    });
    expect(parseGrantForm({ decisionNumber: 'x'.repeat(101), conditions: '' }).ok).toBe(false);
  });

  it('sends nothing for the commands with nothing to type', () => {
    expect(parseNoForm()).toEqual({ ok: true, body: {} });
    expect(noFormValues()).toEqual({});
  });
});

describe('what a status offers', () => {
  it('draws no project command on a status the portal has no word for', () => {
    expect(commandsFrom('SOMETHING_NEW')).toEqual([]);
  });

  it('has a label, a consequence and a rule for every command, and only the project’s are offered by status', () => {
    for (const command of PROJECT_COMMANDS) {
      expect(PROJECT_COMMAND_LABELS[command].length).toBeGreaterThan(1);
      expect(PROJECT_COMMAND_CONSEQUENCES[command].length).toBeGreaterThan(20);
    }
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS']) {
      expect(commandsFrom(status)).not.toContain('grant');
      expect(commandsFrom(status)).not.toContain('reject');
    }
  });
});

describe('the words', () => {
  it('has a notice for each confirmation, and a warning only for the stale one', () => {
    for (const notice of PROJECT_NOTICES) {
      expect(PROJECT_NOTICE_TEXT[notice].text.length).toBeGreaterThan(5);
      expect(PROJECT_NOTICE_TEXT[notice].tone).toBe(notice === 'stale' ? 'warning' : 'success');
    }
  });

  it('says a failure by its status', () => {
    expect(projectFailureText(401)).toBe(SESSION_REFUSAL_MESSAGES.NO_SESSION);
    expect(projectFailureText(503)).toContain('همین حالا پاسخ نمی‌دهد');
    expect(projectFailureText(500)).toContain('چیزی تغییر نکرد');
  });

  it('labels an approval status and a workflow, and shows one it does not know as it came', () => {
    expect(approvalStatusLabel('PENDING')).toBe('منتظر تصمیم');
    expect(approvalStatusLabel('NEW_STATE')).toBe('NEW_STATE');
    expect(workflowLabel('project.completion')).toBe('تکمیل پروژه');
    expect(workflowLabel('other')).toBe('other');
  });

  // The rule for new text on these screens: no hamza, no combining hamza. The
  // regular expression is built from code points so this file carries neither.
  const HAMZA = new RegExp(
    `[${[0x0621, 0x0623, 0x0624, 0x0625, 0x0626, 0x0654].map((c) => String.fromCodePoint(c)).join('')}]`,
    'u',
  );

  function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (value instanceof RegExp) return out;
    else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
    else if (value && typeof value === 'object')
      Object.values(value).forEach((v) => strings(v, out));
    return out;
  }

  it('carries no hamza in anything this module exports', () => {
    const offending = strings(Object.entries(commands)).filter((text) => HAMZA.test(text));
    expect(offending).toEqual([]);
  });

  it('carries no hamza in the shared sentences these screens render', () => {
    const shared = [
      UNCONFIRMED_WRITE_MESSAGE,
      IN_PROGRESS_WRITE_MESSAGE,
      ...Object.values(SESSION_REFUSAL_MESSAGES),
    ];
    expect(shared.filter((text) => HAMZA.test(text))).toEqual([]);
  });

  it.each([
    'src/lib/project-commands.ts',
    'src/server/project-commands.ts',
    'src/app/projects/page.tsx',
    'src/app/projects/actions.ts',
    'src/app/projects/form-state.ts',
    'src/app/projects/CreateProjectForm.tsx',
    'src/server/project-create-replay.ts',
    'src/app/projects/ApprovalInbox.tsx',
    'src/app/projects/[id]/page.tsx',
    'src/app/projects/[id]/ProjectForms.tsx',
    'src/app/projects/[id]/ProjectCommands.tsx',
    'src/app/projects/[id]/ProjectApprovals.tsx',
    'src/app/projects/[id]/project-actions.ts',
    'src/app/projects/[id]/project-runner.ts',
    'src/app/projects/[id]/project-form-state.ts',
  ])('%s carries no hamza in new text', (file) => {
    const text = readFileSync(join(process.cwd(), file), 'utf8');
    // The one word of the existing reading screens (the page title, «جزئیات») this task did not write.
    const mine = text.split('\u062c\u0632\u0626\u06cc\u0627\u062a').join('');
    expect(mine.split('\n').filter((line) => HAMZA.test(line))).toEqual([]);
  });
});
