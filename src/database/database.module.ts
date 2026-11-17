import { Module, Global } from '@nestjs/common';
import { neon } from '@neondatabase/serverless';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const NEON_CONNECTION = 'NEON_CONNECTION';

export async function initializeDatabase(sql: NeonQueryFunction<false, false>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('VIDEO', 'H5P', 'SCORM')),
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'READY',
    original_filename TEXT,
    mime_type TEXT,
    size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE media ADD COLUMN IF NOT EXISTS cover_key TEXT`;
  await sql`ALTER TABLE media ADD COLUMN IF NOT EXISTS notes TEXT`;

  await sql`CREATE TABLE IF NOT EXISTS courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS course_modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS course_lessons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id UUID NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    media_id UUID REFERENCES media(id) ON DELETE SET NULL,
    position INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS quiz_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    options JSONB NOT NULL,
    answer_index INT NOT NULL,
    position INT NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS course_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id UUID NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT,
    position INT NOT NULL DEFAULT 0
  )`;
  await sql`CREATE TABLE IF NOT EXISTS media_transcripts (
    media_id UUID PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    source TEXT,
    language TEXT,
    segments JSONB NOT NULL DEFAULT '[]'::jsonb,
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE media_transcripts ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`;
}

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
