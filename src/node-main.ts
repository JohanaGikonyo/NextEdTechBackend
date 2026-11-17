import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '5mb' });
  app.enableCors({ origin: true });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3002);
}

await bootstrap();
