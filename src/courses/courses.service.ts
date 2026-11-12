import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { NEON_CONNECTION } from '../database/database.module.js';

type QuestionInput = { prompt: string; options: string[]; answerIndex: number };

@Injectable()
export class CoursesService implements OnModuleInit {
  constructor(
    @Inject(NEON_CONNECTION) private readonly sql: NeonQueryFunction<false, false>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.sql`CREATE TABLE IF NOT EXISTS courses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await this.sql`CREATE TABLE IF NOT EXISTS course_modules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL, position INT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await this.sql`CREATE TABLE IF NOT EXISTS course_lessons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), module_id UUID NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
      title TEXT NOT NULL, media_id UUID REFERENCES media(id) ON DELETE SET NULL, position INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await this.sql`CREATE TABLE IF NOT EXISTS quiz_questions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lesson_id UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL, options JSONB NOT NULL, answer_index INT NOT NULL, position INT NOT NULL
    )`;
    await this.sql`CREATE TABLE IF NOT EXISTS course_resources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), module_id UUID NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
      name TEXT NOT NULL, url TEXT, position INT NOT NULL DEFAULT 0
    )`;
  }

  async findAll() {
    const courses = await this.sql`SELECT c.id, c.title, c.description, c.status, c.created_at, c.updated_at,
      (SELECT m.provider FROM course_lessons l
        JOIN course_modules cm ON cm.id = l.module_id
        JOIN media m ON m.id = l.media_id
        WHERE cm.course_id = c.id ORDER BY cm.position, l.position LIMIT 1) AS thumbnail_provider,
      (SELECT m.provider_id FROM course_lessons l
        JOIN course_modules cm ON cm.id = l.module_id
        JOIN media m ON m.id = l.media_id
        WHERE cm.course_id = c.id ORDER BY cm.position, l.position LIMIT 1) AS thumbnail_provider_id
      ,(SELECT m.provider FROM course_lessons l
        JOIN course_modules cm ON cm.id = l.module_id
        JOIN media m ON m.id = l.media_id
        WHERE cm.course_id = c.id ORDER BY cm.position, l.position LIMIT 1) AS preview_provider
      ,(SELECT m.provider_id FROM course_lessons l
        JOIN course_modules cm ON cm.id = l.module_id
        JOIN media m ON m.id = l.media_id
        WHERE cm.course_id = c.id ORDER BY cm.position, l.position LIMIT 1) AS preview_provider_id
      FROM courses c ORDER BY c.created_at DESC`;
    const customerCode = this.config.get<string>('CLOUDFLARE_STREAM_CUSTOMER_CODE');
    return courses.map((course) => ({
      ...course,
      thumbnail_url: course.thumbnail_provider === 'CLOUDFLARE_STREAM' && course.thumbnail_provider_id
        ? customerCode
          ? `https://customer-${customerCode}.cloudflarestream.com/${course.thumbnail_provider_id}/thumbnails/thumbnail.jpg`
          : `https://videodelivery.net/${course.thumbnail_provider_id}/thumbnails/thumbnail.jpg`
        : null,
      preview_url: course.preview_provider === 'CLOUDFLARE_STREAM' && course.preview_provider_id
        ? customerCode
          ? `https://customer-${customerCode}.cloudflarestream.com/${course.preview_provider_id}/iframe`
          : `https://iframe.videodelivery.net/${course.preview_provider_id}`
        : null,
    }));
  }

  async findOne(id: string) {
    const [course] = await this.sql`SELECT id, title, description, status, created_at, updated_at FROM courses WHERE id = ${id}`;
    if (!course) throw new NotFoundException('Course not found');
    const modules = await this.sql`SELECT id, title, position FROM course_modules WHERE course_id = ${id} ORDER BY position`;
    const lessons = await this.sql`SELECT l.id, l.module_id, l.title, l.media_id, l.position, m.type, m.provider, m.provider_id, m.status
      FROM course_lessons l LEFT JOIN media m ON m.id = l.media_id
      WHERE l.module_id IN (SELECT id FROM course_modules WHERE course_id = ${id}) ORDER BY l.position`;
    const questions = await this.sql`SELECT q.id, q.lesson_id, q.prompt, q.options, q.answer_index, q.position
      FROM quiz_questions q WHERE q.lesson_id IN (SELECT l.id FROM course_lessons l JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = ${id}) ORDER BY q.position`;
    const resources = await this.sql`SELECT r.id, r.module_id, r.name, r.url, r.position FROM course_resources r
      WHERE r.module_id IN (SELECT id FROM course_modules WHERE course_id = ${id}) ORDER BY r.position`;
    const customerCode = this.config.get<string>('CLOUDFLARE_STREAM_CUSTOMER_CODE');
    return {
      ...course,
      modules: modules.map((item) => ({
        ...item,
        lessons: lessons
          .filter((lesson) => lesson.module_id === item.id)
          .map((lesson) => ({
            ...lesson,
            playback_url: lesson.provider === 'CLOUDFLARE_STREAM'
              ? customerCode
                ? `https://customer-${customerCode}.cloudflarestream.com/${lesson.provider_id}/iframe`
                : `https://iframe.videodelivery.net/${lesson.provider_id}`
              : null,
            thumbnail_url: lesson.provider === 'CLOUDFLARE_STREAM' && lesson.provider_id
              ? customerCode
                ? `https://customer-${customerCode}.cloudflarestream.com/${lesson.provider_id}/thumbnails/thumbnail.jpg`
                : `https://videodelivery.net/${lesson.provider_id}/thumbnails/thumbnail.jpg`
              : null,
            questions: questions.filter((question) => question.lesson_id === lesson.id),
          })),
        resources: resources.filter((resource) => resource.module_id === item.id),
      })),
    };
  }

  async create(input: { title: string; description?: string }) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new BadRequestException('Course title is required');
    const [course] = await this.sql`INSERT INTO courses (title, description) VALUES (${title}, ${input.description?.trim() ?? ''}) RETURNING *`;
    return course;
  }

  async update(id: string, input: { title?: string; description?: string; status?: string }) {
    const [course] = await this.sql`UPDATE courses SET title = COALESCE(${input.title?.trim() ?? null}, title), description = COALESCE(${input.description ?? null}, description), status = COALESCE(${input.status ?? null}, status), updated_at = NOW() WHERE id = ${id} RETURNING *`;
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  async remove(id: string) {
    const result = await this.sql`DELETE FROM courses WHERE id = ${id} RETURNING id`;
    if (!result.length) throw new NotFoundException('Course not found');
    return { deleted: true };
  }

  async addModule(courseId: string, input: { title: string; position?: number }) {
    const position = input.position ?? Number((await this.sql`SELECT COALESCE(MAX(position), -1) + 1 AS position FROM course_modules WHERE course_id = ${courseId}`)[0].position);
    const [module] = await this.sql`INSERT INTO course_modules (course_id, title, position) VALUES (${courseId}, ${input.title.trim()}, ${position}) RETURNING *`;
    return module;
  }

  async addLesson(moduleId: string, input: { title: string; mediaId?: string; position?: number }) {
    const position = input.position ?? Number((await this.sql`SELECT COALESCE(MAX(position), -1) + 1 AS position FROM course_lessons WHERE module_id = ${moduleId}`)[0].position);
    const [lesson] = await this.sql`INSERT INTO course_lessons (module_id, title, media_id, position) VALUES (${moduleId}, ${input.title.trim()}, ${input.mediaId ?? null}, ${position}) RETURNING *`;
    return lesson;
  }

  async addQuestions(lessonId: string, items: QuestionInput[]) {
    if (!Array.isArray(items) || items.length > 20) throw new BadRequestException('A lesson quiz can have at most 20 questions');
    await this.sql`DELETE FROM quiz_questions WHERE lesson_id = ${lessonId}`;
    for (const [position, item] of items.entries()) {
      if (!item.prompt?.trim() || !Array.isArray(item.options) || item.options.length < 2 || item.answerIndex < 0 || item.answerIndex >= item.options.length) throw new BadRequestException('Each question needs a prompt, options and a valid correct answer');
      await this.sql`INSERT INTO quiz_questions (lesson_id, prompt, options, answer_index, position) VALUES (${lessonId}, ${item.prompt.trim()}, ${JSON.stringify(item.options)}, ${item.answerIndex}, ${position})`;
    }
    return { saved: items.length };
  }

  async addResource(moduleId: string, input: { name: string; url?: string }) {
    const [resource] = await this.sql`INSERT INTO course_resources (module_id, name, url) VALUES (${moduleId}, ${input.name.trim()}, ${input.url ?? null}) RETURNING *`;
    return resource;
  }
}
