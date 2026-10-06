import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NEON_CONNECTION } from '../database/database.module.js';
import { CloudflareStorageService, StreamApiError, type StreamCaption } from './cloudflare-storage.service.js';
import { PackageContentService } from './package-content.service.js';
import { parseSubtitles, segmentsFromWhisper, type TranscriptSegment } from './transcript-format.js';

type TranscriptStatus = 'PROCESSING' | 'READY' | 'FAILED' | 'UNAVAILABLE';

export interface Transcript {
  status: TranscriptStatus;
  source: 'CAPTIONS' | 'SPEECH_TO_TEXT' | null;
  language: string | null;
  segments: TranscriptSegment[];
  error: string | null;
}

interface TranscribableMedia {
  id: string;
  type: string;
  provider: string;
  provider_id: string;
}

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const CHUNK_SECONDS = 600; // 10-minute audio pieces, transcribed in parallel
const PARALLEL_CHUNKS = 3;

class UnavailableError extends Error {}

/**
 * Builds a timed transcript for each lesson, once: from the package's own
 * captions file when it has one (exact text), otherwise by running the video's
 * audio through Whisper on Cloudflare Workers AI. Results are stored in the DB.
 */
@Injectable()
export class TranscriptsService implements OnModuleInit {
  private readonly logger = new Logger(TranscriptsService.name);
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    @Inject(NEON_CONNECTION)
    private readonly sql: NeonQueryFunction<false, false>,
    private readonly config: ConfigService,
    private readonly packages: PackageContentService,
    private readonly storage: CloudflareStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS media_transcripts (
        media_id UUID PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        source TEXT,
        language TEXT,
        segments JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  }

  static supports(media: TranscribableMedia): boolean {
    return (
      (media.provider === 'CLOUDFLARE_R2' && (media.type === 'H5P' || media.type === 'SCORM')) ||
      (media.provider === 'H5P_COM' && media.type === 'H5P') ||
      (media.provider === 'CLOUDFLARE_STREAM' && media.type === 'VIDEO')
    );
  }

  /** Returns the stored transcript, starting generation if there is none yet. */
  async get(media: TranscribableMedia): Promise<Transcript> {
    if (!TranscriptsService.supports(media)) {
      return empty('UNAVAILABLE', 'Transcripts are not available for this kind of lesson.');
    }

    const [row] = await this.sql`
      SELECT status, source, language, segments, error FROM media_transcripts WHERE media_id = ${media.id}
    `;
    // No row yet, or a job that was interrupted by a server restart.
    if (!row || (row.status === 'PROCESSING' && !this.inFlight.has(media.id))) {
      this.start(media);
      return empty('PROCESSING');
    }
    return row as Transcript;
  }

  /** Kicks off (or restarts) transcript generation in the background. */
  start(media: TranscribableMedia, force = false): void {
    if (!TranscriptsService.supports(media)) return;
    if (this.inFlight.has(media.id) && !force) return;

    const job = this.generate(media)
      .catch((error: unknown) => this.logger.error(`Transcript failed for ${media.id}`, error as Error))
      .finally(() => this.inFlight.delete(media.id));
    this.inFlight.set(media.id, job);
  }

  private async generate(media: TranscribableMedia): Promise<void> {
    await this.save(media.id, { ...empty('PROCESSING') });

    try {
      if (media.provider === 'CLOUDFLARE_STREAM') {
        await this.save(media.id, await this.fromStreamCaptions(media.provider_id));
        return;
      }

      const { captions, video } = await this.packages.speechSources(media);

      if (captions) {
        const segments = parseSubtitles(await readText(captions));
        if (segments.length) {
          await this.save(media.id, { status: 'READY', source: 'CAPTIONS', language: null, segments, error: null });
          return;
        }
      }

      if (!video) throw new UnavailableError('This lesson has no video or captions to transcribe.');
      const { segments, language } = await this.transcribeVideo(video);
      if (!segments.length) throw new UnavailableError('No speech was detected in this video.');
      await this.save(media.id, { status: 'READY', source: 'SPEECH_TO_TEXT', language, segments, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof UnavailableError ? 'UNAVAILABLE' : 'FAILED';
      await this.save(media.id, { ...empty(status, message) });
      if (status === 'FAILED') throw error;
    }
  }

  /**
   * MP4 lessons on Cloudflare Stream: use the video's captions, asking Stream
   * to generate them (AI speech-to-text) if it has none, then wait until ready.
   */
  private async fromStreamCaptions(uid: string): Promise<Transcript> {
    const language = this.config.get<string>('STREAM_CAPTIONS_LANGUAGE') ?? 'en';
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    let requested = false;

    try {
      for (;;) {
        const video = await this.storage.getStreamVideo(uid);
        if (video.status?.state === 'error') {
          throw new UnavailableError(`Cloudflare Stream couldn't process this video: ${video.status.errorReasonText || 'unknown error'}`);
        }

        if (video.readyToStream) {
          const captions = await this.storage.listStreamCaptions(uid);
          // Uploaded caption files have no status; generated ones report it.
          const isReady = (c: StreamCaption) => !c.status || c.status === 'ready';
          const ready = captions.find((c) => c.language === language && isReady(c)) ?? captions.find(isReady);

          if (ready) {
            const segments = parseSubtitles(await this.storage.getStreamCaptionsVtt(uid, ready.language));
            if (!segments.length) throw new UnavailableError('No speech was detected in this video.');
            return {
              status: 'READY',
              source: ready.generated ? 'SPEECH_TO_TEXT' : 'CAPTIONS',
              language: ready.language,
              segments,
              error: null,
            };
          }

          const mine = captions.find((c) => c.language === language);
          if (mine?.status === 'error') {
            throw new Error('Cloudflare Stream could not generate captions for this video.');
          }
          if (!mine && !requested) {
            await this.storage.generateStreamCaptions(uid, language);
            requested = true;
          }
        }

        if (Date.now() > deadline) throw new Error('Timed out waiting for Cloudflare Stream captions.');
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    } catch (error) {
      if (error instanceof StreamApiError && (error.status === 401 || error.status === 403)) {
        throw new FatalError(
          'Cloudflare rejected the Stream token for captions. Give CLOUDFLARE_STREAM_TOKEN the "Stream: Edit" permission.',
        );
      }
      throw error;
    }
  }

  private async transcribeVideo(video: string): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
    const accountId = this.config.get<string>('CLOUDFLARE_ACCOUNT_ID');
    const token =
      this.config.get<string>('CLOUDFLARE_AI_TOKEN') ??
      this.config.get<string>('CLOUDFLARE_API_TOKEN') ??
      this.config.get<string>('CLOUDFLARE_STREAM_TOKEN');
    if (!accountId || !token) {
      throw new Error('Speech-to-text is not configured: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN.');
    }

    const workDir = await mkdtemp(join(tmpdir(), 'nextedtech-audio-'));
    try {
      const chunks = await extractAudioChunks(video, workDir);
      const results: TranscriptSegment[][] = Array.from({ length: chunks.length }, () => []);
      let language: string | null = null;

      // Transcribe a few chunks at a time; each keeps its offset on the video timeline.
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const index = next++;
          const chunk = chunks[index];
          const audio = (await readFile(chunk.file)).toString('base64');
          const result = await withRetry(() => this.whisper(accountId, token, audio));
          language ??= result.transcription_info?.language ?? null;
          results[index] = segmentsFromWhisper(result, chunk.start, chunk.end - chunk.start);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL_CHUNKS, chunks.length) }, worker));

