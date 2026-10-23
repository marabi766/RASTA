import { render, screen } from '@testing-library/react';

import { UnresolvedCreateNotice } from './UnresolvedCreateNotice';

jest.mock('./actions', () => ({ releaseUnresolvedCreate: jest.fn() }));

const REQUEST = { key: 'sub_k', digest: 'd', deadline: 10_000, ref: 'r' };

describe('the unresolved create notice', () => {
  it('points at the UNFILTERED list and asks for the duplicate-risk confirmation', () => {
    const { container } = render(
      <UnresolvedCreateNotice request={REQUEST} csrfToken="csrf" now={5_000} />,
    );
    expect(screen.getByRole('link', { name: /بدون فیلتر/ })).toHaveAttribute('href', '/projects');
    const box = container.querySelector('input[type="checkbox"]');
    expect(box).toBeRequired();
    expect(screen.getByText(/ممکن است پروژه تکراری بسازد/)).toBeInTheDocument();
    expect(screen.getByText(/همان درخواست را با همان مقدارها/)).toBeInTheDocument();
  });

  it('says the same request can no longer be sent once the deadline has passed', () => {
    render(<UnresolvedCreateNotice request={REQUEST} csrfToken="csrf" now={10_001} />);
    expect(screen.getByText(/مهلت فرستادن دوباره همان درخواست گذشته/)).toBeInTheDocument();
  });
});
