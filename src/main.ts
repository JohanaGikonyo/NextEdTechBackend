import { NestFactory } from '@nestjs/core';
import { neon } from '@neondatabase/serverless';
import { cors } from 'hono/cors';
import type { Context, Next } from 'hono';
import { AppModule } from './app.module.js';
import { initializeDatabase as initializeSchema } from './database/database.module.js';
import { HonoAdapter } from './hono-adapter.js';

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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured');
  const sql = neon(databaseUrl);
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
