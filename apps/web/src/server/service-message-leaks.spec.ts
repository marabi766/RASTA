/**
 * @jest-environment node
 */
import * as drivers from './drivers';
import * as maintenanceCommands from './maintenance-commands';
import * as orders from './orders';
import * as usage from './usage';
import { KNOWN_MAPPINGS, resolveMappings } from '@/test/entry-points';

import { GENERIC_REFUSAL_MESSAGE, mapProblemToFields, type FieldMapping } from './write';

/**
 * The class «English backend text reaches the Persian UI» (demo run of
 * 2026-10-24): every write module's mapping, run over the four sentences the
 * demo showed and over a sentence nobody has seen yet. Whatever the module
 * lists or does not list, the reader gets Persian — the English sentence, an
 * internal ticket number (Q-110) and an echo of typed input never leave the
 * server.
 */

// Every FieldMapping declaration — exported constants, factories and private
// constants alike, in any directory — found, not listed (test/entry-points.ts).
const RESOLVED = resolveMappings();
const MAPPINGS: ReadonlyArray<readonly [string, FieldMapping<string>]> = RESOLVED.mappings;

const LATIN_WORD = /[A-Za-z]{3,}/;

describe('every write module’s mapping', () => {
  it('is found: the sweep below is not vacuous, and nothing is left out (PR-439 r1 F4)', () => {
    expect(RESOLVED.unaccounted).toEqual([]);
    expect(RESOLVED.stale).toEqual([]);
    expect(RESOLVED.discovered).toEqual(expect.arrayContaining([...KNOWN_MAPPINGS]));
    expect(MAPPINGS.length).toBeGreaterThanOrEqual(40);
    expect(MAPPINGS.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'server/usage:USAGE_FIELD_MAPPING',
        'server/orders:ORDER_COMMAND_FIELD_MAPPING',
        'server/drivers:CREATE_DRIVER_FIELD_MAPPING',
        'server/maintenance-commands:REPORT_REQUEST_FIELD_MAPPING',
        'server/fleet-availability:REVOKE_MAPPING',
        'server/tender-bids:bidFieldMapping#1',
        'server/tender-owner:mappingFor#0',
      ]),
    );
  });

  describe.each(MAPPINGS)('%s', (_name, mapping) => {
    const ECHO = 'Some new rule about Q-110 and your input typed-input-xyz';

    it('never shows an unknown English sentence, in a message or on a field', () => {
      const field = Object.keys(mapping.paths)[0] ?? 'x';
      for (const problem of [
        { code: 'SOME_NEW_CODE', message: ECHO },
        { code: 'VALIDATION_FAILED', message: 'bad', details: [{ path: field, message: ECHO }] },
        {
          code: 'VALIDATION_FAILED',
          message: 'bad',
          details: [{ path: 'nowhere', message: ECHO }],
        },
      ]) {
        const mapped = mapProblemToFields(problem, mapping);
        const shown = [mapped.message, ...Object.values(mapped.fieldErrors)].filter(
          (text): text is string => typeof text === 'string',
        );
        expect(shown.length).toBeGreaterThan(0);
        for (const text of shown) {
          expect(text).not.toContain('Q-110');
          expect(text).not.toContain('typed-input-xyz');
          expect(text).not.toMatch(LATIN_WORD);
        }
      }
    });

    it('translates the shared text-rule refusals', () => {
      const mapped = mapProblemToFields(
        { code: 'VALIDATION_FAILED', message: 'Contains unsupported characters' },
        mapping,
      );
      expect(mapped.message).not.toMatch(LATIN_WORD);
      expect(mapped.message).not.toBeNull();
    });
  });
});

describe('the four sentences the demo run showed', () => {
  const say = (mapping: FieldMapping<string>, message: string, path?: string, code = 'X') =>
    mapProblemToFields(
      path === undefined
        ? { code, message }
        : { code: 'VALIDATION_FAILED', message: 'bad', details: [{ path, message }] },
      mapping,
    );

  it('«Contains unsupported characters» on the maintenance report and driver forms', () => {
    const report = say(
      maintenanceCommands.REPORT_REQUEST_FIELD_MAPPING,
      'Contains unsupported characters',
      'description',
    );
    expect(report.fieldErrors).toEqual({
      description: expect.stringContaining('نویسه‌ی غیرمجاز'),
    });
    const driver = say(
      drivers.CREATE_DRIVER_FIELD_MAPPING,
      'Contains unsupported characters',
      'notes',
    );
    expect(driver.fieldErrors).toEqual({ notes: expect.stringContaining('نویسه‌ی غیرمجاز') });
  });

  it('«This usage period overlaps …» on the usage form', () => {
    const mapped = say(
      usage.USAGE_FIELD_MAPPING,
      'This usage period overlaps an existing record for the same machine.',
      undefined,
      'BUSINESS_RULE_VIOLATION',
    );
    expect(mapped.message).toContain('هم‌پوشانی');
    expect(mapped.message).not.toBe(GENERIC_REFUSAL_MESSAGE);
  });

  it('«A receipt confirmation note is not stored yet (open question Q-110) …» on confirm-receipt', () => {
    const mapped = say(
      orders.ORDER_COMMAND_FIELD_MAPPING,
      'A receipt confirmation note is not stored yet (open question Q-110); leave it out',
      'note',
    );
    expect(mapped.fieldErrors.note).toBe(orders.RECEIPT_NOTE_REFUSAL);
    expect(JSON.stringify(mapped)).not.toContain('Q-110');
  });
});

describe('what the new fallback must not take away', () => {
  it('keeps the specific sentence the approve action redirects on (stale-total)', () => {
    const mapped = mapProblemToFields(
      {
        code: 'BUSINESS_RULE_VIOLATION',
        message:
          'The cost has changed since it was shown to you; review it again before approving.',
      },
      maintenanceCommands.APPROVE_REQUEST_FIELD_MAPPING,
    );
    expect(mapped.message).toBe(maintenanceCommands.APPROVAL_TOTAL_CHANGED_MESSAGE);
  });

  it('keeps the closed-state sentences of the maintenance request, and its code-keyed fallback', () => {
    const mapping = maintenanceCommands.CANCEL_REQUEST_FIELD_MAPPING;
    expect(
      mapProblemToFields(
        {
          code: 'INVALID_STATE_TRANSITION',
          message: 'This maintenance request is already APPROVED',
        },
        mapping,
      ).message,
    ).toBe(
      maintenanceCommands.REQUEST_STATE_MESSAGES['This maintenance request is already APPROVED'],
    );
    expect(
      mapProblemToFields({ code: 'INVALID_STATE_TRANSITION', message: 'New wording' }, mapping)
        .message,
    ).toContain('وضعیت فعلی درخواست');
  });
});
