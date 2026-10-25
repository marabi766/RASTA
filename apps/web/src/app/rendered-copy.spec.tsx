import { act, render } from '@testing-library/react';

import { RecoveryScreen } from './account/recovery/RecoveryScreen';
import { QuarantineGate } from './UnresolvedQuarantine';
import type { QuarantineSource } from '@/lib/unresolved-tenancy';

/**
 * The pre-review rule on Persian text (item 19), checked on what a person
 * reads — the screens this round adds, rendered, text and attributes alike —
 * not on the source lines: no U+0654 (the hamza above) and none of the hamza
 * letters U+0623, U+0625, U+0624, U+0626. Every character is named by its
 * number, so this file holds none of them.
 */

const FORBIDDEN = [0x0654, 0x0623, 0x0625, 0x0624, 0x0626].map((code) =>
  String.fromCodePoint(code),
);

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
  held: () => [{ key: RECORD_AT, raw: '{}' }],
  acknowledge: () => undefined,
};

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
])('%s, as rendered, has no U+0654 and no hamza letter', async (_name, screen) => {
  const { container } = render(screen());
  await act(async () => undefined);
  const text = rendered(container);
  expect(text.length).toBeGreaterThan(100);
  expect(FORBIDDEN.filter((character) => text.includes(character))).toEqual([]);
});
