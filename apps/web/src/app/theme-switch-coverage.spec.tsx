import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ThemeOwner } from '@/ui';

import { NoOrganizationScreen } from './account/no-organization/NoOrganizationScreen';
import { RecoveryScreen } from './account/recovery/RecoveryScreen';
import { LoginScreen } from './login/LoginScreen';

/**
 * Every page can reach the light / dark switch (owner decision 2026-10-24).
 *
 * A page inside the application shell has it through `TopBar`. A page with no
 * shell — the three screens below — draws it itself, after its main action so
 * that the first control reached by keyboard is still the way forward. This
 * file closes the class rather than the instances: a new page that has neither
 * fails here, so the switch cannot quietly be missing from the next screen.
 */

const APP = __dirname;

/** Pages with no shell, and the screen file each draws its body in. */
const SHELL_LESS: Record<string, string> = {
  'login/page.tsx': 'login/LoginScreen.tsx',
  'account/recovery/page.tsx': 'account/recovery/RecoveryScreen.tsx',
  'account/no-organization/page.tsx': 'account/no-organization/NoOrganizationScreen.tsx',
};

function pages(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pages(full, found);
    else if (entry.name === 'page.tsx') found.push(relative(APP, full));
  }
  return found;
}

const read = (path: string) => readFileSync(join(APP, path), 'utf8');

describe('the theme switch is on every page', () => {
  it('finds the pages', () => {
    expect(pages(APP).length).toBeGreaterThan(30);
  });

  it.each(pages(APP))(
    '%s has the top bar, or is a shell-less screen with its own switch',
    (page) => {
      if (page in SHELL_LESS) {
        expect(read(SHELL_LESS[page])).toContain('<ThemeSwitch />');
        // …and names whose preference it keeps, in the page's own render.
        expect(read(page)).toContain('<PageThemeOwner');
        return;
      }
      expect(read(page)).toContain('<TopBar');
      // The shell page names its owner through the sidebar it draws.
      expect(read(page)).toContain('<PortalSidebar');
    },
  );

  it('keeps the shell-less list honest: every entry is a real page', () => {
    const all = pages(APP);
    for (const page of Object.keys(SHELL_LESS)) expect(all).toContain(page);
  });
});

describe.each([
  ['the login screen', () => <LoginScreen />],
  ['the recovery screen', () => <RecoveryScreen csrfToken="c" />],
  ['the no-organization screen', () => <NoOrganizationScreen csrfToken="c" />],
])('%s', (_name, screen_) => {
  it('offers the switch as a plain button, outside any form, after the main action', () => {
    const { container } = render(
      <>
        <ThemeOwner cookieName="rasta_theme" secure={false} />
        {screen_()}
      </>,
    );
    const toggle = screen.getByRole('button', { name: 'حالت تیره' });
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle.closest('form')).toBeNull();

    // Nothing focusable follows it, and the first thing in the page is not it.
    const focusable = [...container.querySelectorAll('a[href], button, input, select, textarea')];
    expect(focusable[0]).not.toBe(toggle);
    expect(focusable[focusable.length - 1]).toBe(toggle);
  });
});

describe('the owner is delivered by the page, not by the root layout', () => {
  it('the root layout declares no owner and mounts no provider', () => {
    const layout = read('layout.tsx');
    expect(layout).not.toMatch(/<ThemeProvider|<ThemeOwner|<PageThemeOwner/);
    expect(layout).not.toMatch(/cookieName=/);
  });

  it('the shell sidebar and the three shell-less pages render it', () => {
    expect(read('PortalSidebar.tsx')).toContain('<PageThemeOwner subject={session.subject} />');
    expect(read('login/page.tsx')).toContain('<PageThemeOwner subject={null} />');
    expect(read('account/recovery/page.tsx')).toContain(
      '<PageThemeOwner subject={stored.subject} />',
    );
    expect(read('account/no-organization/page.tsx')).toContain(
      '<PageThemeOwner subject={session.subject} />',
    );
  });
});
