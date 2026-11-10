/** Claim only when the caller is ready: no lease is spent waiting behind another item. */
export async function* claimWhenReady<T>(
  limit: number,
  stopped: () => boolean,
  claim: () => Promise<readonly T[]>,
): AsyncGenerator<T, void, void> {
  for (let taken = 0; taken < limit && !stopped(); taken += 1) {
    const rows = await claim();
    if (rows.length === 0) return;
    const [item] = rows;
    if (rows.length !== 1 || item === undefined) throw new Error('Expected one just-in-time claim');
    yield item;
  }
}