      return { segments: results.flat(), language };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async whisper(accountId: string, token: string, audio: string) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${WHISPER_MODEL}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio, task: 'transcribe' }),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: Parameters<typeof segmentsFromWhisper>[0] & { transcription_info?: { language?: string } };
    } | null;

    if (response.status === 401 || response.status === 403) {
      throw new FatalError(
        'Cloudflare rejected the API token for Workers AI. Create a token with the "Workers AI" permission ' +
          'and set it as CLOUDFLARE_AI_TOKEN in backend/.env.',
      );
    }
    if (!response.ok || !body?.success || !body.result) {
      throw new Error(`Workers AI error (${response.status}): ${body?.errors?.[0]?.message ?? 'no result'}`);
    }
    return body.result;
  }

  private async save(mediaId: string, t: Transcript): Promise<void> {
    await this.sql`
      INSERT INTO media_transcripts (media_id, status, source, language, segments, error, updated_at)
      VALUES (${mediaId}, ${t.status}, ${t.source}, ${t.language}, ${JSON.stringify(t.segments)}::jsonb, ${t.error}, NOW())
      ON CONFLICT (media_id) DO UPDATE SET
        status = EXCLUDED.status, source = EXCLUDED.source, language = EXCLUDED.language,
        segments = EXCLUDED.segments, error = EXCLUDED.error, updated_at = NOW()
    `;
  }
}

class FatalError extends Error {}

function empty(status: TranscriptStatus, error: string | null = null): Transcript {
  return { status, source: null, language: null, segments: [], error };
}

async function readText(location: string): Promise<string> {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Could not download captions (${response.status})`);
    return response.text();
  }
  return readFile(location, 'utf8');
}

async function withRetry<T>(task: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (error instanceof FatalError || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

/**
 * Extracts the audio as small mono 16 kHz MP3 pieces of ~10 minutes each.
 * Works for local files and https URLs. Returns each piece's real start/end
 * on the video timeline (from ffmpeg's segment list).
 */
async function extractAudioChunks(input: string, workDir: string): Promise<Array<{ file: string; start: number; end: number }>> {
  if (!ffmpegPath) throw new Error('ffmpeg binary is not available on this platform');
  const listFile = join(workDir, 'segments.csv');

  const stderr = await new Promise<string>((resolve, reject) => {
    const ff = spawn(ffmpegPath as unknown as string, [
      '-v', 'error', '-y',
      '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1',
      '-segment_list', listFile, '-segment_list_type', 'csv',
      join(workDir, 'chunk%03d.mp3'),
    ]);
    let output = '';
    ff.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve(output);
      else if (/does not contain any stream|matches no streams|Output file is empty/i.test(output)) {
        reject(new UnavailableError('This video has no audio track to transcribe.'));
      } else reject(new Error(`Audio extraction failed: ${output.trim().split('\n').pop() ?? code}`));
    });
  });
  if (stderr.trim()) Logger.warn(stderr.trim().slice(0, 500), 'ffmpeg');

  const list = await readFile(listFile, 'utf8').catch(() => '');
  return list
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, start, end] = line.split(',');
      return { file: join(workDir, name), start: parseFloat(start), end: parseFloat(end) };
    });
}
