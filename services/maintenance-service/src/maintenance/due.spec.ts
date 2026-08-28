import { assessDue, isAnnounceable, type MeterReading, type ScheduleRule } from './due';

/**
 * The due evaluator is the one piece of this service that decides whether a
 * machine is safe to keep working, so it is tested at its boundaries rather
 * than in the middle: the moment a schedule tips from NOT_DUE to DUE_SOON, and
 * from DUE_SOON to OVERDUE, are the only two values where a mistake matters.
 *
 * Every case here is a schedule with values supplied by a caller. None of them
 * is a threshold the platform believes in.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-08-28T10:00:00.000Z');

function rule(overrides: Partial<ScheduleRule> = {}): ScheduleRule {
  return {
    intervalDays: null,
    intervalHours: null,
    intervalKilometres: null,
    leadDays: null,
    leadHours: null,
    leadKilometres: null,
    lastServicedAt: null,
    createdAt: NOW,
    lastServicedHourMeter: null,
    lastServicedOdometer: null,
    ...overrides,
  };
}

const noMeter: MeterReading = { hourMeter: null, odometer: null };

describe('due assessment', () => {
  describe('a schedule with no interval', () => {
    it('has no triggers and is never due', () => {
      // The database refuses such a row and so does the DTO. This is the
      // evaluator's own answer for one that got through anyway — silence, not
      // a crash, and certainly not "due".
      const assessment = assessDue(rule(), noMeter, NOW);

      expect(assessment.triggers).toHaveLength(0);
      expect(assessment.state).toBe('NOT_DUE');
      expect(assessment.basis).toBeNull();
      expect(isAnnounceable(assessment)).toBe(false);
    });
  });

  describe('time-based', () => {
    const serviced = new Date(NOW.getTime() - 100 * DAY);

    it('is not due while the interval is still running', () => {
      const assessment = assessDue(
        rule({ intervalDays: 180, leadDays: 14, lastServicedAt: serviced }),
        noMeter,
        NOW,
      );

      expect(assessment.state).toBe('NOT_DUE');
      expect(assessment.triggers[0]?.remaining).toBe('80');
      // The date is still reported. "Not due, and here is when it will be" is
      // what a planning screen needs; withholding it until the schedule is
      // already late would make the calendar useless.
      expect(assessment.dueBy).toBe(new Date(serviced.getTime() + 180 * DAY).toISOString());
    });

    it('warns once inside the lead, and says by when', () => {
      // 100 days in on a 110-day interval with a 14-day lead: inside the
      // warning window, not yet late.
      const assessment = assessDue(
        rule({ intervalDays: 110, leadDays: 14, lastServicedAt: serviced }),
        noMeter,
        NOW,
      );

      expect(assessment.state).toBe('DUE_SOON');
      expect(assessment.basis).toBe('TIME');
      expect(assessment.dueBy).toBe(new Date(serviced.getTime() + 110 * DAY).toISOString());
      expect(isAnnounceable(assessment)).toBe(true);
    });

    it('is overdue past the due point, and reports how far past', () => {
      const assessment = assessDue(
        rule({ intervalDays: 90, leadDays: 14, lastServicedAt: serviced }),
        noMeter,
        NOW,
      );

      expect(assessment.state).toBe('OVERDUE');
      expect(assessment.triggers[0]?.remaining).toBe('-10');
    });

    it('tips to DUE_SOON exactly at the start of the lead, not a moment before', () => {
      // The boundary. One second earlier is NOT_DUE; the instant the window
      // opens is DUE_SOON. Anything vaguer than this is a warning that fires
      // on a day nobody can predict.
      const interval = 30;
      const lead = 7;
      const lastServicedAt = new Date(NOW.getTime() - (interval - lead) * DAY);

      const atBoundary = assessDue(
        rule({ intervalDays: interval, leadDays: lead, lastServicedAt }),
        noMeter,
        NOW,
      );
      const justBefore = assessDue(
        rule({ intervalDays: interval, leadDays: lead, lastServicedAt }),
        noMeter,
        new Date(NOW.getTime() - 1000),
      );

      expect(atBoundary.state).toBe('DUE_SOON');
      expect(justBefore.state).toBe('NOT_DUE');
    });

    it('measures from creation when the machine has never been serviced', () => {
      // A schedule written today for a machine with no service history is
      // measured from the day someone wrote it down — the only date available,
      // and the one a fleet manager would also use.
      const createdAt = new Date(NOW.getTime() - 40 * DAY);
      const assessment = assessDue(
        rule({ intervalDays: 30, createdAt, lastServicedAt: null }),
        noMeter,
        NOW,
      );

      expect(assessment.state).toBe('OVERDUE');
    });

    it('treats an absent lead as no warning window at all', () => {
      const lastServicedAt = new Date(NOW.getTime() - 30 * DAY);
      const assessment = assessDue(
        rule({ intervalDays: 30, leadDays: null, lastServicedAt }),
        noMeter,
        NOW,
      );

      // Exactly at the due point with no lead: not yet late, and announceable
      // — a schedule with no warning window still has to announce something.
      expect(assessment.state).toBe('DUE_SOON');
    });
  });

  describe('usage-based', () => {
    it('anchors on the last service reading, not on zero', () => {
      // The failure this prevents: a schedule added to a grader with 4 310
      // hours on it reporting as overdue the moment it is saved.
      const assessment = assessDue(
        rule({ intervalHours: '250.00', leadHours: '25.00', lastServicedHourMeter: '4310.00' }),
        { hourMeter: '4310.00', odometer: null },
        NOW,
      );

      expect(assessment.state).toBe('NOT_DUE');
      expect(assessment.triggers[0]?.dueAtMeter).toBe('4560.00');
      expect(assessment.triggers[0]?.remaining).toBe('250.00');
    });

    it('warns inside the lead and reports the meter it falls due at', () => {
      const assessment = assessDue(
        rule({ intervalHours: '250.00', leadHours: '25.00', lastServicedHourMeter: '4310.00' }),
        { hourMeter: '4540.00', odometer: null },
        NOW,
      );

      expect(assessment.state).toBe('DUE_SOON');
      expect(assessment.basis).toBe('HOURS');
      expect(assessment.dueAtMeter).toBe('4560.00');
      expect(assessment.dueBy).toBeNull();
    });

    it('is overdue past the reading, and says by how much', () => {
      const assessment = assessDue(
        rule({ intervalHours: '250.00', leadHours: '25.00', lastServicedHourMeter: '4310.00' }),
        { hourMeter: '4580.50', odometer: null },
        NOW,
      );

      expect(assessment.state).toBe('OVERDUE');
      expect(assessment.triggers[0]?.remaining).toBe('-20.50');
    });

    it('does the arithmetic exactly, never through a float', () => {
      // 0.1 + 0.2 !== 0.3 in binary floating point. A schedule evaluated that
      // way drifts, and a drifting schedule is a machine that misses a
      // service. The value below is chosen so a float implementation lands on
      // the wrong side of the boundary.
      const assessment = assessDue(
        rule({ intervalHours: '0.30', lastServicedHourMeter: '0.10' }),
        { hourMeter: '0.40', odometer: null },
        NOW,
      );

      expect(assessment.triggers[0]?.remaining).toBe('0.00');
      expect(assessment.state).toBe('DUE_SOON');
    });

    it('falls back to the current reading when the anchor is missing', () => {
      // A schedule that predates any reading for the machine. Measuring from
      // zero would report every machine already in service as overdue.
      const assessment = assessDue(
        rule({ intervalHours: '250.00', lastServicedHourMeter: null }),
        { hourMeter: '4310.00', odometer: null },
        NOW,
      );

      expect(assessment.state).toBe('NOT_DUE');
      expect(assessment.triggers[0]?.dueAtMeter).toBe('4560.00');
    });
  });

  describe('more than one trigger', () => {
    const serviced = new Date(NOW.getTime() - 10 * DAY);

    it('comes due on whichever is reached first', () => {
      // Time is comfortable, hours are not. A schedule that reported NOT_DUE
      // here would be one where a machine is overdue on hours and compliant on
      // the calendar — the exact ambiguity "whichever comes first" removes.
      const assessment = assessDue(
        rule({
          intervalDays: 180,
          leadDays: 14,
          lastServicedAt: serviced,
          intervalHours: '250.00',
          lastServicedHourMeter: '4310.00',
        }),
        { hourMeter: '4600.00', odometer: null },
        NOW,
      );

      expect(assessment.state).toBe('OVERDUE');
      expect(assessment.basis).toBe('HOURS');
      // Both are still reported, so a screen can explain why.
      expect(assessment.triggers.map((t) => t.basis)).toEqual(['TIME', 'HOURS']);
      expect(assessment.triggers[0]?.state).toBe('NOT_DUE');
    });

    it('prefers a date when two triggers are in the same state', () => {
      // Comparing "30 days left" with "40 kilometres left" is comparing
      // nothing, so the tie-break is stated rather than computed: a date is
      // what a person plans around.
      const assessment = assessDue(
        rule({
          intervalDays: 20,
          leadDays: 15,
          lastServicedAt: serviced,
          intervalKilometres: '1000.00',
          leadKilometres: '900.00',
          lastServicedOdometer: '0.00',
        }),
        { hourMeter: null, odometer: '150.00' },
        NOW,
      );

      expect(assessment.state).toBe('DUE_SOON');
      expect(assessment.basis).toBe('TIME');
    });
  });
});
