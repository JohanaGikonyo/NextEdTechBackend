import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { CloudflareStorageService } from './cloudflare-storage.service.js';
import { MediasController } from './medias.controller.js';
import { MediasService } from './medias.service.js';
import { PackageContentService } from './package-content.service.js';
import { TranscriptsService } from './transcripts.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [MediasController],
  providers: [MediasService, CloudflareStorageService, PackageContentService, TranscriptsService],
})
export class MediasModule {}