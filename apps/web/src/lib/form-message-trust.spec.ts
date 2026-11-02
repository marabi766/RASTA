/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { inspect } from 'node:util';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { z } from 'zod';
import { legacyParse, type LegacyIssue } from '@rasta/contracts';

import {
  IRR,
  MoneyInputError,
  moneyInputMessage,
  parseMoneyInput,
  type MoneyInputFailure,
} from './format';
import {
  firstIssuePerField,
  formIssueMessage,
  formMessage,
  GENERIC_FIELD_MESSAGE,
} from './form-issues';
import { legacyFormResolver } from './form-resolver';

/**
 * Codex PR-439 r1 F1: «not zod's default, and holds an Arabic letter» is not
 * provenance. A Persian sentence built from the input passed it, bidi controls
 * included (`MoneyInputError` quoted the typed amount). Trust is now explicit:
 * a schema author's message is shown only if the author declared it with
 * `formMessage`, whose argument is fixed text over the portal's own labels and
 * bounds — and money failures are closed codes with fixed sentences.
 */

const MARK = 'typed-input-marker';
const RLO = '‮';
const HOSTILE = `${MARK}${RLO}`;
// Directional and other invisible format controls, ZWNJ (Persian spelling) aside.
const INVISIBLE = /(?!‌)\p{Cf}|\p{Cc}/u;

const refusalOf = (schema: z.ZodTypeAny, value: unknown) => {
  const result = legacyParse(schema, value);
  if (result.success) throw new Error('expected a refusal');
  return result.refusal;
};
const issueOf = (schema: z.ZodTypeAny, value: unknown): LegacyIssue =>
  refusalOf(schema, value).issues[0]!;

describe('explicit trust: only a declared author sentence is shown as written', () => {
  // The shape MoneyInputError had: a Persian sentence around the typed text.
  const echoing = z.object({
    amount: z.string().superRefine((value, ctx) => {
      ctx.addIssue({ code: 'custom', message: `نمی‌توان «${value}» را به‌عنوان مبلغ خواند` });
    }),
  });

  it('shows a declared sentence, on a check and on an issue a refinement adds', () => {
    const declared = formMessage('شمارهٔ بیمه‌نامه را وارد کنید');
    expect(formIssueMessage(issueOf(z.string().min(1, declared), ''))).toBe(declared);
    const added = z
      .string()
      .superRefine((_v, ctx) => ctx.addIssue({ code: 'custom', message: declared }));
    expect(formIssueMessage(issueOf(added, 'x'))).toBe(declared);
  });

  it('does not show a Persian sentence nobody declared, however Persian it is', () => {
    const undeclared = 'این جمله را کسی اعلام نکرده است';
    expect(
      formIssueMessage(
        issueOf(
          z.string().refine(() => false, undeclared),
          'x',
        ),
      ),
    ).toBe(GENERIC_FIELD_MESSAGE);
    expect(formIssueMessage(issueOf(z.string().max(1, undeclared), 'xx'))).toBe(
      'حداکثر ۱ نویسه مجاز است',
    );
  });

  it('never shows a Persian-prefixed echo, bidi control included, at any of the three entry points', async () => {
    const input = { amount: HOSTILE };
    const viaMessage = formIssueMessage(issueOf(echoing, input));
    const viaFields = firstIssuePerField(refusalOf(echoing, input), ['amount']);
    const viaResolver = await legacyFormResolver(echoing)(input, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(viaMessage).toBe(GENERIC_FIELD_MESSAGE);
    expect(viaFields).toEqual({ amount: GENERIC_FIELD_MESSAGE });
    expect(viaResolver.errors).toEqual({
      amount: { type: 'custom', message: GENERIC_FIELD_MESSAGE, ref: undefined },
    });
    for (const shown of [viaMessage, JSON.stringify(viaFields), JSON.stringify(viaResolver)]) {
      expect(shown).not.toContain(MARK);
      expect(shown).not.toMatch(INVISIBLE);
    }
  });

  it('does not let a zod default through even if its very text was declared', () => {
    const issue = issueOf(z.enum(['A', 'B']), 'ناشناخته');
    // A collision is harmless: trust needs the author's provenance AND the declaration.
    formMessage(issue.message);
    expect(formIssueMessage(issue)).toBe('یکی از گزینه‌های موجود را انتخاب کنید');
  });

  it('refuses to declare an empty sentence or one with a control character; ZWNJ is spelling', () => {
    for (const bad of ['', `مبلغ${RLO}`, 'مبلغ⁦', 'مبلغ‎', 'مبلغ﻿', 'مبلغ\u0000']) {
      expect(() => formMessage(bad)).toThrow(/control characters/);
    }
    expect(formMessage('نمی‌توان')).toBe('نمی‌توان');
  });
});

describe('money failures are closed codes with fixed sentences (F1, addendum B)', () => {
  const FAILURES: ReadonlyArray<readonly [string, MoneyInputFailure]> = [
    ['   ', 'EMPTY'],
    [`۱۲${HOSTILE}`, 'NOT_NUMERIC'],
    [`${HOSTILE}`, 'NOT_NUMERIC'],
    ['.', 'NO_DIGITS'],
    ['1.5', 'TOO_MANY_DECIMALS'],
  ];

  it.each(FAILURES)(
    '%j: the exception holds the code and a fixed sentence, never the input',
    (typed, failure) => {
      let caught: unknown;
      try {
        parseMoneyInput(typed, IRR);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MoneyInputError);
      const error = caught as MoneyInputError;
      expect(error.failure).toBe(failure);
      expect(error.message).toBe(moneyInputMessage(failure, IRR));
      expect('input' in error).toBe(false);
      for (const carried of [
        error.message,
        error.stack ?? '',
        inspect(error),
        JSON.stringify(error),
      ]) {
        expect(carried).not.toContain(MARK);
        expect(carried).not.toContain(RLO);
      }
    },
  );

  it('declares every failure sentence, so a schema that forwards one shows it as written', () => {
    for (const failure of ['EMPTY', 'NOT_NUMERIC', 'NO_DIGITS', 'TOO_MANY_DECIMALS'] as const) {
      const sentence = moneyInputMessage(failure, IRR);
      expect(sentence).not.toMatch(INVISIBLE);
      const forwarded = z
        .string()
        .superRefine((_v, ctx) => ctx.addIssue({ code: 'custom', message: sentence }));
      expect(formIssueMessage(issueOf(forwarded, 'x'))).toBe(sentence);
    }
  });
});

describe('the per-field accumulator reads and writes own keys only (addendum C)', () => {
  // `__proto__` is not here: zod never validates a shape key of that name, so
  // no issue can carry it (the accumulator still writes by definition, not `=`).
  const NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

  it('keeps the error of a field named like an Object.prototype member', () => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const name of NAMES) {
      Object.defineProperty(shape, name, { value: z.string().min(2), enumerable: true });
    }
    const values: Record<string, unknown> = {};
    for (const name of NAMES) Object.defineProperty(values, name, { value: 'a', enumerable: true });
    const errors = firstIssuePerField(refusalOf(z.object(shape), values), NAMES);
    expect(Object.keys(errors).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      expect(Object.getOwnPropertyDescriptor(errors, name)?.value).toBe('حداقل ۲ نویسه لازم است');
    }
    expect(Object.getPrototypeOf(errors)).toBe(Object.prototype);
  });
});

