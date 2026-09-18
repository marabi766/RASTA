import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Render a component in both writing directions.
 *
 * docs/16 § 16.3 makes this a rule rather than a suggestion: *«هر Component در
 * هر دو جهت Snapshot می‌شود. یک Component که فقط در LTR درست است، در این پروژه
 * شکسته است.»* The portal is right-to-left, so the direction a component is
 * actually used in is the one a Latin-first habit gets wrong — and a snapshot
 * taken in only one direction cannot tell the difference between a layout
 * written with logical properties and one written with physical ones that
 * happens to look right today.
 *
 * The direction is set on a wrapper element rather than on `document.dir`, so
 * two directions can be asserted in one test file without either leaking into
 * the other.
 */
export function renderInDirection(ui: ReactElement, direction: 'rtl' | 'ltr'): RenderResult {
  const container = document.createElement('div');
  container.setAttribute('dir', direction);
  document.body.appendChild(container);
  return render(ui, { container });
}

/**
 * Snapshot a component in both directions under one name.
 *
 * Call it from inside a `describe`. It produces two named snapshots, so a
 * change that affects only one direction is visible as exactly that.
 */
export function itSnapshotsInBothDirections(name: string, ui: () => ReactElement): void {
  it.each(['rtl', 'ltr'] as const)(`${name} (%s)`, (direction) => {
    const { container } = renderInDirection(ui(), direction);
    expect(container).toMatchSnapshot();
  });
}
