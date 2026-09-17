import { renderInApp, RenderError, type InAppTemplate } from './render';

const template: InAppTemplate = {
  key: 'test.in-app',
  version: 1,
  title: 'دستگاه {{assetId}}',
  body: 'بیمه {{insurerName}} تا {{daysRemaining}} روز دیگر منقضی می‌شود.',
  requiredVariables: ['assetId', 'insurerName', 'daysRemaining'],
  actionPath: '/assets/{{assetId}}',
};

describe('strict in-app rendering (ADR-054 § 10)', () => {
  it('interpolates declared variables into title, body and path', () => {
    const rendered = renderInApp(template, {
      assetId: 'AST_1',
      insurerName: 'ایران',
      daysRemaining: 7,
    });

    expect(rendered.title).toBe('دستگاه AST_1');
    expect(rendered.body).toBe('بیمه ایران تا 7 روز دیگر منقضی می‌شود.');
    expect(rendered.actionPath).toBe('/assets/AST_1');
  });

  it('throws on a missing required variable rather than rendering a blank', () => {
    // "بیمه‌نامهٔ شما تا  روز دیگر" must never be produced.
    expect(() => renderInApp(template, { assetId: 'AST_1', insurerName: 'x' })).toThrow(
      RenderError,
    );
    try {
      renderInApp(template, { assetId: 'AST_1', insurerName: 'x' });
    } catch (error) {
      expect((error as RenderError).missing).toEqual(['daysRemaining']);
      expect((error as RenderError).templateKey).toBe('test.in-app');
    }
  });

  it('treats null and empty string as missing', () => {
    expect(() =>
      renderInApp(template, { assetId: 'AST_1', insurerName: '', daysRemaining: 1 }),
    ).toThrow(/insurerName/);
    expect(() =>
      renderInApp(template, { assetId: 'AST_1', insurerName: null, daysRemaining: 1 }),
    ).toThrow(/insurerName/);
  });

  it('throws for a placeholder the template forgot to declare', () => {
    const sloppy: InAppTemplate = {
      ...template,
      title: 'x',
      body: '{{undeclared}}',
      requiredVariables: [],
      actionPath: undefined,
    };
    expect(() => renderInApp(sloppy, {})).toThrow(/undeclared/);
  });

  it('keeps digits Latin: presentation is the web app, not this service', () => {
    const rendered = renderInApp(template, {
      assetId: 'AST_1',
      insurerName: 'x',
      daysRemaining: 14,
    });
    expect(rendered.body).toContain('14');
    expect(rendered.body).not.toContain('۱۴');
  });

  it('neutralises markup and control characters in values', () => {
    const rendered = renderInApp(template, {
      assetId: 'AST_1',
      insurerName: '<script>alert(1)</script>\r\n',
      daysRemaining: 3,
    });
    expect(rendered.body).not.toContain('<');
    expect(rendered.body).not.toContain('>');
    expect(rendered.body).not.toContain('\r');
    expect(rendered.body).toContain('scriptalert(1)/script');
  });

  it('URL-encodes path segments and refuses a non-relative result', () => {
    const rendered = renderInApp(template, {
      assetId: 'a b/../c',
      insurerName: 'x',
      daysRemaining: 3,
    });
    expect(rendered.actionPath).toBe('/assets/a%20b%2F..%2Fc');

    const absolute: InAppTemplate = { ...template, actionPath: 'https://evil.test/{{assetId}}' };
    expect(() =>
      renderInApp(absolute, { assetId: 'AST_1', insurerName: 'x', daysRemaining: 3 }),
    ).toThrow(/origin-relative/);

    const schemeRelative: InAppTemplate = { ...template, actionPath: '//evil.test/{{assetId}}' };
    expect(() =>
      renderInApp(schemeRelative, { assetId: 'AST_1', insurerName: 'x', daysRemaining: 3 }),
    ).toThrow(/origin-relative/);
  });

  it('renders no path when the template declares none', () => {
    const { actionPath: _ignored, ...withoutPath } = template;
    const rendered = renderInApp(withoutPath, {
      assetId: 'AST_1',
      insurerName: 'x',
      daysRemaining: 3,
    });
    expect(rendered.actionPath).toBeNull();
  });

  it('clamps title and body to the column widths', () => {
    const long: InAppTemplate = {
      ...template,
      title: 'x'.repeat(500),
      body: 'y'.repeat(5000),
      requiredVariables: [],
      actionPath: undefined,
    };
    const rendered = renderInApp(long, {});
    expect(rendered.title).toHaveLength(200);
    expect(rendered.body).toHaveLength(2000);
  });
});
