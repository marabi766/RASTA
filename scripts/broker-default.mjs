/** Restore value AND provenance, including a setup write whose response was lost. */
export async function withBrokerDefault(bytes, work, { read, set }) {
  const before = await read();
  try {
    if (bytes !== before) await set(bytes);
    return await work();
  } finally {
    await restore(before, read, set);
  }
}

async function restore(before, read, set) {
  // A failed read cannot prove that an attempted write did not commit.
  let current;
  try {
    current = await read();
  } catch {
    await set(before);
    throw new Error('broker default restoration: read failed; original override reapplied');
  }
  if (current !== before) await set(before);
}
