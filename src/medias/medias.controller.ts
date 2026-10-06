import { BadRequestException, Body, Controller, Delete, Get, Logger, NotFoundException, Param, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CloudflareStorageService } from './cloudflare-storage.service.js';
import { MediasService } from './medias.service.js';
import type { CreateMediaInput, MediaType } from './medias.service.js';
import { PackageContentService } from './package-content.service.js';
import { TranscriptsService } from './transcripts.service.js';

const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_NOTES_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 200;

/** Accepts an H5P.com activity URL and returns its /embed URL. */
function normalizeH5pComEmbedUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException('Enter a valid H5P.com link');
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.h5p.com')) {
    throw new BadRequestException('Use an https://….h5p.com activity link');
  }
  const path = url.pathname.replace(/\/$/, '');
  return path.endsWith('/embed') ? `${url.origin}${path}` : `${url.origin}${path}/embed`;
}

interface UploadRequest {
  title: string;
  type: MediaType;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

@Controller('medias')
export class MediasController {
  private readonly logger = new Logger(MediasController.name);

  constructor(
    private readonly mediasService: MediasService,
    private readonly storageService: CloudflareStorageService,
    private readonly packageContent: PackageContentService,
    private readonly transcripts: TranscriptsService,
  ) {}

  @Post('upload-url')
  async createUploadUrl(@Body() input: UploadRequest) {
    try {
      const target = await this.storageService.createUploadTarget(
        input.type,
        input.filename,
        input.contentType,
      );
      const media = await this.mediasService.create({
        title: input.title,
        type: input.type,
        provider: target.provider,
        providerId: target.providerId,
        originalFilename: input.filename,
        mimeType: input.contentType,
        sizeBytes: input.sizeBytes,
        status: input.type === 'VIDEO' ? 'PROCESSING' : 'READY',
      });

      return { media, ...target };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Upload URL failed: type=${input.type}, filename=${input.filename}, message=${message}`,
        stack,
      );
      throw error;
    }
  }

  @Post(':id/complete')
  async completeUpload(@Param('id') id: string) {
    const media = await this.mediasService.updateStatus(id, 'READY');
    // Prepare the transcript in the background so it's ready when learners open the lesson.
    if (media) this.transcripts.start(media as { id: string; type: string; provider: string; provider_id: string });
    return media;
  }

  @Get(':id/transcript')
  async transcript(@Param('id') id: string) {
    return this.transcripts.get(await this.findMediaOrThrow(id));
  }

  @Post(':id/transcript/regenerate')
  async regenerateTranscript(@Param('id') id: string) {
    const media = await this.findMediaOrThrow(id);
    this.transcripts.start(media, true);
    return { status: 'PROCESSING' };
  }

  @Get('health')
  checkConnection() {
    return this.mediasService.checkConnection();
  }

  @Get()
  findAll() {
    return this.mediasService.findAll();
  }

  @Get(':id/access')
  async access(@Param('id') id: string) {
    const media = await this.mediasService.findById(id);
    if (!media) {
      return { message: 'Media not found' };
    }

    return {
      url: await this.storageService.createAccessUrl(media.provider, media.provider_id),
    };
  }

  @Post(':id/cover-upload-url')
  async createCoverUploadUrl(
    @Param('id') id: string,
    @Body() input: { filename: string; contentType: string; sizeBytes: number },
  ) {
    await this.findMediaOrThrow(id);
    if (!COVER_TYPES.has(input.contentType)) {
      throw new BadRequestException('Cover must be a JPG, PNG, WebP or GIF image');
    }
    if (input.sizeBytes > MAX_COVER_BYTES) {
      throw new BadRequestException('Cover image must be 5 MB or smaller');
    }
    return this.storageService.createCoverUpload(input.filename, input.contentType);
  }

  @Post(':id/cover')
  async setCover(@Param('id') id: string, @Body() input: { key: string }) {
    const previous = await this.mediasService.findById(id);
    if (!previous) throw new NotFoundException('Media not found');
    if (!input.key?.startsWith('covers/')) {
      throw new BadRequestException('Invalid cover key');
    }
    const media = await this.mediasService.setCover(id, input.key);
    if (previous.cover_key && previous.cover_key !== input.key) {
      void this.cleanUp(`old cover of ${id}`, () => this.storageService.deleteObject(previous.cover_key));
    }
    return media;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() input: { title?: string; embedUrl?: string; removeCover?: boolean },
  ) {
    const current = await this.findMediaOrThrow(id);
    const changes: { title?: string; providerId?: string; removeCover?: boolean } = {};

    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title) throw new BadRequestException('Title cannot be empty');
      if (title.length > MAX_TITLE_LENGTH) {
        throw new BadRequestException(`Title must be ${MAX_TITLE_LENGTH} characters or fewer`);
      }
      changes.title = title;
    }

    if (input.embedUrl !== undefined) {
      if (current.provider !== 'H5P_COM') {
        throw new BadRequestException('Only H5P.com lessons have an embed link');
      }
      changes.providerId = normalizeH5pComEmbedUrl(String(input.embedUrl));
    }

    const coverKey = (current as { cover_key?: string | null }).cover_key;
    if (input.removeCover === true && coverKey) changes.removeCover = true;

    const media = await this.mediasService.update(id, changes);

    if (changes.removeCover && coverKey) {
      void this.cleanUp(`cover of ${id}`, () => this.storageService.deleteObject(coverKey));
    }
    if (changes.providerId && changes.providerId !== current.provider_id) {
      // New H5P.com activity: refresh its thumbnail lookup and transcript.
      await this.packageContent.evict(id);
      this.transcripts.start(media as unknown as typeof current, true);
    }
    return media;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const media = await this.mediasService.remove(id);
    if (!media) throw new NotFoundException('Media not found');

    // The lesson is gone from the library now; clean up its stored files in the background.
    void this.cleanUp(`cache of ${id}`, () => this.packageContent.evict(id));
    if (media.cover_key) {
      void this.cleanUp(`cover of ${id}`, () => this.storageService.deleteObject(media.cover_key!));
    }
    if (media.provider === 'CLOUDFLARE_R2') {
      void this.cleanUp(`package of ${id}`, () => this.storageService.deleteObject(media.provider_id));
    } else if (media.provider === 'CLOUDFLARE_STREAM') {
      void this.cleanUp(`Stream video of ${id}`, () => this.storageService.deleteStreamVideo(media.provider_id));
    }
    return { deleted: true, id };
  }

  private async cleanUp(what: string, task: () => Promise<unknown>) {
    try {
      await task();
    } catch (error) {
      this.logger.warn(`Could not delete ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  @Put(':id/notes')
  async setNotes(@Param('id') id: string, @Body() input: { notes?: string | null }) {
    await this.findMediaOrThrow(id);
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    if (notes.length > MAX_NOTES_LENGTH) {
      throw new BadRequestException(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer`);
    }
    return this.mediasService.setNotes(id, notes || null);
  }

  @Get(':id/cover')
  async cover(@Param('id') id: string, @Res() res: Response) {
    const media = await this.mediasService.findById(id);
    if (!media?.cover_key) {
      throw new NotFoundException('This lesson has no cover image');
    }
    const url = await this.storageService.createAccessUrl('CLOUDFLARE_R2', media.cover_key);
    res.redirect(302, url);
  }

  @Get(':id/package')
  async describePackage(@Param('id') id: string) {
    const media = await this.findMediaOrThrow(id);
    if (media.provider === 'H5P_COM') {
      return this.packageContent.describeEmbed(media);
    }
    return this.packageContent.describe(media);
  }

  @Get(':id/content/*path')
  async packageFile(
    @Param('id') id: string,
    @Param('path') path: string | string[],
    @Res() res: Response,
  ) {
    const relativePath = Array.isArray(path) ? path.join('/') : path;
    const filePath = await this.packageContent.resolveFile(
      await this.findMediaOrThrow(id),
      relativePath,
    );
    res.sendFile(filePath, { maxAge: '1h' });
  }

  private async findMediaOrThrow(id: string) {
    const media = await this.mediasService.findById(id);
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    return media as unknown as { id: string; type: string; provider: string; provider_id: string };
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.mediasService.findById(id);
  }

  @Post()
  async create(@Body() input: CreateMediaInput) {
    const media = await this.mediasService.create(input);
    if (media?.status === 'READY') {
      this.transcripts.start(media as { id: string; type: string; provider: string; provider_id: string });
    }
    return media;
  }
}