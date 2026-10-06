import type { Milestone } from '../generated/prisma';
import {
  calendarDate,
  changeMilestoneSchema,
  milestoneViewSchema,
  planMilestoneSchema,
} from './dto';
import { dayOf, toMilestoneView } from './views';

describe('calendarDate', () => {
  it.each(['2026-10-07', '2028-02-29', '1000-01-01', '9999-12-31'])('accepts %s', (value) => {
    expect(calendarDate.safeParse(value).success).toBe(true);
  });

  it.each([
    '2026-02-29', // not a leap year
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-10-32',
    '0999-12-31', // the year-below-1000 quirk of Date.UTC, refused outright
    '0099-01-01',
    '26-10-07',
    '2026-10-07T00:00:00Z', // an instant is not a date
    '2026-10-07 ',
    '2026/10/07',
    '',
  ])('refuses %p', (value) => {
    expect(calendarDate.safeParse(value).success).toBe(false);
  });
});

describe('planMilestoneSchema', () => {
  const body = { title: 'Foundation complete', plannedDate: '2026-12-01' };

  it('takes a title and a planned day; the share is optional', () => {
    expect(planMilestoneSchema.parse(body)).toEqual(body);
    expect(planMilestoneSchema.parse({ ...body, plannedShareBp: 2500 }).plannedShareBp).toBe(2500);
  });

  it('is strict: nothing names the contract, the author or the reference marker', () => {
    for (const extra of [
      'contractId',
      'createdBy',
      'firstReferencedAt',
      'version',
      'organizationId',
    ]) {
      expect(planMilestoneSchema.safeParse({ ...body, [extra]: 'x' }).success).toBe(false);
    }
  });

  it.each([0, -1, 10_001, 12.5, '2500', null])('refuses the share %p', (plannedShareBp) => {
    expect(planMilestoneSchema.safeParse({ ...body, plannedShareBp }).success).toBe(false);
  });

  it.each([1, 10_000])('accepts the share %p at its edge', (plannedShareBp) => {
    expect(planMilestoneSchema.safeParse({ ...body, plannedShareBp }).success).toBe(true);
  });

  it('bounds the title and refuses bidirectional controls', () => {
    expect(planMilestoneSchema.safeParse({ ...body, title: 'x'.repeat(200) }).success).toBe(true);
    expect(planMilestoneSchema.safeParse({ ...body, title: 'x'.repeat(201) }).success).toBe(false);
    expect(planMilestoneSchema.safeParse({ ...body, title: '  ' }).success).toBe(false);
    expect(planMilestoneSchema.safeParse({ ...body, title: 'a‮b' }).success).toBe(false);
  });

  it('refuses an instant for the planned day', () => {
    expect(
      planMilestoneSchema.safeParse({ ...body, plannedDate: '2026-12-01T00:00:00.000Z' }).success,
    ).toBe(false);
  });
});

describe('changeMilestoneSchema', () => {
  it('needs at least one field to change, and lets the share be cleared with null', () => {
    expect(changeMilestoneSchema.safeParse({}).success).toBe(false);
    expect(changeMilestoneSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(changeMilestoneSchema.parse({ plannedShareBp: null }).plannedShareBp).toBeNull();
    expect(changeMilestoneSchema.parse({ title: 'New' }).title).toBe('New');
    expect(changeMilestoneSchema.parse({ plannedDate: '2027-01-01', expectedVersion: 2 })).toEqual({
      plannedDate: '2027-01-01',
      expectedVersion: 2,
    });
  });

  it('is strict', () => {
    expect(changeMilestoneSchema.safeParse({ title: 'x', contractId: 'CTR_1' }).success).toBe(
      false,
    );
  });
});

describe('toMilestoneView', () => {
  const AT = new Date('2026-10-07T08:00:00.000Z');
  const row = (overrides: Partial<Milestone> = {}): Milestone => ({
    id: 'MLS_01',
    organizationId: 'ORG_E',
    contractId: 'CTR_01',
    title: 'Foundation complete',
    plannedDate: new Date('2026-12-01T00:00:00.000Z'),
    plannedShareBp: null,
    createdAt: AT,
    createdBy: 'USR_1',
    createdCorrelationId: 'COR_1',
    updatedAt: AT,
    updatedBy: 'USR_1',
    firstReferencedAt: null,
    version: 1,
    ...overrides,
  });

  it('sends the planned day as a date string and every instant as ISO 8601 UTC', () => {
    const view = toMilestoneView(row());
    expect(view.plannedDate).toBe('2026-12-01');
    expect(view.createdAt).toBe('2026-10-07T08:00:00.000Z');
    expect(milestoneViewSchema.safeParse(view).success).toBe(true);
  });

  it('shows whether a statement refers to it, never who made or changed it', () => {
    expect(toMilestoneView(row()).referenced).toBe(false);
    expect(toMilestoneView(row({ firstReferencedAt: AT })).referenced).toBe(true);
    expect(JSON.stringify(toMilestoneView(row()))).not.toMatch(/USR_1|COR_1|createdBy|updatedBy/);
  });

  it('keeps the day a date wherever the process’s time zone is', () => {
    expect(dayOf(new Date('2026-03-21T00:00:00.000Z'))).toBe('2026-03-21');
    expect(dayOf(new Date('2026-12-31T00:00:00.000Z'))).toBe('2026-12-31');
  });
});
