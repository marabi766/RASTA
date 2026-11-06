import { withRedirectProbe } from './redirect-probe';

it('N2 probe sender refuses external URLs and retained use, while its control still follows', async () => {
  let retained: typeof fetch;
  let savedUrl = '';
  await withRedirectProbe({ body: { ok: true }, status: 307 }, async (probe) => {
    retained = probe.fetch;
    savedUrl = probe.baseUrl;
    for (const input of [
      'http://127.0.0.1:1',
      new URL('https://example.invalid/'),
      new Request('https://example.invalid/'),
    ])
      await expect(probe.fetch(input)).rejects.toThrow('Redirect probe origin refused');
    expect(probe.sent).toHaveLength(0);
    const input = new URL(probe.baseUrl);
    jest
      .spyOn(input, 'toString')
      .mockReturnValueOnce(probe.baseUrl)
      .mockReturnValue('http://127.0.0.1:1');
    const response = await probe.fetch(input, { method: 'POST', body: 'control' });
    expect(response.status).toBe(200);
    expect(probe.target).toHaveLength(1);
    await response.text();
  });
  await expect(retained!(savedUrl)).rejects.toThrow('Redirect probe origin refused');
});
