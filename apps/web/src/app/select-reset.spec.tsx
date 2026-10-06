import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@testing-library/react';

import { pickSubmitAndRead } from '@/test/refusal';

import { RegisterAssetForm } from './assets/RegisterAssetForm';
import { AttachDocumentForm } from './assets/[id]/AssetDocumentForm';
import { ChangeStatusForm as AssetChangeStatusForm } from './assets/[id]/AssetLifecycleForms';
import { RecordInspectionForm, RecordPolicyForm } from './assets/[id]/AssetRecordForms';
import { DeclareAvailabilityForm } from './assets/[id]/AvailabilityForms';
import { ChangeStatusForm as DriverChangeStatusForm } from './drivers/[id]/ChangeStatusForm';
import { EndAssignmentForm } from './drivers/[id]/EndAssignmentForm';
import { ReportRequestForm } from './maintenance/ReportRequestForm';
import { RecordCostForm, RecordPartForm } from './maintenance/[id]/RepairOrderForms';

/**
 * A `<select>` keeps the choice a person made after an attempt is refused.
 *
 * React reads a select's `defaultValue` once, at mount; the form reset that
 * follows every action restores the *mounted* selection, so a form that comes
 * back `INVALID` with the person's values showed every select blank again and
 * the person had to pick it twice. Text inputs, textareas, checkboxes and radios
 * follow their new default unaided; a select needs a `key` of its default, so it
 * remounts when the default changes (docs/16 § ۱۶٫۱).
 *
 * Every select that takes its default from returned action state is here, one
 * case each. The sequence is the real one — pick, submit, refused, reset — with
 * only the action replaced (`@/test/refusal`).
 */

jest.mock('./assets/actions', () => {
  const { refuse } = jest.requireActual('@/test/refusal');
  return { submitRegisterAsset: refuse };
});
jest.mock('./assets/[id]/lifecycle-actions', () => {
  const { refuse } = jest.requireActual('@/test/refusal');
  return { submitActivateAsset: refuse, submitChangeStatus: refuse, submitDecommission: refuse };
});
jest.mock('./assets/[id]/document-actions', () => {
  const { refuse } = jest.requireActual('@/test/refusal');
  return { submitAttachDocument: refuse };
});
jest.mock('./assets/[id]/availability-actions', () => {
  const { refuse } = jest.requireActual('@/test/refusal');
  return { submitDeclareAvailability: refuse, submitRevokeAvailability: refuse };
});
jest.mock('./assets/[id]/record-actions', () => {
  const { refuse } = jest.requireActual('@/test/refusal');
  return { submitRecordPolicy: refuse, submitRecordInspection: refuse };
});
jest.mock('./drivers/[id]/actions', () => {
  const { refuse } = jest.requireActual('@/test/refusal');
  return { submitChangeStatus: refuse, submitEndAssignment: refuse };
});
jest.mock('./maintenance/actions', () => {
  const { refuse } = jest.requireActual('@/test/refusal');
  return { submitReportRequest: refuse };
});
jest.mock('./maintenance/[id]/repair-actions', () => {
  const { refuse } = jest.requireActual('@/test/refusal');
  return {
    submitStartRepair: refuse,
    submitCompleteRepair: refuse,
    submitCancelRepair: refuse,
    submitRecordPart: refuse,
    submitRecordLabour: refuse,
    submitRecordCost: refuse,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const ASSET = 'AST_01J00000000000000000000000';
const BASELINE = 'eyJzaWduZWQiOiJieS10aGUtcGFnZSJ9.sig';
const ASSET_IDENTITY = {
  assetId: ASSET,
  csrfToken: CSRF,
  submissionId: SUBMISSION,
  baseline: BASELINE,
};
const REPAIR_IDENTITY = {
  csrfToken: CSRF,
  submissionId: SUBMISSION,
  requestId: 'MNT_01J00000000000000000000000',
  baseline: BASELINE,
};

const CASES = [
  {
    form: 'register asset',
    select: 'type',
    mount: () => <RegisterAssetForm csrfToken={CSRF} submissionId={SUBMISSION} />,
  },
  {
    form: 'change asset status',
    select: 'status',
    mount: () => (
      <AssetChangeStatusForm
        {...ASSET_IDENTITY}
        currentStatus="ACTIVE"
        targets={['OUT_OF_SERVICE', 'IDLE']}
      />
    ),
  },
  {
    form: 'record policy',
    select: 'coverage',
    mount: () => <RecordPolicyForm {...ASSET_IDENTITY} />,
  },
  {
    form: 'record inspection',
    select: 'result',
    mount: () => <RecordInspectionForm {...ASSET_IDENTITY} />,
  },
  {
    form: 'attach asset document',
    select: 'kind',
    mount: () => <AttachDocumentForm {...ASSET_IDENTITY} />,
  },
  {
    form: 'declare asset availability',
    select: 'available',
    mount: () => <DeclareAvailabilityForm {...ASSET_IDENTITY} />,
  },
  {
    form: 'change driver status',
    select: 'status',
    mount: () => (
      <DriverChangeStatusForm
        driverId="DRV_01J00000000000000000000000"
        currentStatus="ACTIVE"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />
    ),
  },
  {
    form: 'end assignment',
    select: 'reason',
    mount: () => (
      <EndAssignmentForm
        driverId="DRV_01J00000000000000000000000"
        assignmentId="ASG_01J00000000000000000000000"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />
    ),
  },
  {
    form: 'report maintenance request (type)',
    select: 'type',
    mount: () => <ReportRequestForm csrfToken={CSRF} submissionId={SUBMISSION} />,
  },
  {
    form: 'report maintenance request (severity)',
    select: 'severity',
    mount: () => <ReportRequestForm csrfToken={CSRF} submissionId={SUBMISSION} />,
  },
  {
    form: 'record repair part (source)',
    select: 'source',
    mount: () => <RecordPartForm {...REPAIR_IDENTITY} />,
  },
  {
    form: 'record repair cost (category)',
    select: 'category',
    mount: () => <RecordCostForm {...REPAIR_IDENTITY} />,
  },
] as const;

describe('a select keeps the choice after the action refuses the attempt and the form is reset', () => {
  it.each(CASES)('$form — $select', async ({ mount, select }) => {
    const { container } = render(mount());

    const { picked, shownAfter } = await pickSubmitAndRead(container, select);

    expect(shownAfter).toBe(picked);
  });
});

/**
 * The cases above cover the selects that exist; this keeps the next one honest.
 * A `<select>` in a form whose default comes from returned action state
 * (`defaultValue={values.x}`) must carry `key={values.x}`, or it forgets the
 * choice the first time an attempt is refused. Filter selects, whose default
 * comes from the URL and which no action resets, are not in scope.
 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(name) && !/\.spec\.tsx$/.test(name) ? [path] : [];
  });
}

describe('every select that takes its default from action state is keyed by it', () => {
  const selects = sourceFiles(__dirname).flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(/<select\b[^>]*>/g)].map((match) => ({
      path: path.slice(__dirname.length + 1),
      tag: match[0],
    })),
  );
  const fromState = selects.filter(({ tag }) => /defaultValue=\{values\./.test(tag));

  it('finds the selects it is meant to guard', () => {
    expect(fromState).toHaveLength(CASES.length);
  });

  it.each(fromState.map(({ path, tag }) => [path, tag] as const))('%s', (_path, tag) => {
    const expression = /defaultValue=\{(values\.\w+)\}/.exec(tag)![1]!;
    expect(tag).toContain(`key={${expression}}`);
  });
});
