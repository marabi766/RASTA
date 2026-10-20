import type { ApprovalRequest, OwnerBids } from '@/server/tender-owner';
import type { TenderDetail } from '@/server/tenders';

export { jwt, tokenFor } from './statement-fixtures';

/**
 * A tender as the owner's door sends it, its publication request and the
 * owner's view of its bids — one fixture for the server, action and screen
 * specs. The owner is ORG-DEH-0001; USR-AUTHOR asked for publication; the
 * policy's one step names ORG-DEH-0001's ORGANIZATION_ADMIN.
 */

export const OWNER = 'ORG-DEH-0001';
export const TENDER_ID = 'TND_01JOWNERAAAAAAAAAAAAAAAAA';
export const APPROVAL_ID = 'APR_01JAPPROVALAAAAAAAAAAAAA';
export const AUTHOR = 'USR-AUTHOR';
export const APPROVER = 'USR-APPROVER';

export const DRAFT_TENDER: TenderDetail = {
  id: TENDER_ID,
  title: 'بهسازی راه روستایی',
  procurementNature: 'FORMAL_TENDER',
  visibility: 'RESTRICTED',
  bidOpeningAt: '2026-10-18T06:00:00.000Z',
  bidClosingAt: '2026-10-20T06:00:00.000Z',
  status: 'DRAFT',
  statusChangedAt: '2026-10-17T06:00:00.000Z',
  projectId: 'PRJ_1',
  scopeOfWork: 'آسفالت دو کیلومتر',
  statusReason: null,
  statusReasonCode: null,
  publishedAt: null,
  createdAt: '2026-10-17T06:00:00.000Z',
  version: 4,
  statusChangedByCaller: false,
};

export const PENDING_REQUEST: ApprovalRequest = {
  id: 'TAR_1',
  tenderId: TENDER_ID,
  workflowKey: 'tender.publication',
  round: 1,
  tenderVersion: 4,
  status: 'PENDING',
  requestedBy: AUTHOR,
  requestedAt: '2026-10-17T07:00:00.000Z',
  endedAt: null,
  endedReason: null,
  consumedAt: null,
  steps: [
    {
      approvalId: APPROVAL_ID,
      stepOrder: 1,
      approvalType: 'Publication approval (sample)',
      authorityOrganizationId: OWNER,
      authorityRole: 'ORGANIZATION_ADMIN',
      authorityLabel: 'مدیر سازمان (نمونه)',
      status: 'PENDING',
      decidedAt: null,
    },
  ],
};

export const APPROVED_REQUEST: ApprovalRequest = {
  ...PENDING_REQUEST,
  status: 'APPROVED',
  steps: [
    { ...PENDING_REQUEST.steps[0]!, status: 'GRANTED', decidedAt: '2026-10-17T08:00:00.000Z' },
  ],
};

export const CLOSED_TENDER: TenderDetail = {
  ...DRAFT_TENDER,
  status: 'CLOSED',
  publishedAt: '2026-10-17T09:00:00.000Z',
  version: 6,
};

export const UNOPENED_BIDS: OwnerBids = {
  tenderId: TENDER_ID,
  opened: false,
  bidCount: 2,
  receivedAt: ['2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z'],
  bids: [],
};

export const OPENED_BIDS: OwnerBids = {
  tenderId: TENDER_ID,
  opened: true,
  bidCount: 1,
  receivedAt: [],
  bids: [
    {
      bidId: 'BID_1',
      tenderId: TENDER_ID,
      bidderOrganizationId: 'ORG-CON-0001',
      status: 'OPENED',
      revision: 2,
      receivedAt: '2026-10-19T08:00:00.000Z',
      content: {
        priceMinor: '4200000000',
        answers: [{ criterionCode: 'technical', response: 'روش اجرا با ماشین‌آلات خودی' }],
        note: 'یادداشت پیمانکار',
      },
    },
  ],
};
