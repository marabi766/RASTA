import { blockerWording } from './availability-wording';

/**
 * The wording of fleet-service's availability blockers: built from the closed
 * `code`, the structured `cause` and `coverages` — never from the English
 * sentence — and honest about who can lift each.
 */
describe('the wording of a blocker', () => {
  it('words a failed inspection, and says the platform imposed it', () => {
    expect(
      blockerWording({ code: 'DISPATCH_BLOCKED', owner: 'asset-service', cause: 'INSPECTION' }),
    ).toEqual({
      imposedBy: 'PLATFORM',
      owner: 'سامانهٔ دارایی',
      title: 'آخرین معاینهٔ فنی مردود شده است',
    });
  });

  it('words an expired insurance policy with each lapsed coverage, in Persian', () => {
    const wording = blockerWording({
      code: 'DISPATCH_BLOCKED',
      owner: 'asset-service',
      cause: 'INSURANCE',
      coverages: ['COMPREHENSIVE', 'THIRD_PARTY'],
    });
    expect(wording.imposedBy).toBe('PLATFORM');
    expect(wording.title).toBe('بیمه‌نامهٔ منقضی‌شده: جامع (بدنه)، شخص ثالث');
  });

  it('says a lapse whose coverage nobody named as exactly that', () => {
    expect(
      blockerWording({
        code: 'DISPATCH_BLOCKED',
        owner: 'asset-service',
        cause: 'INSURANCE',
        coverages: ['UNKNOWN'],
      }).title,
    ).toBe('بیمه‌نامهٔ منقضی‌شده: نوع پوشش نامشخص');
  });

  it('words a safety block whose cause it does not know without guessing a cause', () => {
    expect(
      blockerWording({ code: 'DISPATCH_BLOCKED', owner: 'asset-service', cause: 'NEW_CAUSE' })
        .title,
    ).toBe('مانع ایمنی اعزام (معاینه یا بیمه)');
    expect(blockerWording({ code: 'DISPATCH_BLOCKED', owner: 'asset-service' }).imposedBy).toBe(
      'PLATFORM',
    );
  });

  it('words the other platform facts, with the asset status in Persian', () => {
    expect(blockerWording({ code: 'IN_MAINTENANCE', owner: 'maintenance-service' })).toMatchObject({
      imposedBy: 'PLATFORM',
      owner: 'تعمیر و نگهداری',
    });
    expect(
      blockerWording({ code: 'ASSET_STATUS', owner: 'asset-service' }, 'OUT_OF_SERVICE').title,
    ).toBe('وضعیت دارایی «خارج از سرویس» است و اعزام را نمی‌پذیرد');
    expect(blockerWording({ code: 'ASSET_STATUS', owner: 'asset-service' }).title).toBe(
      'وضعیت دارایی اعزام را نمی‌پذیرد',
    );
  });

  it('marks an assignment as an assignment and a declaration as a declaration', () => {
    expect(blockerWording({ code: 'ACTIVE_ASSIGNMENT', owner: 'fleet-service' }).imposedBy).toBe(
      'ASSIGNMENT',
    );
    expect(blockerWording({ code: 'DECLARED_UNAVAILABLE', owner: 'fleet-service' })).toMatchObject({
      imposedBy: 'DECLARATION',
      owner: 'ناوگان',
    });
  });

  it('shows a blocker it has never heard of with its code and owner — visible, not dropped', () => {
    expect(blockerWording({ code: 'NEW_THING', owner: 'brand-new-service' })).toEqual({
      imposedBy: 'PLATFORM',
      owner: 'brand-new-service',
      title: 'مانع دیگر (NEW_THING)',
    });
  });

  it('never reads the English detail: the function does not take it', () => {
    // A blocker's `detail` is not in the input type; this is the compile-time half
    // of "never parsed", and the runtime half is that two blockers equal but for
    // the sentence are worded the same.
    const a = blockerWording({ code: 'IN_MAINTENANCE', owner: 'maintenance-service' });
    const b = blockerWording({
      code: 'IN_MAINTENANCE',
      owner: 'maintenance-service',
      ...{ detail: 'reworded' },
    });
    expect(a).toEqual(b);
  });
});
