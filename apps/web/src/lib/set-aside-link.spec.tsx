import { fireEvent, render, screen } from '@testing-library/react';

import { setAsideOnOpen } from './set-aside-link';

/**
 * The set-aside link of every fenced form (`setAsideOnOpen`): a primary click
 * and a middle click open the page and set the request aside; a right-click,
 * which fires `auxclick` too (Chromium, Firefox), and the other buttons do not.
 */
function link() {
  const setAside = jest.fn();
  render(
    <a href="#page" {...setAsideOnOpen(setAside)}>
      page
    </a>,
  );
  return { setAside, element: screen.getByRole('link', { name: 'page' }) };
}

it('a primary click sets it aside', () => {
  const { setAside, element } = link();
  fireEvent.click(element, { button: 0 });
  expect(setAside).toHaveBeenCalledTimes(1);
});

it('a middle click — opening the page in another tab — sets it aside', () => {
  const { setAside, element } = link();
  fireEvent(element, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(setAside).toHaveBeenCalledTimes(1);
});

it.each([
  ['the right button (the context menu)', 2],
  ['the back button', 3],
  ['the forward button', 4],
])('%s sets nothing aside', (_label, button) => {
  const { setAside, element } = link();
  fireEvent(element, new MouseEvent('auxclick', { bubbles: true, button }));
  fireEvent.contextMenu(element);
  expect(setAside).not.toHaveBeenCalled();
});
