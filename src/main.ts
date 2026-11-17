import { NestFactory } from '@nestjs/core';
import { cors } from 'hono/cors';
import type { Context, Next } from 'hono';
import { AppModule } from './app.module.js';
import { CoursesService } from './courses/courses.service.js';
import { HonoAdapter } from './hono-adapter.js';
import { MediasService } from './medias/medias.service.js';
import { TranscriptsService } from './medias/transcripts.service.js';

const allowedOrigins = new Set([
  'https://nextedtechfrontend.johanagikonyo552.workers.dev',
  'http://localhost:3000',
]);

const app = await NestFactory.create(AppModule, new HonoAdapter());
const honoApp = app.getHttpAdapter().getInstance();
let databaseReady: Promise<void> | undefined;
honoApp.use(
  '*',
  cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : ''),
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);
honoApp.use('*', async (_context: Context, next: Next) => {
  databaseReady ??= Promise.all([
    app.get(MediasService).initialize(),
    app.get(CoursesService).initialize(),
    app.get(TranscriptsService).initialize(),
  ]).then(() => undefined);
  await databaseReady;
  return next();
});
await app.init();

export default honoApp;
