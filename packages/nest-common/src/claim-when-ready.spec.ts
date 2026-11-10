import { claimWhenReady, hasClaimBudget } from './claim-when-ready';

describe('claimWhenReady', () => {
  const budget = { leaseSeconds: 60, processingBudgetMs: 10_000 };
  const refused = jest.fn();
  it('requires a finite processing allowance and accepts exact remaining-budget equality', () => {
    jest.useFakeTimers();
    try {
      for (const processingBudgetMs of [NaN, Infinity, -1, 0, 60_001])
        expect(hasClaimBudget(0, { leaseSeconds: 60, processingBudgetMs })).toBe(false);
      expect(hasClaimBudget(0, { leaseSeconds: 60, processingBudgetMs: 60_000 })).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not prefetch, respects the work limit and stops before another claim', async () => {
    const claim = jest.fn(async () => [1]);
    let stopped = false;
    const items = claimWhenReady(2, () => stopped, claim, budget, refused);
    expect(claim).not.toHaveBeenCalled();
    expect(await items.next()).toMatchObject({ value: 1 });
    expect(claim).toHaveBeenCalledTimes(1);
    stopped = true;
    expect(await items.next()).toMatchObject({ done: true });
    expect(claim).toHaveBeenCalledTimes(1);
    const limited = claimWhenReady(1, () => false, claim, budget, refused);
    await limited.next();
    expect(await limited.next()).toMatchObject({ done: true });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it.each([[], [1, 2], new Error('claim unavailable')])(
    'ends empty or refuses invalid/failed claims: %p',
    async (answer) => {
      const items = claimWhenReady(
        2,
        () => false,
        async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
        budget,
        refused,
      );
      if (Array.isArray(answer) && answer.length === 0)
        await expect(items.next()).resolves.toMatchObject({ done: true });
      else await expect(items.next()).rejects.toThrow();
    },
  );
});
