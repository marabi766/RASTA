import { act, fireEvent, render, screen as page } from '@testing-library/react';

import { RecoveryScreen } from './account/recovery/RecoveryScreen';
import { HELD_MESSAGE as ORDER_HELD } from './marketplace/[productId]/PlaceOrderForm';
import { HELD_MESSAGE as DISPUTE_HELD } from './transactions/[id]/DisputeCommandForm';
import { QUARANTINE_CONFIRM, QUARANTINE_CONTINUE, QuarantineGate } from './UnresolvedQuarantine';
import type { QuarantineSource } from '@/lib/unresolved-tenancy';
import { nonStandardSpelling } from '@/test/orthography';

/**
 * Persian text on what a person reads — the screens this round adds, rendered,
 * text and attributes alike — not on the source lines: standard orthography,
 * hamza included (owner decision B, 2026-10-24, which replaced the earlier ban
 * on hamza letters): no hamza-less spelling and no combining hamza on alef, waw
 * or yeh (`test/orthography.ts`).
 */

/** Every text node and every attribute value under `root`. */
function rendered(root: HTMLElement): string {
  const parts: string[] = [root.textContent ?? ''];
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) parts.push(attribute.value);
  }
  return parts.join('\n');
}

/** One quarantined record under the order store's prefix: what draws the warning. */
const RECORD_AT = ['rasta.unresolved-order', 'PRD_1'].join('.');
const held: QuarantineSource = {
  held: () => [{ key: RECORD_AT, fingerprint: '2.0' }],
  // The acknowledgement could not be written: its fixed text is drawn too.
  acknowledge: () => 'FAILED',
  subscribe: () => () => undefined,
};

/** The warning, after an acknowledgement that failed (round 4, R2). */
function FailedAcknowledgement() {
  return (
    <QuarantineGate source={held} account={{ person: 'p', legacy: [] }}>
      <p>form</p>
    </QuarantineGate>
  );
}

it.each([
  ['the recovery page', () => <RecoveryScreen csrfToken="csrf" />],
  [
    'the quarantine warning',
    () => (
      <QuarantineGate source={held} account={{ person: 'p', legacy: [] }}>
        <p>form</p>
      </QuarantineGate>
    ),
  ],
  ['the quarantine warning after a failed acknowledgement', () => <FailedAcknowledgement />],
  ['the order form held by another order', () => <p>{ORDER_HELD}</p>],
  ['the dispute form held by another command', () => <p>{DISPUTE_HELD}</p>],
])('%s, as rendered, is in standard orthography', async (name, screen) => {
  const { container } = render(screen());
  await act(async () => undefined);
  if (name.includes('failed acknowledgement')) {
    fireEvent.click(page.getByLabelText(QUARANTINE_CONFIRM));
    fireEvent.click(page.getByRole('button', { name: QUARANTINE_CONTINUE }));
    expect(page.getAllByRole('alert')).toHaveLength(2);
  }
  const text = rendered(container);
  expect(text.length).toBeGreaterThan(100);
  expect(nonStandardSpelling(text)).toBeNull();
});
