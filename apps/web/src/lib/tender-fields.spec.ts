import {
  TENDER_STATUSES,
  formatWeightBp,
  isTenderStatus,
  scoringMethodLabel,
  statusReasonCodeLabel,
  tenderDetailPath,
  tenderNatureLabel,
  tenderStatusLabel,
  tenderVisibilityLabel,
} from './tender-fields';
import { safeReturnTo } from '@/server/login-attempt';

describe('tenderDetailPath', () => {
  it.each([
    ['TND_1', 'open', '/tenders/TND_1?view=open'],
    ['TND_1', 'own', '/tenders/TND_1?view=own'],
    ['TND_1', undefined, '/tenders/TND_1'],
    ['TND_1', 'other', '/tenders/TND_1'],
    ['TND_1', ['open', 'own'], '/tenders/TND_1'],
    ['TND_1', 'open&returnTo=//evil.test', '/tenders/TND_1'],
  ])('keeps only a known view: %s %j → %s', (id, view, path) => {
    expect(tenderDetailPath(id, view)).toBe(path);
  });

  it('encodes the id as one segment, so it can only ever be a same-origin path', () => {
    for (const id of ['../x', '/evil.test', '//evil.test', 'a\\b', 'a?b=c#d']) {
      const path = tenderDetailPath(id, 'open');
      expect(safeReturnTo(path)).toBe(path);
      expect(path.startsWith('/tenders/')).toBe(true);
      expect(path.slice('/tenders/'.length).split('?')[0]).not.toContain('/');
    }
  });
});

describe('formatWeightBp', () => {
  it.each([
    [10000, '۱۰۰٪'],
    [6000, '۶۰٪'],
    [3350, '۳۳٫۵٪'],
    [1205, '۱۲٫۰۵٪'],
    [1, '۰٫۰۱٪'],
    [0, '۰٪'],
  ])('writes %i basis points as %s, in Persian digits', (bp, text) => {
    expect(formatWeightBp(bp)).toBe(text);
  });
});

describe('the tender vocabulary', () => {
  it('has a Persian word for every status, and shows an unknown one as itself', () => {
    for (const status of TENDER_STATUSES) {
      expect(tenderStatusLabel(status)).not.toBe(status);
    }
    expect(tenderStatusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(isTenderStatus('PUBLISHED')).toBe(true);
    expect(isTenderStatus('SOMETHING_NEW')).toBe(false);
    expect(isTenderStatus(undefined)).toBe(false);
  });

  it('says a missing nature or visibility is not set, rather than guessing', () => {
    expect(tenderNatureLabel(null)).toBe('تعیین نشده');
    expect(tenderVisibilityLabel(null)).toBe('تعیین نشده');
    expect(tenderNatureLabel('RFP')).toBe('درخواست پیشنهاد');
    expect(tenderVisibilityLabel('RESTRICTED')).toBe('فقط دعوت‌شدگان');
  });

  it('names a scoring method, and leaves an unknown reason code out instead of showing it raw', () => {
    expect(scoringMethodLabel('PASS_FAIL')).toBe('قبول یا رد');
    expect(statusReasonCodeLabel('OWNER_REQUEST')).toBe('به درخواست کارفرما');
    expect(statusReasonCodeLabel('SOMETHING_NEW')).toBeNull();
    expect(statusReasonCodeLabel(null)).toBeNull();
  });
});
