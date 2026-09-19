import { axe } from 'jest-axe';
import { screen } from '@testing-library/react';

import { itSnapshotsInBothDirections, renderInDirection } from '@/test/directions';

import { AppShell } from './AppShell';
import { Grid } from './Grid';
import { PageHeader } from './PageHeader';
import { Section } from './Section';
import { Sidebar } from './Sidebar';
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
      sidebar={<Sidebar items={ITEMS} currentHref="/assets" />}
    >
      <PageHeader title="ماشین‌آلات" />
    </AppShell>
  ));
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
