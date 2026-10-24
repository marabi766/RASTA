/**
 * @jest-environment node
 */
import { readSource } from '@/test/service-source';

import { ORDER_COMMAND_FIELD_MAPPING, RECEIPT_NOTE_REFUSAL } from './orders';

/**
 * What the order-command mapping depends on, pinned to marketplace-service's
 * source (A-02 forbids importing `services/*\/src`): the sentences the portal
 * translates are still the ones the service throws, so a reworded service
 * fails here instead of putting English — or a ticket number — on a buyer's
 * screen.
 */

const SERVICE = ['services', 'marketplace-service', 'src', 'order'] as const;
const sources = ['dto.ts', 'order.service.ts', 'state-machine.ts']
  .map((file) => readSource(...SERVICE, file))
  .join('\n');

describe('the order-command sentences the portal translates', () => {
  it('are still written, verbatim, in the service', () => {
    const sentences = Object.keys(ORDER_COMMAND_FIELD_MAPPING.messages ?? {});
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    for (const sentence of sentences) {
      expect([sentence, sources.includes(`'${sentence}'`)]).toEqual([sentence, true]);
    }
  });

  it('include the Q-110 receipt-note refusal, which says it in Persian without the ticket', () => {
    expect(
      ORDER_COMMAND_FIELD_MAPPING.messages?.[
        'A receipt confirmation note is not stored yet (open question Q-110); leave it out'
      ],
    ).toBe(RECEIPT_NOTE_REFUSAL);
    expect(RECEIPT_NOTE_REFUSAL).not.toMatch(/Q-\d+|[A-Za-z]{3,}/);
  });

  it('match the state-machine sentences the service builds from ids and statuses', () => {
    const [pattern] = ORDER_COMMAND_FIELD_MAPPING.patterns![0]!;
    expect(sources).toContain('cannot move from ${from} to ${to}');
    expect(sources).toContain('is already ${from} and cannot change further');
    expect(pattern.test('Order ORD_1 cannot move from DISPUTED to CONFIRMED')).toBe(true);
    expect(pattern.test('Order ORD_1 is already COMPLETED and cannot change further')).toBe(true);
    expect(pattern.test('Order ORD_1 is on fire')).toBe(false);
  });
});
