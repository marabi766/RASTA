import { axe } from 'jest-axe';

import { itSnapshotsInBothDirections, renderInDirection } from '@/test/directions';

import { Identifier } from './Identifier';

describe('Identifier', () => {
  it('isolates the run with a bdi element', () => {
    const { container } = renderInDirection(<Identifier>ORD-2026-0148</Identifier>, 'rtl');
    const bdi = container.querySelector('bdi');
    expect(bdi).not.toBeNull();
    expect(bdi).toHaveTextContent('ORD-2026-0148');
  });

  // The attribute is the rule of docs/16 § 16.3. Asserting it rather than
  // relying on <bdi>'s default means an edit that swaps the element for a
  // <span> cannot pass unnoticed.
  it('states dir="auto" explicitly', () => {
    const { container } = renderInDirection(<Identifier>ORD-2026-0148</Identifier>, 'rtl');
    expect(container.querySelector('bdi')).toHaveAttribute('dir', 'auto');
  });

  it('carries the monospace family from the token, not a font name', () => {
    const { container } = renderInDirection(<Identifier>ORD-1</Identifier>, 'rtl');
    expect(container.querySelector('bdi')).toHaveClass('font-mono');
  });

  it('renders identically inside Persian text', async () => {
    const { container } = renderInDirection(
      <p>
        شمارهٔ سفارش <Identifier>ORD-2026-0148</Identifier> ثبت شد.
      </p>,
      'rtl',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  itSnapshotsInBothDirections('an order code inside a sentence', () => (
    <p>
      شمارهٔ سفارش <Identifier>ORD-2026-0148</Identifier> ثبت شد.
    </p>
  ));
});
