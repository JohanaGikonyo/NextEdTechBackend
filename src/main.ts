import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Edited transcripts of long lessons are larger than Express's 100 KB default.
  app.useBodyParser('json', { limit: '5mb' });
  app.enableCors({ origin: true });
  // Lets Render stop the service cleanly (closes connections on SIGTERM).
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3002);
}
await bootstrap();
