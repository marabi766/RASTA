import { axe } from 'jest-axe';
import { fireEvent, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

import { itSnapshotsInBothDirections, renderInDirection } from '@/test/directions';

import { AppShell } from './AppShell';
import { Grid } from './Grid';
import { PageHeader } from './PageHeader';
import { Section } from './Section';
import { Sidebar } from './Sidebar';
import { ThemeOwner } from '../theme/ThemeSwitch';
import { TopBar } from './TopBar';

const ITEMS = [
  { href: '/assets', label: 'ماشین‌آلات' },
  { href: '/orders', label: 'سفارش‌ها' },
];

describe('AppShell', () => {
  // WCAG 2.4.1. Without it, reaching the page by keyboard means tabbing
  // through the whole sidebar on every single screen.
  it('starts the document with a skip link that points at the main landmark', () => {
    const { container } = renderInDirection(<AppShell>محتوا</AppShell>, 'rtl');
    const first = container.querySelector('a');
    expect(first).toHaveAttribute('href', '#main');
    expect(container.querySelector('main')).toHaveAttribute('id', 'main');
  });

  it('has exactly one main landmark', () => {
    renderInDirection(
      <AppShell topBar={<TopBar />} sidebar={<Sidebar items={ITEMS} />}>
        محتوا
      </AppShell>,
      'rtl',
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(
      <AppShell
        topBar={<TopBar organizationName="دهیاری نمونه" />}
        sidebar={<Sidebar items={ITEMS} currentHref="/assets" />}
      >
        <PageHeader title="ماشین‌آلات" />
      </AppShell>,
      'rtl',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  itSnapshotsInBothDirections('the full shell', () => (
    <AppShell
      topBar={<TopBar organizationName="دهیاری نمونه" />}
      sidebar={
        <>
          <ThemeOwner cookieName="rasta_theme" secure={false} />
          <Sidebar items={ITEMS} currentHref="/assets" />
        </>
      }
    >
      <PageHeader title="ماشین‌آلات" />
    </AppShell>
  ));
});

describe('TopBar', () => {
  it('carries the light / dark switch before the page’s own controls, with or without them', () => {
    // The page names whose preference the switch keeps (`PageThemeOwner`); without it, no switch.
    const owner = <ThemeOwner cookieName="rasta_theme" secure={false} />;
    const { container, rerender } = renderInDirection(
      <>
        {owner}
        <TopBar />
      </>,
      'rtl',
    );
    expect(screen.getByRole('button', { name: 'حالت تیره' })).toHaveAttribute('type', 'button');

    rerender(
      <>
        {owner}
        <TopBar>
          <button type="button">خروج</button>
        </TopBar>
      </>,
    );
    const buttons = [...container.querySelectorAll('header button')].map((b) => b.textContent);
    expect(buttons).toEqual(['حالت تیره', 'خروج']);
  });
});

describe('Sidebar', () => {
  // Colour marks the current item for everyone who can see it and for nobody
  // who cannot. `aria-current` is the half that is announced.
  it('marks the current route with aria-current', () => {
    renderInDirection(<Sidebar items={ITEMS} currentHref="/orders" />, 'rtl');
    expect(screen.getByRole('link', { name: 'سفارش‌ها' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'ماشین‌آلات' })).not.toHaveAttribute('aria-current');
  });

  // A page has more than one navigation landmark, and an unlabelled one is
  // announced as "navigation" with no way to tell which.
  it('labels its navigation landmark', () => {
    renderInDirection(<Sidebar items={ITEMS} />, 'rtl');
    expect(screen.getByRole('navigation', { name: 'ناوبری اصلی' })).toBeInTheDocument();
  });

  // The icon repeats the label beside it; announcing both says everything
  // twice.
  it('hides a decorative icon from the accessible name', () => {
    renderInDirection(
      <Sidebar items={[{ href: '/a', label: 'ماشین‌آلات', icon: <svg /> }]} />,
      'rtl',
    );
    expect(screen.getByRole('link', { name: 'ماشین‌آلات' })).toBeInTheDocument();
  });

  itSnapshotsInBothDirections('with a current item', () => (
    <Sidebar items={ITEMS} currentHref="/assets" />
  ));
});

describe('Sidebar on a phone (demo run 2026-10-24: a 16-item menu filled every first screen)', () => {
  const MANY = Array.from({ length: 16 }, (_, index) => ({
    href: `/page-${index}`,
    label: `صفحه ${index}`,
  }));
  const list = () => document.getElementById('sidebar-links') as HTMLElement;

  it('starts collapsed behind a button with a name, aria-expanded and aria-controls', () => {
    renderInDirection(<Sidebar items={MANY} />, 'rtl');
    const button = screen.getByRole('button', { name: 'منوی ناوبری' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'sidebar-links');
    // `hidden` is display:none below `md`; `md:flex` puts the list back from md up.
    expect(list()).toHaveClass('hidden', 'md:flex');
    // The button itself is not drawn from md up.
    expect(button).toHaveClass('md:hidden');
  });

  it('opens and closes with the button, and keeps every link in either state', () => {
    renderInDirection(<Sidebar items={MANY} currentHref="/page-3" />, 'rtl');
    const button = screen.getByRole('button', { name: 'منوی ناوبری' });
    const hrefs = () =>
      Array.from(list().querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    const closedHrefs = hrefs();

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(list()).not.toHaveClass('hidden');
    expect(hrefs()).toEqual(closedHrefs);
    expect(closedHrefs).toEqual(MANY.map((item) => item.href));
    expect(screen.getByRole('link', { name: 'صفحه 3' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(list()).toHaveClass('hidden');
  });

  it('closes on Escape from a link in the list and puts focus back on the button', () => {
    renderInDirection(<Sidebar items={MANY} />, 'rtl');
    const button = screen.getByRole('button', { name: 'منوی ناوبری' });
    fireEvent.click(button);
    const link = screen.getByRole('link', { name: 'صفحه 5' });
    link.focus();
    expect(link).toHaveFocus();

    fireEvent.keyDown(link, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(list()).toHaveClass('hidden');
    expect(button).toHaveFocus();
  });

  it('ignores Escape while closed and every other key', () => {
    renderInDirection(<Sidebar items={MANY} />, 'rtl');
    const button = screen.getByRole('button', { name: 'منوی ناوبری' });
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  // Without JavaScript nothing can open a closed menu, so the server's HTML must
  // already be the whole list: visible, reachable, and with no dead button.
  it('is a plain visible list in the HTML the server sends', () => {
    const html = renderToString(<Sidebar items={MANY} currentHref="/page-1" />);
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/class="[^"]*\bhidden\b/);
    for (const item of MANY) expect(html).toContain(`href="${item.href}"`);
  });

  it('has no accessibility violations, closed or open', async () => {
    const { container } = renderInDirection(<Sidebar items={MANY} />, 'rtl');
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole('button', { name: 'منوی ناوبری' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('PageHeader', () => {
  it('renders the page heading at level one', () => {
    renderInDirection(<PageHeader title="ماشین‌آلات" description="ناوگان سازمان" />, 'rtl');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ماشین‌آلات');
  });

  itSnapshotsInBothDirections('with a description and an action', () => (
    <PageHeader
      title="ماشین‌آلات"
      description="ناوگان سازمان"
      actions={<button type="button">ثبت دارایی</button>}
    />
  ));
});

describe('Section', () => {
  // A region that is not labelled cannot be navigated to by name, which on a
  // dense operations screen is the difference between usable and not.
  it('ties its heading to the region', () => {
    renderInDirection(
      <Section headingId="fleet" title="ناوگان">
        محتوا
      </Section>,
      'rtl',
    );
    expect(screen.getByRole('region', { name: 'ناوگان' })).toBeInTheDocument();
  });

  it('renders the section heading at level two', () => {
    renderInDirection(
      <Section headingId="fleet" title="ناوگان">
        محتوا
      </Section>,
      'rtl',
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('ناوگان');
  });

  itSnapshotsInBothDirections('with a description and an action', () => (
    <Section
      headingId="fleet"
      title="ناوگان"
      description="دارایی‌های در سرویس"
      actions={<button type="button">فیلتر</button>}
    >
      محتوا
    </Section>
  ));
});

describe('Grid', () => {
  // docs/16 § 16.2 expects this portal on a phone more often than on a desk,
  // so one column is the base of every step rather than an afterthought.
  it.each([2, 3, 4] as const)('starts at one column for %i columns', (columns) => {
    const { container } = renderInDirection(
      <Grid columns={columns}>
        <div />
      </Grid>,
      'rtl',
    );
    expect(container.firstElementChild?.className).toContain('grid-cols-1');
  });

  itSnapshotsInBothDirections('three columns', () => (
    <Grid columns={3}>
      <div>یک</div>
      <div>دو</div>
      <div>سه</div>
    </Grid>
  ));
});