describe('every declaration is fixed text over the portal’s own labels and bounds', () => {
  const SRC = join(__dirname, '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === 'test' ? [] : sources(path);
      return /\.tsx?$/.test(entry) && !/\.(spec|test)\.|\.d\.ts$/.test(entry) ? [path] : [];
    });

  // What a template may interpolate: a helper's parameters fixed when the
  // schema is built (`label`, `what`, `why`, `min`, `max`, the currency), or a
  // digit formatter over constants and bounds. Never a value being validated.
  const PARAMETERS = new Set(['label', 'what', 'why', 'min', 'max', 'currency.label']);
  const FORMATTER = /^(?:fa|digits|toPersianDigits)\((.*)\)$/s;
  const BOUND_NAMES = new Set(['String', 'min', 'max', 'field', 'currency', 'maxIntegerDigits']);
  const controlled = (expression: string): boolean => {
    if (PARAMETERS.has(expression)) return true;
    const inner = FORMATTER.exec(expression)?.[1];
    if (inner === undefined) return false;
    // Every free identifier (not a property after a dot) is a constant or a bound.
    return [...inner.matchAll(/(?<![.\w])[A-Za-z_$][\w$]*/g)].every(
      ([name]) => /^[A-Z][A-Z0-9_]*$/.test(name) || BOUND_NAMES.has(name),
    );
  };

  function offendersIn(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'formMessage'
      ) {
        const [argument, ...rest] = node.arguments;
        const fixed =
          argument !== undefined &&
          rest.length === 0 &&
          (ts.isStringLiteral(argument) ||
            ts.isNoSubstitutionTemplateLiteral(argument) ||
            (ts.isTemplateExpression(argument) &&
              argument.templateSpans.every((span) => controlled(span.expression.getText()))));
        if (!fixed) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          found.push(`${file}:${line + 1} ${node.getText().slice(0, 80)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('finds no declaration over anything else (a value, a cause, a variable)', () => {
    const offenders = sources(SRC).flatMap((path) => {
      const file = relative(SRC, path);
      return file === 'lib/form-issues.ts' ? [] : offendersIn(file, readFileSync(path, 'utf8'));
    });
    expect(offenders).toEqual([]);
  });

  it('catches the shapes it exists to catch', () => {
    for (const line of [
      'formMessage(cause.message)',
      'formMessage(`«${value}» مبلغ نیست`)',
      'formMessage(`${label}: ${raw}`)',
      'formMessage(`حداکثر ${fa(value.length)} نویسه`)',
      'formMessage(text)',
      "formMessage('a', extra)",
    ]) {
      expect(offendersIn('x.ts', line)).toHaveLength(1);
    }
    for (const line of [
      "formMessage('تاریخ معتبر نیست')",
      'formMessage(`${label} را وارد کنید`)',
      'formMessage(`حداکثر ${fa(MAX_NOTES)} نویسه`)',
      'formMessage(`حداکثر ${digits(LIMITS[field].max)} نویسه`)',
    ]) {
      expect(offendersIn('x.ts', line)).toEqual([]);
    }
  });
});
