import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { TableScroll } from './TableScroll';

/**
 * The scroll box around a wide table. What a real browser does with it —
 * whether the page still fits a phone — is proven in `e2e/accessibility.spec.ts`;
 * what a component test can prove is that the box is reachable, named and does
 * not bake in a direction.
 */

function renderTable() {
  return render(
    <TableScroll label="فهرست نمونه">
      <table>
        <caption>فهرست نمونه</caption>
        <thead>
          <tr>
            <th scope="col">عنوان</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>ردیف</td>
          </tr>
        </tbody>
      </table>
    </TableScroll>,
  );
}

describe('TableScroll', () => {
  it('holds what it is given', () => {
    renderTable();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('is a named group, not a landmark', () => {
    renderTable();
    expect(screen.getByRole('group', { name: 'فهرست نمونه' })).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('is a keyboard stop, so a region that scrolls can be scrolled without a pointer', () => {
    renderTable();
    expect(screen.getByRole('group', { name: 'فهرست نمونه' })).toHaveAttribute('tabindex', '0');
  });

  it('scrolls sideways only, and shows where the focus is', () => {
    renderTable();
    const box = screen.getByRole('group', { name: 'فهرست نمونه' });
    expect(box).toHaveClass('overflow-x-auto');
    expect(box.className).toContain('focus-visible:outline');
  });

  it('uses no physical-direction utility, so it mirrors with the page', () => {
    const { container } = renderTable();
    expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)/);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderTable();
    expect(await axe(container)).toHaveNoViolations();
  });
});
