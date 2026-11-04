import { RastaError } from '../errors/rasta-error';
import { MAX_QUERY_SEGMENTS, strictQueryParser } from './strict-query-parser';

describe('strictQueryParser (PR 699 review F1)', () => {
  it('refuses a value hidden behind 1000 empty segments instead of dropping it', () => {
    expect(() => strictQueryParser('&'.repeat(1000) + 'organizationId=ORG-A')).toThrow(RastaError);
  });

  it('refuses 800 empties plus 201 ids instead of keeping the first 200', () => {
    const raw =
      '&'.repeat(800) + Array.from({ length: 201 }, () => 'organizationId=ORG-A').join('&');
    expect(() => strictQueryParser(raw)).toThrow(RastaError);
  });

  it('answers the refusal as a 400 VALIDATION_FAILED', () => {
    try {
      strictQueryParser('&'.repeat(MAX_QUERY_SEGMENTS));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).status).toBe(400);
      expect((error as RastaError).code).toBe('VALIDATION_FAILED');
    }
  });

  it('parses every segment up to the bound, the last one included', () => {
    const raw = '&'.repeat(MAX_QUERY_SEGMENTS - 1) + 'organizationId=ORG-LAST';
    expect(strictQueryParser(raw)).toEqual({ organizationId: 'ORG-LAST' });
  });

  it('keeps repeated values as an array and an absent query empty', () => {
    expect({ ...strictQueryParser('a=1&a=2&b=') }).toEqual({ a: ['1', '2'], b: '' });
    expect(strictQueryParser('')).toEqual({});
    expect(strictQueryParser(undefined)).toEqual({});
  });
});
