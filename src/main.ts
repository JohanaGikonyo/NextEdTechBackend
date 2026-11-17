import { NestFactory } from '@nestjs/core';
import { cors } from 'hono/cors';
import type { Context, Next } from 'hono';
import { AppModule } from './app.module.js';
import { initializeDatabase as initializeSchema, NEON_CONNECTION } from './database/database.module.js';
import { HonoAdapter } from './hono-adapter.js';
import type { NeonQueryFunction } from '@neondatabase/serverless';

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
const ensureDatabase = async (_context: Context, next: Next) => {
  databaseReady ??= (async () => {
  const sql = app.get<NeonQueryFunction<false, false>>(NEON_CONNECTION, { strict: false });
  await initializeSchema(sql);
  })();
  try {
  await databaseReady;
  return next();
  } catch (error) {
  console.error('Database initialization failed:', error);
  return _context.json({ error: 'Database initialization failed' }, 503);
  }
};
honoApp.use('/courses', ensureDatabase);
honoApp.use('/courses/*', ensureDatabase);
honoApp.use('/medias', ensureDatabase);
honoApp.use('/medias/*', ensureDatabase);
await app.init();

export default honoApp;
