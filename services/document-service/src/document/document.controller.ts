import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { DocumentService } from './document.service';
import {
  deleteDocumentSchema,
  finalizeDocumentSchema,
  listDocumentsQuerySchema,
  requestUploadUrlSchema,
  type DeleteDocumentDto,
  type FinalizeDocumentDto,
  type ListDocumentsQuery,
  type RequestUploadUrlDto,
} from './dto';

/**
 * The document HTTP surface (`docs/06`, ADR-014).
 *
 * ## There is no upload endpoint, and that is the design
 *
 * A reader looking for `POST /v1/documents/content` will not find one. ADR-014
 * forbids the file passing through this service, so the only way content
 * reaches storage is the signed URL issued by `POST /v1/documents/upload-url`
 * — the client uploads directly and then tells us about it. Adding a
 * multipart route here would quietly undo the whole decision, which is why the
 * storage port has no write method to call.
 *
 * ## There is no listing of other people's documents
 *
 * `GET /v1/documents` returns the caller's organization's documents only, and
 * there is no administrative browse-everything route. `docs/09` is explicit
 * that the oversight role gets aggregates, not documents; a general file
 * browser would be the fastest possible way to undo that.
 *
 * ## Roles
 *
 * `@Roles` is the coarse first filter — which *kind* of user may touch
 * documents at all. Which document a caller may touch is decided in
 * `access.ts` against the row, because neither the gateway nor the guard ever
 * sees it (S-03, BOLA).
 */
@ApiTags('documents')
@Controller({ path: 'documents', version: '1' })
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  /**
   * Step one of the direct-upload flow.
   *
   * Returns a credential, so it is deliberately the narrowest thing that can
   * be: bound to one object key, one content type and one short expiry.
   */
  @Post('upload-url')
  @HttpCode(HttpStatus.CREATED)
  @Roles(
    'SYSTEM_ADMIN',
    'UNION_ADMIN',
    'ORGANIZATION_ADMIN',
    'PROCUREMENT_USER',
    'SUPPLIER',
    'FLEET_MANAGER',
    'TECHNICIAN',
  )
  @ApiOperation({
    summary: 'Request a short-lived signed URL to upload one document',
    description:
      'The file is uploaded directly to object storage and never passes through this ' +
      'service (ADR-014). The object key is generated server-side from a ULID and is ' +
      'never derived from the supplied filename. The declared content type and size are ' +
      'checked against the policy for the document class before any URL is issued; the ' +
      'real content type is established from the bytes at finalization.',
  })
  async requestUploadUrl(@Body(zodPipe(requestUploadUrlSchema)) dto: RequestUploadUrlDto) {
    return this.documents.requestUploadUrl(dto);
  }

  /**
   * Step three: confirm the object and register the document.
   *
   * Takes the intent id rather than an object key. A client cannot name the
   * object it wants registered, which is what makes key substitution
   * impossible rather than merely refused.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(
    'SYSTEM_ADMIN',
    'UNION_ADMIN',
    'ORGANIZATION_ADMIN',
    'PROCUREMENT_USER',
    'SUPPLIER',
    'FLEET_MANAGER',
    'TECHNICIAN',
  )
  @ApiOperation({
    summary: 'Register a document against a redeemed upload intent',
    description:
      'Confirms the object exists, reads its size from storage metadata and its real ' +
      'content type from its first bytes, and refuses a mismatch with what was declared. ' +
      'Publishes DOCUMENT_UPLOADED, which means the object was confirmed and registered — ' +
      'not that it was scanned or approved. Repeating a successful call returns the same ' +
      'document rather than creating a second one.',
  })
  async finalize(@Body(zodPipe(finalizeDocumentSchema)) dto: FinalizeDocumentDto) {
    return this.documents.finalize(dto);
  }

  @Get()
  @Roles(
    'SYSTEM_ADMIN',
    'UNION_ADMIN',
    'ORGANIZATION_ADMIN',
    'PROCUREMENT_USER',
    'SUPPLIER',
    'FLEET_MANAGER',
    'TECHNICIAN',
  )
  @ApiOperation({ summary: "List the caller's organization's documents" })
  async list(@Query(zodPipe(listDocumentsQuerySchema)) query: ListDocumentsQuery) {
    return this.documents.list(query);
  }

  @Get(':id')
  @Roles(
    'SYSTEM_ADMIN',
    'UNION_ADMIN',
    'ORGANIZATION_ADMIN',
    'PROCUREMENT_USER',
    'SUPPLIER',
    'FLEET_MANAGER',
    'TECHNICIAN',
  )
  @ApiOperation({
    summary: 'Read document metadata',
    description:
      'Never returns the object key, the bucket or a URL. A document belonging to another ' +
      'organization is reported as not found, so its existence is not disclosed.',
  })
  async get(@Param('id') id: string) {
    return this.documents.get(id);
  }

  /**
   * Step five: a signed GET URL, if the document may be handed over.
   *
   * `POST` rather than `GET` because it *issues a credential* rather than
   * reading state: it must not be cached by an intermediary, prefetched by a
   * browser, or land in a proxy log as a repeatable safe request.
   */
  @Post(':id/download-url')
  @HttpCode(HttpStatus.OK)
  @Roles(
    'SYSTEM_ADMIN',
    'UNION_ADMIN',
    'ORGANIZATION_ADMIN',
    'PROCUREMENT_USER',
    'SUPPLIER',
    'FLEET_MANAGER',
    'TECHNICIAN',
  )
  @ApiOperation({
    summary: 'Issue a short-lived signed URL to download one document',
    description:
      'Refused for a document that is pending scan, infected, failed scanning or deleted. ' +
      'The URL is served as an attachment with the detected content type, so stored ' +
      'content is never rendered in the browser.',
  })
  async downloadUrl(@Param('id') id: string) {
    return this.documents.createDownloadUrl(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'Delete a document',
    description:
      'Records a tombstone with the actor, time and reason rather than erasing the row, ' +
      'then removes the object. Repeating the call returns the same tombstone.',
  })
  async remove(
    @Param('id') id: string,
    @Body(zodPipe(deleteDocumentSchema)) dto: DeleteDocumentDto,
  ) {
    return this.documents.remove(id, dto);
  }
}
