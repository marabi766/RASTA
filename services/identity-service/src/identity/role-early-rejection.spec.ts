import type { z } from 'zod';
import { resolveZodPath, unwrapZodSchema, zodDef } from '@rasta/contracts';
import { RastaError, zodPipe } from '@rasta/nest-common';
import {
  PLATFORM_ROLES,
  approveRegistrationSchema,
  createMembershipSchema,
  createUserSchema,
  submitRegistrationSchema,
  updateMembershipRolesSchema,
} from './dto';

/**
 * Early rejection on every role list a request carries (GHSA-mrhx-c7xc-m3w5):
 * the list is capped at the platform's role count, and a list over the cap is
 * refused before a single role is parsed — a spy on the role schema's own parse
 * proves it, through the shared pipe.
 */
const LISTS: [string, z.ZodType, string][] = [
  ['createUserSchema', createUserSchema, 'roles'],
  ['createMembershipSchema', createMembershipSchema, 'roles'],
  ['updateMembershipRolesSchema', updateMembershipRolesSchema, 'roles'],
  ['submitRegistrationSchema', submitRegistrationSchema, 'requestedRoles'],
  ['approveRegistrationSchema', approveRegistrationSchema, 'roles'],
];

afterEach(() => jest.restoreAllMocks());

describe.each(LISTS)('%s', (_name, schema, field) => {
  it(`refuses ${field} of 100,000 invalid roles with one issue, parsing none`, () => {
    const [list] = resolveZodPath(schema, [field]).nodes.flatMap(unwrapZodSchema);
    const role = zodDef(list as z.ZodType).element as z.ZodType;
    const parses = jest.spyOn((role as unknown as { _zod: { run: () => unknown } })._zod, 'run');

    let details: unknown;
    try {
      zodPipe(schema).transform(
        { [field]: Array.from({ length: 100_000 }, () => 42) },
        {
          type: 'body',
        },
      );
    } catch (error) {
      if (!(error instanceof RastaError)) throw error;
      details = error.details;
    }

    expect(details).toContainEqual({
      path: field,
      code: 'too_big',
      message: `Array must contain at most ${PLATFORM_ROLES.length} element(s)`,
    });
    expect(details).not.toContainEqual(expect.objectContaining({ path: `${field}[0]` }));
    expect(parses).not.toHaveBeenCalled();
  });
});
