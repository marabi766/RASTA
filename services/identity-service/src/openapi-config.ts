import { DocumentBuilder, type OpenAPIObject } from '@nestjs/swagger';
import { INTERNAL_TOKEN_SCHEME } from './identity/identity.controller';

/**
 * The document `main.ts` serves at `/docs` (developer tooling only): the bearer for
 * people, and the signed internal token (`X-Internal-Token`, ADR-020) for the
 * service-to-service route that names it with `@ApiSecurity`.
 */
export function identityDocumentConfig(version: string): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('Rasta — Identity Service')
    .setDescription(
      'Source of truth for who you are and what role you hold in which organization. ' +
        'Keycloak owns authentication; this service owns membership.',
    )
    .setVersion(version)
    .addBearerAuth()
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-internal-token',
        description:
          'A signed internal service token minted for identity-service (ADR-020). ' +
          '`GET /v1/users/{id}/organizations` takes it, signed for no tenant, instead of ' +
          'the bearer.',
      },
      INTERNAL_TOKEN_SCHEME,
    )
    .build();
}
