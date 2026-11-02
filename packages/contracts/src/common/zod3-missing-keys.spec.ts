import { z } from 'zod';
import * as contracts from '../index';

/**
 * zod 3 parsed a missing key as `undefined`, so a key whose schema takes
 * `undefined` (`z.unknown()`, `z.any()`, a union with `z.undefined()`) could be
 * left out. zod 4.6.7 refuses a missing key unless its schema is optional in
 * zod 4's sense — the envelope's `payload` was one (PR #444 r2). Every schema
 * this package exports is walked; a key that takes `undefined` must also be
 * optional, or a message zod 3 read is refused.
 */

interface Node {
  _zod: { def: Record<string, unknown> };
  safeParse(value: unknown): { success: boolean };
}

const isSchema = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { _zod?: { def?: { type?: unknown } } })._zod?.def?.type === 'string';

function missingKeysRefused(): string[] {
  const offenders: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: Node, where: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const def = node._zod.def;
    const children: [unknown, string][] = [];
    switch (def.type) {
      case 'object':
        for (const [key, property] of Object.entries(def.shape as Record<string, Node>)) {
          const missing = z.object({ key: property as unknown as z.ZodType }).safeParse({});
          if (property.safeParse(undefined).success && !missing.success) {
            offenders.push(`${where}.${key}`);
          }
          children.push([property, `${where}.${key}`]);
        }
        children.push([def.catchall, `${where}.*`]);
        break;
      case 'array':
        children.push([def.element, `${where}[]`]);
        break;
      case 'record':
        children.push([def.valueType, `${where}.*`]);
        break;
      case 'union':
        (def.options as unknown[]).forEach((option, at) =>
          children.push([option, `${where}|${at}`]),
        );
        break;
      case 'intersection':
        children.push([def.left, where], [def.right, where]);
        break;
      case 'tuple':
        (def.items as unknown[]).forEach((item, at) => children.push([item, `${where}[${at}]`]));
        break;
      case 'pipe':
        children.push([def.in, where], [def.out, where]);
        break;
      case 'lazy':
        break;
      default:
        children.push([def.innerType, where]);
    }
    for (const [child, path] of children) if (isSchema(child)) visit(child, path);
  };
  for (const [name, value] of Object.entries(contracts)) if (isSchema(value)) visit(value, name);
  return offenders;
}

describe('a key zod 3 let a message leave out is still optional (PR #444 r2)', () => {
  it('walks the exported schemas', () => {
    expect(Object.values(contracts).filter(isSchema).length).toBeGreaterThan(40);
  });

  it('no exported schema refuses a missing key whose schema takes undefined', () => {
    expect(missingKeysRefused()).toEqual([]);
  });

  it('an envelope without a payload is read, as zod 3 read it', () => {
    const { payload: _payload, ...bare } = {
      eventId: '01JB9V5Q6K8M2N4P7R3S5T7V9X',
      eventName: 'SOMETHING_HAPPENED',
      occurredAt: '2026-10-01T10:00:00.000Z',
      producer: 'asset-service',
      aggregateType: 'Asset',
      aggregateId: 'AST_1',
      correlationId: 'corr',
      payload: null,
    };
    const parsed = contracts.eventEnvelopeSchema.safeParse(bare);
    expect(parsed.success).toBe(true);
    expect(parsed.data && 'payload' in parsed.data).toBe(false);
  });
});
