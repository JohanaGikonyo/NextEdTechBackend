import { Module, Global } from '@nestjs/common';
import { neon } from '@neondatabase/serverless';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const NEON_CONNECTION = 'NEON_CONNECTION';

@Global()
@Module({
    imports: [ConfigModule],
    providers: [
    {
      provide: NEON_CONNECTION,
      useFactory: (configService: ConfigService) => {
        return neon(configService.getOrThrow<string>('DATABASE_URL'));
      },
      inject: [ConfigService],
    },
  ],
  exports: [NEON_CONNECTION],
})
export class DatabaseModule {

}
