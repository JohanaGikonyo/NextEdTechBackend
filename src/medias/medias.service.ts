import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { ConfigService } from '@nestjs/config';
import { NEON_CONNECTION } from '../database/database.module.js';

export type MediaType = 'VIDEO' | 'H5P' | 'SCORM';

export interface CreateMediaInput {
	title: string;
	type: MediaType;
	provider: string;
	providerId: string;
	originalFilename?: string;
	mimeType?: string;
	sizeBytes?: number;
	status?: string;
}

@Injectable()
export class MediasService implements OnModuleInit {
	constructor(
		@Inject(NEON_CONNECTION)
		private readonly sql: NeonQueryFunction<false, false>,
		private readonly config: ConfigService,
	) {}

	async onModuleInit(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS media (
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
			)
		`;
		await this.sql`ALTER TABLE media ADD COLUMN IF NOT EXISTS cover_key TEXT`;
		await this.sql`ALTER TABLE media ADD COLUMN IF NOT EXISTS notes TEXT`;
	}

	async checkConnection() {
		const [result] = await this.sql`
			SELECT NOW() AS database_time, COUNT(*)::int AS media_count
			FROM media
		`;

		return result;
	}

	async findAll() {
		const media = await this.sql`
			SELECT id, title, type, provider, provider_id, status,
						 original_filename, mime_type, size_bytes, cover_key, notes, created_at, updated_at
			FROM media
			ORDER BY created_at DESC
		`;
		return media.map((item) => this.withStreamUrls(item));
	}

	/** Adds the Cloudflare Stream player and thumbnail URLs for MP4 lessons. */
	private withStreamUrls<T extends Record<string, unknown>>(item: T) {
		if (item.provider !== 'CLOUDFLARE_STREAM') {
			return { ...item, playback_url: null, thumbnail_url: null };
		}
		const customerCode = this.config.get<string>('CLOUDFLARE_STREAM_CUSTOMER_CODE');
		const uid = String(item.provider_id);
		const base = customerCode
			? `https://customer-${customerCode}.cloudflarestream.com/${uid}`
			: `https://videodelivery.net/${uid}`;
		return {
			...item,
			playback_url: customerCode ? `${base}/iframe` : `https://iframe.videodelivery.net/${uid}`,
			thumbnail_url: `${base}/thumbnails/thumbnail.jpg?time=10%25&height=480`,
		};
	}

	async create(input: CreateMediaInput) {
		const [media] = await this.sql`
			INSERT INTO media (
				title, type, provider, provider_id,
				status, original_filename, mime_type, size_bytes
			)
			VALUES (
				${input.title}, ${input.type}, ${input.provider}, ${input.providerId},
				${input.status ?? 'READY'},
				${input.originalFilename ?? null}, ${input.mimeType ?? null},
				${input.sizeBytes ?? null}
			)
			RETURNING id, title, type, provider, provider_id, status,
								original_filename, mime_type, size_bytes, cover_key, notes, created_at, updated_at
		`;

		return media;
	}

	async updateStatus(id: string, status: string) {
		const [media] = await this.sql`
			UPDATE media
			SET status = ${status}, updated_at = NOW()
			WHERE id = ${id}
			RETURNING id, title, type, provider, provider_id, status,
			          original_filename, mime_type, size_bytes, cover_key, notes, created_at, updated_at
		`;

		return media;
	}

	async setCover(id: string, coverKey: string) {
		const [media] = await this.sql`
			UPDATE media
			SET cover_key = ${coverKey}, updated_at = NOW()
			WHERE id = ${id}
			RETURNING id, title, type, provider, provider_id, status,
			          original_filename, mime_type, size_bytes, cover_key, notes, created_at, updated_at
		`;

		return media;
	}

	/** Partial update: only the fields given change. `removeCover` clears the cover. */
	async update(id: string, changes: { title?: string; providerId?: string; removeCover?: boolean }) {
		const [media] = await this.sql`
			UPDATE media
			SET title = COALESCE(${changes.title ?? null}, title),
			    provider_id = COALESCE(${changes.providerId ?? null}, provider_id),
			    cover_key = CASE WHEN ${changes.removeCover === true} THEN NULL ELSE cover_key END,
			    updated_at = NOW()
			WHERE id = ${id}
			RETURNING id, title, type, provider, provider_id, status,
			          original_filename, mime_type, size_bytes, cover_key, notes, created_at, updated_at
		`;

		return media ? this.withStreamUrls(media) : media;
	}

	async remove(id: string) {
		const [media] = await this.sql`
			DELETE FROM media WHERE id = ${id}
			RETURNING id, type, provider, provider_id, cover_key
		`;

		return media as { id: string; type: string; provider: string; provider_id: string; cover_key: string | null } | undefined;
	}

	async setNotes(id: string, notes: string | null) {
		const [media] = await this.sql`
			UPDATE media
			SET notes = ${notes}, updated_at = NOW()
			WHERE id = ${id}
			RETURNING id, title, type, provider, provider_id, status,
			          original_filename, mime_type, size_bytes, cover_key, notes, created_at, updated_at
		`;

		return media;
	}

	async findById(id: string) {
		const [media] = await this.sql`
			SELECT id, title, type, provider, provider_id, status,
			       original_filename, mime_type, size_bytes, cover_key, notes, created_at, updated_at
			FROM media
			WHERE id = ${id}
		`;

		return media ? this.withStreamUrls(media) : media;
	}
}
