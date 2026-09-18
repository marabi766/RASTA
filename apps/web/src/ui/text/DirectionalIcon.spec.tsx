import { itSnapshotsInBothDirections, renderInDirection } from '@/test/directions';

import { DirectionalIcon } from './DirectionalIcon';

describe('DirectionalIcon', () => {
  // docs/16 § 16.3: an unmirrored "next" chevron in a right-to-left document
  // points back the way the reader came.
  it('mirrors itself in a right-to-left document', () => {
    const { container } = renderInDirection(
      <DirectionalIcon>
        <svg />
      </DirectionalIcon>,
      'rtl',
    );
    expect(container.firstElementChild).toHaveClass('rtl:-scale-x-100');
  });

  // The arrow repeats the label of whatever it sits inside; announcing it
  // would say the same thing twice.
  it('is hidden from assistive technology', () => {
    const { container } = renderInDirection(
      <DirectionalIcon>
        <svg />
      </DirectionalIcon>,
      'rtl',
    );
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  itSnapshotsInBothDirections('wrapping an arrow', () => (
    <DirectionalIcon>
      <svg />
    </DirectionalIcon>
  ));
});
