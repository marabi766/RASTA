import {
  amendmentReasonLabel,
  cancelReasonLabel,
  type ContractCommand,
  type ContractSide,
} from '@/lib/contract-command-fields';
import { shareText } from '@/lib/contract-command-input';
import { toPersianDigits } from '@/lib/format';
import { mintContractSubmission } from '@/server/contract-command-replay';
import {
  amendmentSignableSide,
  canCancelContract,
  canChangeMilestone,
  canProposeAmendment,
  canPlanMilestone,
  fetchSigningPolicy,
  mightSignAsEmployer,
  signableSide,
  type ContractCaller,
  type SigningAuthorityView,
} from '@/server/contract-commands';
import type {
  Amendment,
  AmendmentPage,
  ContractDetail,
  MilestonePage,
  ReadResult,
} from '@/server/contracts';
import { webServerEnv, type WebServerEnv } from '@/server/env';
import type { WebSession } from '@/server/session';
import { submissionBinding } from '@/server/submission';

import type { ContractFormContext, OfferedContractCommand } from './ContractCommands';

/**
 * Which contract command forms `/contracts/[id]` draws, and for what — each
 * with a fresh submission id and a stamp binding the object, the version and
 * the side the page shows (`server/contract-command-replay.ts`). The decisions
 * are `server/contract-commands.ts`'s copies of contract-service's checks; this
 * only assembles them.
 *
 * Every slot is drawn whether or not it offers a form: a command this browser
 * sent and could not confirm is shown in its slot until it is reconciled, even
 * when the page, read again, would offer nothing there.
 */

/** Why the employer is offered no signature, when the page can say. */
export type SigningNote = 'NO_POLICY' | 'UNREAD' | null;

export interface ContractCommandOffers {
  readonly context: ContractFormContext;
  readonly contract: readonly OfferedContractCommand[];
  readonly newAmendment: readonly OfferedContractCommand[];
  readonly amendments: Readonly<Record<string, readonly OfferedContractCommand[]>>;
  readonly newMilestone: readonly OfferedContractCommand[];
  readonly milestones: Readonly<Record<string, readonly OfferedContractCommand[]>>;
  readonly signingNote: SigningNote;
}

type OfferEnv = Pick<
  WebServerEnv,
  | 'WEB_CONTRACT_CANCEL_ROLES'
  | 'WEB_CONTRACT_AMENDMENT_ROLES'
  | 'WEB_CONTRACT_MILESTONE_ROLES'
  | 'WEB_CONTRACT_CANCEL_AFTER_SIGNATURE'
  | 'WEB_CONTRACT_CANCEL_REASON_CODES'
  | 'WEB_CONTRACT_AMENDMENT_REASON_CODES'
  | 'WEB_SESSION_MAX_AGE_SECONDS'
>;

/** «الحاقیهٔ ۲» — an amendment as a person reads it. */
export function amendmentLabel(amendment: Pick<Amendment, 'amendmentNumber'>): string {
  return `الحاقیهٔ ${toPersianDigits(String(amendment.amendmentNumber))}`;
}

/** Whether the employer's signature could be offered anywhere on the page — the policy is read only then. */
function employerMaySignSomething(
  caller: ContractCaller,
  contract: ContractDetail,
  amendments: ReadResult<AmendmentPage> | null,
): boolean {
  if (!mightSignAsEmployer(caller, contract)) return false;
  const draftUnsigned = contract.status === 'DRAFT' && contract.employerSignedAt === null;
  const amendmentUnsigned =
    contract.status === 'SIGNED' &&
    amendments?.kind === 'OK' &&
    amendments.data.items.some(
      (amendment) => amendment.status === 'PROPOSED' && amendment.employerSignedAt === null,
    );
  return draftUnsigned || amendmentUnsigned;
}

export async function contractCommandOffers(
  session: WebSession,
  caller: ContractCaller,
  contract: ContractDetail,
  amendments: ReadResult<AmendmentPage> | null,
  milestones: ReadResult<MilestonePage> | null,
  env: OfferEnv = webServerEnv(),
): Promise<ContractCommandOffers> {
  const contractId = contract.id;
  const offer = (
    command: ContractCommand,
    subjectId: string | null,
    expectedVersion: number | null,
    side: ContractSide | null = null,
    extra: Pick<OfferedContractCommand, 'reasons' | 'defaults'> = {},
  ): OfferedContractCommand => ({
    command,
    side,
    submission: mintContractSubmission(session, {
      command,
      contractId,
      subjectId,
      expectedVersion,
      side,
    }),
    ...extra,
  });

  let authority: SigningAuthorityView = { policy: null };
  let signingNote: SigningNote = null;
  if (employerMaySignSomething(caller, contract, amendments)) {
    const read = await fetchSigningPolicy(session, contract.organizationId);
    authority = read.kind === 'OK' ? { policy: read.data } : 'UNREAD';
    signingNote = read.kind !== 'OK' ? 'UNREAD' : read.data === null ? 'NO_POLICY' : null;
  }

  const contractOffers: OfferedContractCommand[] = [];
  const side = signableSide(caller, contract, authority);
  if (side) contractOffers.push(offer('SIGN', null, contract.version, side));
  if (canCancelContract(caller, contract, env)) {
    contractOffers.push(
      offer('CANCEL', null, contract.version, null, {
        reasons: env.WEB_CONTRACT_CANCEL_REASON_CODES.map((code) => ({
          code,
          label: cancelReasonLabel(code),
        })),
      }),
    );
  }

  const newAmendment = canProposeAmendment(caller, contract, env)
    ? [
        offer('PROPOSE_AMENDMENT', null, contract.version, null, {
          reasons: env.WEB_CONTRACT_AMENDMENT_REASON_CODES.map((code) => ({
            code,
            label: amendmentReasonLabel(code),
          })),
        }),
      ]
    : [];

  const amendmentOffers: Record<string, OfferedContractCommand[]> = {};
  for (const amendment of amendments?.kind === 'OK' ? amendments.data.items : []) {
    const signing = amendmentSignableSide(caller, contract, amendment, authority);
    amendmentOffers[amendment.id] = signing
      ? [offer('SIGN_AMENDMENT', amendment.id, amendment.version, signing)]
      : [];
  }

  // A new milestone has no version to bind: the DTO takes none.
  const newMilestone = canPlanMilestone(caller, contract, env)
    ? [offer('PLAN_MILESTONE', null, null)]
    : [];

  const milestoneOffers: Record<string, OfferedContractCommand[]> = {};
  for (const milestone of milestones?.kind === 'OK' ? milestones.data.items : []) {
    milestoneOffers[milestone.id] = canChangeMilestone(caller, contract, milestone, env)
      ? [
          offer('CHANGE_MILESTONE', milestone.id, milestone.version, null, {
            defaults: {
              title: milestone.title,
              plannedDate: milestone.plannedDate.slice(0, 10),
              plannedShareBp:
                milestone.plannedShareBp === null ? '' : shareText(milestone.plannedShareBp),
            },
          }),
        ]
      : [];
  }

  return {
    context: {
      csrfToken: session.csrfToken,
      binding: submissionBinding(session),
      sessionMaxAgeSeconds: env.WEB_SESSION_MAX_AGE_SECONDS,
      pageHref: `/contracts/${encodeURIComponent(contractId)}`,
    },
    contract: contractOffers,
    newAmendment,
    amendments: amendmentOffers,
    newMilestone,
    milestones: milestoneOffers,
    signingNote,
  };
}
