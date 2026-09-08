import { screen } from '@testing-library/react';
import { ProviderDisclosureView } from './provider-disclosure-view';
import {
  expectNoAxeViolations,
  makeHarness,
  renderWithSession,
  respondError,
  respondJson,
} from '@/test/harness';

/**
 * Payment-provider disclosure.
 *
 * The property worth protecting is that this screen *reports* rather than
 * *asserts*. `economic-service`'s own contract suite requires a live provider
 * to stop repeating the simulated notice; a UI that hard-coded «حالت نمایشی»
 * would keep saying it forever, and the day a real provider is wired that
 * banner becomes a lie (ADR-024).
 */

const SIMULATED = {
  provider: 'mock',
  simulated: true,
  notice: 'Simulated payment provider. No bank connection, no real funds, no custody of money.',
};

describe('payment provider disclosure', () => {
  it('reads the disclosure from the gateway', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(SIMULATED));

    renderWithSession(<ProviderDisclosureView />, session);
    await screen.findByText('mock');

    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.origin).toBe('http://localhost:3000');
    expect(url.pathname).toBe('/v1/wallets/provider');
  });

  it('sends no Idempotency-Key on a safe method', async () => {
    // The gateway requires one on the `wallets` prefix for unsafe methods only.
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(SIMULATED));

    renderWithSession(<ProviderDisclosureView />, session);
    await screen.findByText('mock');

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe('GET');
    expect((init.headers as Headers).has('idempotency-key')).toBe(false);
  });

  it('states plainly that no money moves while the provider is simulated', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(SIMULATED));

    renderWithSession(<ProviderDisclosureView />, session);

    expect(await screen.findByText('شبیه‌سازی‌شده')).toBeInTheDocument();
    expect(screen.getByText(/هیچ اتصال بانکی وجود ندارد/)).toBeInTheDocument();
    expect(screen.getByText(SIMULATED.notice)).toBeInTheDocument();
  });

  it('stops claiming simulation the moment the service reports a live provider', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      respondJson({ provider: 'bank-gateway', simulated: false, notice: 'Live payment provider.' }),
    );

    renderWithSession(<ProviderDisclosureView />, session);

    expect(await screen.findByText('ارائه‌دهندهٔ واقعی')).toBeInTheDocument();
    expect(screen.queryByText('شبیه‌سازی‌شده')).not.toBeInTheDocument();
    expect(screen.queryByText(/هیچ اتصال بانکی وجود ندارد/)).not.toBeInTheDocument();
  });

  it('shows no wallet balance, not even a zero', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(SIMULATED));

    const { container } = renderWithSession(<ProviderDisclosureView />, session);
    await screen.findByText('mock');

    // docs/16 § 16.7: an empty dashboard beats a fabricated figure. There is no
    // balance endpoint call on this screen, so there must be no balance on it.
    expect(container.textContent).not.toMatch(/ریال/);
    expect(screen.getByText(/نه صفر، نه عدد نمونه/)).toBeInTheDocument();
  });

  it('renders a role refusal as a refusal', async () => {
    // The route allows SYSTEM_ADMIN, UNION_ADMIN and ORGANIZATION_ADMIN. A
    // PROCUREMENT_USER being refused is the platform working, not failing.
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(403, 'FORBIDDEN'));

    renderWithSession(<ProviderDisclosureView />, session);

    expect(await screen.findByText('این بخش برای نقش شما باز نیست')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a 503 with a retry and the correlation id', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(503, 'UPSTREAM_UNAVAILABLE'));

    renderWithSession(<ProviderDisclosureView />, session);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('cid-gateway');
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(SIMULATED));

    const { container } = renderWithSession(<ProviderDisclosureView />, session);
    await screen.findByText('mock');

    await expectNoAxeViolations(container);
  });
});
