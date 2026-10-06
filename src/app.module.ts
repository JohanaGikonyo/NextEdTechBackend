import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { ConfigModule } from '@nestjs/config';
import { MediasModule } from './medias/medias.module.js';


export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Makes ConfigService available everywhere
      envFilePath: ['.env', 'backend/.env'],
    }),
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      runtimeMetrics: !Boolean(process.versions?.['webcontainer']),
      serviceId: 'nest-typescript-starter',
    }),
    DatabaseModule,
    MediasModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
