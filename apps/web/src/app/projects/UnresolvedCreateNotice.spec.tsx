import { render, screen } from '@testing-library/react';

import { UnresolvedCreateNotice } from './UnresolvedCreateNotice';

jest.mock('./actions', () => ({ releaseUnresolvedCreate: jest.fn() }));

const REQUEST = {
  id: 'a'.repeat(32),
  key: 'sub_k',
  digest: 'd',
  deadline: 10_000,
  ref: 'r',
  inFlight: false,
};

describe('the unresolved create notice', () => {
  it('points at the UNFILTERED list and asks for the duplicate-risk confirmation', () => {
    const { container } = render(
      <UnresolvedCreateNotice
        request={REQUEST}
        csrfToken="csrf"
        releaseToken="signed-name"
        now={5_000}
      />,
    );
    expect(screen.getByRole('link', { name: /بدون فیلتر/ })).toHaveAttribute('href', '/projects');
    const box = container.querySelector('input[type="checkbox"]');
    expect(box).toBeRequired();
    expect(screen.getByText(/ممکن است پروژه تکراری بسازد/)).toBeInTheDocument();
    expect(screen.getByText(/همان درخواست را با همان مقدارها/)).toBeInTheDocument();
  });

  it('names the record it was drawn for in the release form', () => {
    const { container } = render(
      <UnresolvedCreateNotice
        request={REQUEST}
        csrfToken="csrf"
        releaseToken="signed-name"
        now={5_000}
      />,
    );
    expect(container.querySelector('input[name="release"]')).toHaveValue('signed-name');
  });

  it('says so while a dispatch is in flight', () => {
    render(
      <UnresolvedCreateNotice
        request={{ ...REQUEST, inFlight: true }}
        csrfToken="csrf"
        releaseToken="signed-name"
        now={5_000}
      />,
    );
    expect(screen.getByText(/هم‌اکنون در حال فرستاده شدن/)).toBeInTheDocument();
  });

  it('does not claim the full list proves the first request did not happen', () => {
    render(
      <UnresolvedCreateNotice request={REQUEST} csrfToken="csrf" releaseToken="s" now={5_000} />,
    );
    expect(screen.getByText(/ثابت نمی‌کند که درخواست نخست انجام نشده/)).toBeInTheDocument();
  });

  it('says the same request can no longer be sent once the deadline has passed', () => {
    render(
      <UnresolvedCreateNotice
        request={REQUEST}
        csrfToken="csrf"
        releaseToken="signed-name"
        now={10_001}
      />,
    );
    expect(screen.getByText(/مهلت فرستادن دوباره همان درخواست گذشته/)).toBeInTheDocument();
  });
});
