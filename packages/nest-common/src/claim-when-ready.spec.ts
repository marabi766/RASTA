import { claimWhenReady } from './claim-when-ready';

describe('claimWhenReady', () => {
  it('does not prefetch, respects the work limit and stops before another claim', async () => {
    const claim = jest.fn(async () => [1]);
    let stopped = false;
    const items = claimWhenReady(2, () => stopped, claim);
    expect(claim).not.toHaveBeenCalled();
    expect(await items.next()).toMatchObject({ value: 1 });
    expect(claim).toHaveBeenCalledTimes(1);
    stopped = true;
    expect(await items.next()).toMatchObject({ done: true });
    expect(claim).toHaveBeenCalledTimes(1);
    const limited = claimWhenReady(1, () => false, claim);
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
      );
      if (Array.isArray(answer) && answer.length === 0)
        await expect(items.next()).resolves.toMatchObject({ done: true });
      else await expect(items.next()).rejects.toThrow();
    },
  );
});
