import { z } from 'zod';
import { runUnscoped } from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import { VARIABLE_FORMATS, type EmailTemplate } from './email-render';

/**
 * Reads one published template version back out of the database.
 *
 * A function rather than a class, and injected rather than reached for: the
 * worker needs exactly this one read, and a repository interface with one
 * method is a class pretending to be a function.
 *
 * ## Why the row is validated on the way out
 *
 * `required_variables` is a `jsonb` column. The database checks that it is an
 * array and nothing further, because a CHECK constraint cannot reasonably
 * describe a list of `{name, format}` objects. Everything that writes it today
 * is the seeder, so a malformed row means somebody wrote to the table by hand
 * — and the failure that produces is a template rendered with a format nobody
 * declared, which is a message sent to a person. Parsed here, where it becomes
 * a permanent delivery failure with a name instead.
 */

const storedVariable = z.object({
  name: z.string().min(1),
  format: z.enum(VARIABLE_FORMATS),
});

const storedVariables = z.array(storedVariable).min(1);

export type TemplateReader = (
  templateKey: string,
  version: number,
  locale: string,
) => Promise<EmailTemplate | null>;

export function templateReader(prisma: PrismaService): TemplateReader {
  return async (templateKey, version, locale) => {
    const row = await runUnscoped(
      'notification templates are platform configuration with no tenant column',
      () =>
        prisma.client.notificationTemplateVersion.findUnique({
          where: {
            templateKey_channel_version_locale: {
              templateKey,
              channel: 'EMAIL',
              version,
              locale,
            },
          },
          select: {
            subjectTemplate: true,
            bodyTemplate: true,
            requiredVariables: true,
          },
        }),
    );
    if (!row) return null;

    return {
      key: templateKey,
      version,
      locale,
      subject: row.subjectTemplate,
      body: row.bodyTemplate,
      variables: storedVariables.parse(row.requiredVariables),
    };
  };
}
