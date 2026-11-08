import { recordCalls } from './call-record';

const target = {
  ask: (_what: string): string => 'real',
  other: (_what: string): void => undefined,
};

describe('recordCalls', () => {
  it('pins the Jest behaviour the helper exists for: a restored spy has an empty history', () => {
    const spy = jest.spyOn(target, 'ask');
    target.ask('secret');
    expect(spy.mock.calls).toHaveLength(1);
    spy.mockRestore();
    expect(spy.mock.calls).toHaveLength(0);
  });

  it('positive control: a call made while recording is read back after restore', () => {
    const record = recordCalls([jest.spyOn(target, 'ask'), jest.spyOn(target, 'other')]);
    target.ask('secret');
    target.other('leak');
    expect(record.calls()).toEqual([['secret'], ['leak']]);
    record.restore();
    expect(record.calls()).toEqual([['secret'], ['leak']]);
  });

  it('negative control: a spy that was never called reads empty, before and after restore', () => {
    const record = recordCalls([jest.spyOn(target, 'ask')]);
    expect(record.calls()).toEqual([]);
    record.restore();
    expect(record.calls()).toEqual([]);
  });

  it('un-patches the target, and restoring twice neither throws nor loses the snapshot', () => {
    const record = recordCalls([jest.spyOn(target, 'ask').mockReturnValue('stubbed')]);
    expect(target.ask('x')).toBe('stubbed');
    record.restore();
    expect(target.ask('y')).toBe('real');
    record.restore();
    expect(record.calls()).toEqual([['x']]);
  });

  it('is not changed by what the code does after restore (the snapshot is a copy)', () => {
    const spy = jest.spyOn(target, 'ask');
    const record = recordCalls([spy]);
    target.ask('before');
    record.restore();
    target.ask('after');
    expect(record.calls()).toEqual([['before']]);
  });

  it('restores every spy even when one restore throws, then reports it', () => {
    const second = jest.spyOn(target, 'other');
    const broken = {
      mock: { calls: [['seen']] },
      mockRestore: () => {
        throw new Error('restore failed');
      },
    };
    const record = recordCalls([broken, second]);
    target.other('x');
    expect(() => record.restore()).toThrow('restore failed');
    expect(jest.isMockFunction(target.other)).toBe(false);
    expect(record.calls()).toEqual([['seen'], ['x']]);
  });
});
