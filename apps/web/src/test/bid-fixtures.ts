import type { BidReceipt } from '@/server/tender-bids';
import type { OpenTenderDetail } from '@/server/tenders';

export { jwt, tokenFor } from './statement-fixtures';

/**
 * A tender as the bidder's door sends it, and a contractor's own bid on it —
 * one fixture for the server, action and screen specs.
 *
 * The owner is ORG-DEH-0001; the contractor ORG-CON-0001 bids. The window is
 * open from 2026-10-17 06:00 to 2026-10-20 06:00 UTC; `DURING` is inside it.
 */

export const OWNER = 'ORG-DEH-0001';
export const BIDDER = 'ORG-CON-0001';
export const STRANGER = 'ORG-DEH-0002';
export const TENDER_ID = 'TND_01JTENDERAAAAAAAAAAAAAAAA';
export const BID_ID = 'BID_01JBIDAAAAAAAAAAAAAAAAAAA';

export const OPENS = Date.parse('2026-10-17T06:00:00.000Z');
export const CLOSES = Date.parse('2026-10-20T06:00:00.000Z');
export const DURING = Date.parse('2026-10-18T09:30:00.000Z');

export const OPEN_TENDER: OpenTenderDetail = {
  id: TENDER_ID,
  title: 'بهسازی راه روستایی',
  procurementNature: 'FORMAL_TENDER',
  visibility: 'RESTRICTED',
  bidOpeningAt: new Date(OPENS).toISOString(),
  bidClosingAt: new Date(CLOSES).toISOString(),
  scopeOfWork: 'آسفالت دو کیلومتر از راه دسترسی',
  criteria: [
    {
      code: 'technical',
      label: 'روش اجرا',
      weightBp: 7000,
      scoringMethod: 'MANUAL_SCORE',
      maxScore: 10,
    },
    {
      code: 'compliance',
      label: 'کامل‌بودن مدارک',
      weightBp: 3000,
      scoringMethod: 'PASS_FAIL',
      maxScore: 1,
    },
  ],
};

export const RECEIPT: BidReceipt = {
  bidId: BID_ID,
  tenderId: TENDER_ID,
  status: 'SUBMITTED',
  revision: 1,
  receivedAt: '2026-10-18T08:00:00.000Z',
  contentCommitment: 'c'.repeat(64),
  receipt: 'r'.repeat(64),
  withdrawnAt: null,
};

export const REVISED: BidReceipt = {
  ...RECEIPT,
  revision: 2,
  receivedAt: '2026-10-18T09:00:00.000Z',
  receipt: 's'.repeat(64),
};

export const WITHDRAWN: BidReceipt = {
  ...RECEIPT,
  status: 'WITHDRAWN',
  withdrawnAt: '2026-10-18T10:00:00.000Z',
};
