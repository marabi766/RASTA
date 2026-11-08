import './disclosure-guard';

const LUCKY = JSON.stringify({ timestamp: '2026-10-25T01:39:13.000Z' });

describe('disclosure guard', () => {
  it('refuses a hazardous absence assertion even on a run where it would pass', () => {
    // Jest's own matcher passes here: this run's milliseconds are .000.
    expect(LUCKY.includes('12.5')).toBe(false);
    expect(() => expect(LUCKY).not.toContain('12.5')).toThrow(/can fail by chance/);
    expect(() => expect(LUCKY).not.toMatch(/12\.5/)).toThrow(/expectNotDisclosed/);
    expect(() =>
      expect(JSON.stringify({ correlationId: '01JABCDEFGHJKMNPQRSTVWXYZ0' })).not.toMatch(
        /attempt/i,
      ),
    ).toThrow(/inside the generated ulid/);
  });

  it('leaves every other use of toContain and toMatch as Jest has it', () => {
    expect(LUCKY).not.toContain('482139.5');
    expect(LUCKY).toContain('13.000');
    expect(LUCKY).toMatch(/T01:39/);
    expect(['12.5']).toContain('12.5');
    expect(['01JABCDEFGHJKMNPQRSTVWXYZ0']).not.toContain('12.5');
    expect('no generated value here').not.toMatch(/12\.5|attempt/i);
    // Jest still fails a real occurrence, with its own message.
    expect(() => expect('price 482139.5').not.toContain('482139.5')).toThrow(/toContain/);
  });
});
