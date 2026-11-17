import { NestFactory } from '@nestjs/core';
import { cors } from 'hono/cors';
import { AppModule } from './app.module.js';
import { HonoAdapter } from './hono-adapter.js';

const allowedOrigins = new Set([
  'https://nextedtechfrontend.johanagikonyo552.workers.dev',
  'http://localhost:3000',
]);

const app = await NestFactory.create(AppModule, new HonoAdapter());
const honoApp = app.getHttpAdapter().getInstance();
honoApp.use(
  '*',
  cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : ''),
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);
await app.init();

export default honoApp;
