import {
  allowedTransitions,
  canTransition,
  explainRefusal,
  openWorkRefusal,
  DISPATCHABLE_STATUSES,
  OPEN_ACTIVITY_STATUSES,
  OPEN_WORK_REFUSALS,
  TERMINAL_STATUSES,
  TRANSITIONS,
  type AssetStatus,
} from './lifecycle';

/**
 * The lifecycle table.
 *
 * Worth testing directly rather than only through the service: this table is
 * the definition of what may happen to an asset, and a wrong row here is a
 * defect that reads as correct code everywhere else.
 */

const ALL_STATUSES: AssetStatus[] = [
  'REGISTERED',
  'ACTIVE',
  'ASSIGNED',
  'IDLE',
  'IN_MAINTENANCE',
  'OUT_OF_SERVICE',
  'DECOMMISSIONED',
];

describe('asset lifecycle', () => {
  describe('table integrity', () => {
    it('names only known statuses', () => {
      for (const transition of TRANSITIONS) {
        expect(ALL_STATUSES).toContain(transition.from);
        expect(ALL_STATUSES).toContain(transition.to);
      }
    });

    it('has no duplicate rows', () => {
      const keys = TRANSITIONS.map((t) => `${t.from}->${t.to}:${t.actor}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('has no self-transitions', () => {
      // A status change to the same status would emit an event and a timeline
      // entry describing nothing.
      expect(TRANSITIONS.filter((t) => t.from === t.to)).toHaveLength(0);
    });

    it('leaves no status unreachable except the initial one', () => {
      const reachable = new Set(TRANSITIONS.map((t) => t.to));
      const unreachable = ALL_STATUSES.filter((s) => !reachable.has(s));
      // REGISTERED is where an asset starts; nothing transitions into it
      // except a transfer, which resets ownership rather than moving status.
      expect(unreachable).toEqual(['REGISTERED']);
    });
  });

  describe('terminal states', () => {
    it('lets nothing leave DECOMMISSIONED', () => {
      expect(allowedTransitions('DECOMMISSIONED', 'USER')).toEqual([]);
      expect(allowedTransitions('DECOMMISSIONED', 'EVENT')).toEqual([]);
    });

    it('agrees with TERMINAL_STATUSES', () => {
      for (const status of ALL_STATUSES) {
        const stuck =
          allowedTransitions(status, 'USER').length === 0 &&
          allowedTransitions(status, 'EVENT').length === 0;
        expect(stuck).toBe(TERMINAL_STATUSES.includes(status));
      }
    });

    it('explains why a decommissioned asset cannot move', () => {
      const message = explainRefusal('DECOMMISSIONED', 'ACTIVE', 'USER');
      expect(message).toContain('final');
      expect(message).toContain('audit');
    });
  });

  describe('ownership of state', () => {
    it('refuses to let a user assign or un-assign an asset directly', () => {
      // fleet-service owns assignment. Allowing it here would let two services
      // disagree about who is driving what.
      expect(canTransition('ACTIVE', 'ASSIGNED', 'USER')).toBe(false);
      expect(canTransition('ACTIVE', 'ASSIGNED', 'EVENT')).toBe(true);
    });

    it('refuses to let a user put an asset into maintenance directly', () => {
      expect(canTransition('ACTIVE', 'IN_MAINTENANCE', 'USER')).toBe(false);
      expect(canTransition('ACTIVE', 'IN_MAINTENANCE', 'EVENT')).toBe(true);
    });

    it('tells the caller which service owns the change instead of just refusing', () => {
      const message = explainRefusal('ACTIVE', 'IN_MAINTENANCE', 'USER');
      expect(message).toContain('not done directly');
      expect(message).toContain('maintenance');
    });

    it('lists what is possible when the target is simply wrong', () => {
      const message = explainRefusal('REGISTERED', 'IDLE', 'USER');
      expect(message).toContain('REGISTERED');
      expect(message).toContain('ACTIVE');
    });
  });

  describe('withdrawal and end of life', () => {
    it('allows withdrawal from every non-terminal state that has no open work', () => {
      for (const status of ALL_STATUSES) {
        if (status === 'OUT_OF_SERVICE' || TERMINAL_STATUSES.includes(status)) continue;
        if (OPEN_ACTIVITY_STATUSES.includes(status)) continue;
        expect(canTransition(status, 'OUT_OF_SERVICE', 'USER')).toBe(true);
      }
    });

    it('refuses withdrawal while another service has open work (docs/24 Q-94)', () => {
      // Taking an ASSIGNED asset out of service directly would leave the
      // assignment open in fleet-service; IN_MAINTENANCE, the repair open in
      // maintenance-service. The owning service ends its work first, and its
      // release event moves the status back to ACTIVE.
      expect(canTransition('ASSIGNED', 'OUT_OF_SERVICE', 'USER')).toBe(false);
      expect(canTransition('IN_MAINTENANCE', 'OUT_OF_SERVICE', 'USER')).toBe(false);
    });

    it('lets a person do nothing at all to the status while work is open', () => {
      for (const status of OPEN_ACTIVITY_STATUSES) {
        expect(allowedTransitions(status, 'USER')).toEqual([]);
      }
    });

    it('leaves the owning services’ own events exactly as they were', () => {
      // Only the person's route was closed. The events that start and end the
      // work are what move the status out of these two states.
      expect(allowedTransitions('ASSIGNED', 'EVENT').sort()).toEqual(['ACTIVE', 'IN_MAINTENANCE']);
      expect(allowedTransitions('IN_MAINTENANCE', 'EVENT')).toEqual(['ACTIVE']);
    });

    it('gives each open-work status one closed code, naming the service that must act', () => {
      expect(Object.keys(OPEN_WORK_REFUSALS).sort()).toEqual([...OPEN_ACTIVITY_STATUSES].sort());
      expect(openWorkRefusal('ASSIGNED', 'USER')).toMatchObject({
        code: 'OPEN_ASSIGNMENT',
        message: expect.stringContaining('fleet-service'),
      });
      expect(openWorkRefusal('IN_MAINTENANCE', 'USER')).toMatchObject({
        code: 'OPEN_MAINTENANCE',
        message: expect.stringContaining('maintenance-service'),
      });
    });

    it('is a refusal for a person only: an event is never told to end the work first', () => {
      expect(openWorkRefusal('ASSIGNED', 'EVENT')).toBeNull();
      expect(openWorkRefusal('ACTIVE', 'USER')).toBeNull();
      expect(openWorkRefusal('OUT_OF_SERVICE', 'USER')).toBeNull();
    });

    it.each(['OUT_OF_SERVICE', 'DECOMMISSIONED', 'ACTIVE'] as const)(
      'explains an open-work refusal the same way whatever is asked for (%s)',
      (target) => {
        expect(explainRefusal('ASSIGNED', target, 'USER')).toBe(
          OPEN_WORK_REFUSALS.ASSIGNED!.message,
        );
        expect(explainRefusal('IN_MAINTENANCE', target, 'USER')).toBe(
          OPEN_WORK_REFUSALS.IN_MAINTENANCE!.message,
        );
      },
    );

    it('refuses to decommission an asset that is assigned or in the workshop', () => {
      // Retiring a machine somebody is currently driving, or that a workshop
      // still holds, would strand an open record in another service.
      expect(canTransition('ASSIGNED', 'DECOMMISSIONED', 'USER')).toBe(false);
      expect(canTransition('IN_MAINTENANCE', 'DECOMMISSIONED', 'USER')).toBe(false);
    });

    it('allows decommissioning from rest states', () => {
      expect(canTransition('ACTIVE', 'DECOMMISSIONED', 'USER')).toBe(true);
      expect(canTransition('IDLE', 'DECOMMISSIONED', 'USER')).toBe(true);
      expect(canTransition('OUT_OF_SERVICE', 'DECOMMISSIONED', 'USER')).toBe(true);
      expect(canTransition('REGISTERED', 'DECOMMISSIONED', 'USER')).toBe(true);
    });
  });

  describe('dispatchability', () => {
    it('counts only ACTIVE and IDLE as dispatchable', () => {
      expect([...DISPATCHABLE_STATUSES].sort()).toEqual(['ACTIVE', 'IDLE']);
    });

    it('does not treat a registered asset as dispatchable', () => {
      // An asset can be registered without insurance; sending it out would put
      // the organization in breach.
      expect(DISPATCHABLE_STATUSES).not.toContain('REGISTERED');
    });
  });
});
