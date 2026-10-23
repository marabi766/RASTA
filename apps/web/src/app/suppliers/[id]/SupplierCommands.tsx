import type { ReactNode } from 'react';

import { supplierCapabilityLabel } from '@/lib/supplier-fields';
import { mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import {
  canActAsSupplier,
  canDecideAbout,
  isOwnCase,
  offerableCapabilities,
  sealSupplierBaseline,
  supplierActor,
  type SupplierActor,
} from '@/server/supplier-commands';
import type { SupplierDetail } from '@/server/suppliers';

import {
  ApproveQualificationForm,
  ReinstateSupplierForm,
  RejectQualificationForm,
  SubmitQualificationForm,
  SuspendSupplierForm,
} from '../SupplierForms';

/**
 * What the supplier page offers to do, drawn from the token's roles and the
 * record as the API returned it.
 *
 * supplier-service answers **no** permission list (no `availableActions`), so
 * this is the portal's mirror of `access.ts` (`server/supplier-commands.ts`,
 * pinned by the contract spec): a form is drawn only for a person the service
 * would admit on a record in the state that allows it, and each one is signed
 * (`sealSupplierBaseline`). The service decides again on every send. This is not
 * a `'use client'` module: it only builds elements the screen places.
 */

export interface SupplierCommandsView {
  /** Send a qualification request, when the person may and a capability is open. */
  readonly submit: ReactNode;
  /** Approve and reject, per qualification awaiting a decision. */
  readonly decisions: Readonly<Record<string, ReactNode>>;
  /** Suspend (an active supplier) or reinstate (a suspended one). */
  readonly suspension: ReactNode;
  /** Said when the person is offered nothing, and why, only where the reason is known. */
  readonly note: string | null;
}

export const NO_COMMANDS: SupplierCommandsView = {
  submit: null,
  decisions: {},
  suspension: null,
  note: null,
};

/**
 * Stays closed until asked for: a decision about another organization is not
 * what most people open its page for.
 */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details>
      <summary className="cursor-pointer text-content underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {summary}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}

export const OWN_CASE_NOTE =
  'سازمان شما صاحب این پرونده است؛ هیچ نقشی به سازمان تامین‌کننده اجازه نمی‌دهد درباره صلاحیت، تعلیق یا رفع تعلیق خودش تصمیم بگیرد.';
export const READ_ONLY_NOTE = 'نقش شما در این پرونده فقط خواندن را می‌دهد.';

export function supplierCommandsFor(
  session: WebSession,
  supplier: SupplierDetail,
  actor: SupplierActor | null = supplierActor(session.accessToken),
): SupplierCommandsView {
  if (!actor) return NO_COMMANDS;

  const identity = (
    command: Parameters<typeof sealSupplierBaseline>[1]['command'],
    qualificationId: string | null = null,
  ) => ({
    supplierId: supplier.id,
    csrfToken: session.csrfToken,
    submissionId: mintSubmissionId(session),
    baseline: sealSupplierBaseline(session, { supplierId: supplier.id, command, qualificationId }),
  });

  let submit: ReactNode = null;
  if (canActAsSupplier(actor, supplier.organizationId)) {
    const capabilities = offerableCapabilities(supplier.qualifications);
    if (capabilities.length > 0) {
      submit = (
        <SubmitQualificationForm
          {...identity('SUBMIT_QUALIFICATION')}
          capabilities={capabilities}
        />
      );
    }
  }

  const decisions: Record<string, ReactNode> = {};
  let suspension: ReactNode = null;
  if (canDecideAbout(actor, supplier.organizationId)) {
    for (const qualification of supplier.qualifications) {
      if (qualification.state !== 'SUBMITTED') continue;
      const capabilityLabel = supplierCapabilityLabel(qualification.capability);
      decisions[qualification.id] = (
        <div className="flex flex-col gap-4">
          <Disclosure summary="تایید صلاحیت…">
            <ApproveQualificationForm
              {...identity('APPROVE_QUALIFICATION', qualification.id)}
              capabilityLabel={capabilityLabel}
            />
          </Disclosure>
          <Disclosure summary="رد صلاحیت…">
            <RejectQualificationForm
              {...identity('REJECT_QUALIFICATION', qualification.id)}
              capabilityLabel={capabilityLabel}
            />
          </Disclosure>
        </div>
      );
    }
    if (supplier.status === 'ACTIVE') {
      suspension = (
        <Disclosure summary="تعلیق این تامین‌کننده…">
          <SuspendSupplierForm {...identity('SUSPEND')} />
        </Disclosure>
      );
    } else if (supplier.status === 'SUSPENDED') {
      suspension = <ReinstateSupplierForm {...identity('REINSTATE')} />;
    }
  }

  const offered = submit !== null || suspension !== null || Object.keys(decisions).length > 0;
  const note = offered
    ? null
    : isOwnCase(actor, supplier.organizationId)
      ? OWN_CASE_NOTE
      : submit === null && canActAsSupplier(actor, supplier.organizationId)
        ? null
        : READ_ONLY_NOTE;

  return { submit, decisions, suspension, note };
}
