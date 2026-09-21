import { runUnscoped } from '@rasta/nest-common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { EmailTemplate } from './email-render';
import { contentHashOf, EMAIL_TEMPLATES } from './email-templates';

/**
 * Publishes the code catalogue into the template tables at boot (ADR-054
 * § 10.2).
 *
 * Idempotent by construction: a version that is already published is left
 * exactly as it is. Nothing here updates a version row, and the database would
 * refuse it anyway — `trg_template_version_immutable` raises on UPDATE — so
 * this is one guarantee written twice on purpose, once where it is convenient
 * to read and once where it cannot be bypassed.
 *
 * ## The failure this exists to cause
 *
 * If a published version's text has changed but its number has not, the seeder
 * **refuses to start the service**. That is a deliberately harsh response to a
 * small mistake, and the reason is what the mistake costs: a delivery row
 * cites `(templateKey, version)`, so two different texts under one number make
 * every past delivery unanswerable, silently and permanently. There is no
 * later moment at which this becomes detectable.
 *
 * Booting anyway and logging a warning was the alternative. It was rejected
 * because the damage is to the record rather than to the running system: the
 * service would keep working perfectly while the evidence it produces quietly
 * stopped being true.
 */
export class TemplateSeedConflictError extends Error {
  constructor(
    readonly templateKey: string,
    readonly version: number,
    readonly locale: string,
  ) {
    super(
      `Template ${templateKey} v${version} (${locale}) is already published with different text. ` +
        'A published version is immutable: raise the version instead of editing it.',
    );
    this.name = 'TemplateSeedConflictError';
  }
}

export interface SeedSummary {
  readonly published: number;
  readonly unchanged: number;
}

/**
 * Writes the catalogue, one template at a time.
 *
 * Unscoped with a written reason: these tables carry no organization column
 * because the text is the same for every tenant, and the seeder runs at boot
 * with no request context to scope against.
 */
export async function seedEmailTemplates(
  prisma: ExtendedPrismaClient,
  templates: readonly EmailTemplate[] = EMAIL_TEMPLATES,
): Promise<SeedSummary> {
  let published = 0;
  let unchanged = 0;

  for (const template of templates) {
    const hash = contentHashOf(template);

    await runUnscoped(
      'notification templates are platform configuration with no tenant column',
      async () => {
        await prisma.notificationTemplate.upsert({
          where: { templateKey_channel: { templateKey: template.key, channel: 'EMAIL' } },
          create: {
            templateKey: template.key,
            channel: 'EMAIL',
            name: template.key,
            description: 'Seeded from the code catalogue (ADR-054 § 10.2)',
          },
          // The parent row carries no text, so re-stating it is not an edit to
          // anything a person receives. It exists to give the version rows
          // something to hang from and to hold `is_active`.
          update: {},
        });

        const existing = await prisma.notificationTemplateVersion.findUnique({
          where: {
            templateKey_channel_version_locale: {
              templateKey: template.key,
              channel: 'EMAIL',
              version: template.version,
              locale: template.locale,
            },
          },
          select: { contentHash: true },
        });

        if (existing) {
          if (existing.contentHash !== hash) {
            throw new TemplateSeedConflictError(template.key, template.version, template.locale);
          }
          unchanged += 1;
          return;
        }

        await prisma.notificationTemplateVersion.create({
          data: {
            templateKey: template.key,
            channel: 'EMAIL',
            version: template.version,
            locale: template.locale,
            subjectTemplate: template.subject,
            bodyTemplate: template.body,
            requiredVariables: template.variables as unknown as object,
            contentHash: hash,
            createdBy: 'catalogue',
          },
        });
        published += 1;
      },
    );
  }

  return { published, unchanged };
}
