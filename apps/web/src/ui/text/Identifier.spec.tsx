import { axe } from 'jest-axe';

import { itSnapshotsInBothDirections, renderInDirection } from '@/test/directions';

import { Identifier, IsolatedText } from './Identifier';

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

describe('IsolatedText (L5-06, #220)', () => {
  const RLO = String.fromCodePoint(0x202e);

  it('isolates stored text with dir="auto", in the surrounding face', () => {
    const { container } = renderInDirection(<IsolatedText>دلیل تغییر</IsolatedText>, 'rtl');
    const bdi = container.querySelector('bdi');
    expect(bdi).toHaveAttribute('dir', 'auto');
    expect(bdi).not.toHaveClass('font-mono');
  });

  it('drops an override stored in the text, so it reads in the order it was typed', () => {
    const { container } = renderInDirection(<IsolatedText>{`12${RLO}34`}</IsolatedText>, 'rtl');
    expect(container.querySelector('bdi')?.textContent).toBe('1234');
  });

  it('does the same inside Identifier, and leaves element children alone', () => {
    const { container } = renderInDirection(
      <Identifier>
        {`WA${RLO}320`}
        <span>{'x'}</span>
      </Identifier>,
      'rtl',
    );
    expect(container.querySelector('bdi')?.textContent).toBe('WA320x');
  });
});
