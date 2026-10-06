import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { MediaType } from './medias.service.js';

export interface UploadTarget {
  provider: 'CLOUDFLARE_STREAM' | 'CLOUDFLARE_R2';
  providerId: string;
  uploadUrl: string;
  uploadMethod: 'POST' | 'PUT';
  playbackUrl?: string;
}

export interface StreamCaption {
  language: string;
  label?: string;
  generated?: boolean;
  status?: 'ready' | 'inprogress' | 'error' | string;
}

export class StreamApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

@Injectable()
export class CloudflareStorageService {
  constructor(private readonly config: ConfigService) {}

  private createR2Client(): S3Client {
    const accountId = this.config.getOrThrow<string>('CLOUDFLARE_ACCOUNT_ID');
    const endpoint =
      this.config.get<string>('CLOUDFLARE_S3_API_ENDPOINT') ??
      `https://${accountId}.r2.cloudflarestorage.com`;

    return new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId:
          this.config.get<string>('CLOUDFLARE_R2_ACCESS_KEY_ID') ??
          this.config.getOrThrow<string>('CLOUDFLARE_ACCESS_KEY_ID'),
        secretAccessKey:
          this.config.get<string>('CLOUDFLARE_R2_SECRET_ACCESS_KEY') ??
          this.config.getOrThrow<string>('CLOUDFLARE_SECRET_ACCESS_KEY'),
      },
    });
  }

  async createAccessUrl(provider: string, providerId: string): Promise<string> {
    if (provider === 'CLOUDFLARE_STREAM') {
      const customerCode = this.config.get<string>('CLOUDFLARE_STREAM_CUSTOMER_CODE');
      return customerCode
        ? `https://customer-${customerCode}.cloudflarestream.com/${providerId}/iframe`
        : `https://iframe.videodelivery.net/${providerId}`;
    }

    const bucket = this.config.getOrThrow<string>('CLOUDFLARE_R2_BUCKET');
    return getSignedUrl(
      this.createR2Client(),
      new GetObjectCommand({ Bucket: bucket, Key: providerId }),
      { expiresIn: 3600 },
    );
  }

  async downloadObject(providerId: string): Promise<Uint8Array> {
    const bucket = this.config.getOrThrow<string>('CLOUDFLARE_R2_BUCKET');
    const result = await this.createR2Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: providerId }),
    );
    if (!result.Body) {
      throw new BadGatewayException(`R2 returned an empty body for ${providerId}`);
    }

    return result.Body.transformToByteArray();
  }

  async createUploadTarget(
    type: MediaType,
    filename: string,
    contentType: string,
  ): Promise<UploadTarget> {
    if (type === 'VIDEO') {
      return this.createStreamUpload();
    }

    const bucket = this.config.getOrThrow<string>('CLOUDFLARE_R2_BUCKET');
    const r2 = this.createR2Client();
    const key = `media/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
    const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 900 });

    return {
      provider: 'CLOUDFLARE_R2',
      providerId: key,
      uploadUrl,
      uploadMethod: 'PUT',
    };
  }

  async createCoverUpload(filename: string, contentType: string) {
    const bucket = this.config.getOrThrow<string>('CLOUDFLARE_R2_BUCKET');
    const key = `covers/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
    const uploadUrl = await getSignedUrl(
      this.createR2Client(),
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      { expiresIn: 900 },
    );

    return { key, uploadUrl, uploadMethod: 'PUT' as const };
  }

  /** Calls the Cloudflare Stream API for one video (path relative to the video). */
  private async streamApi<T>(uid: string, path = '', init: RequestInit = {}): Promise<T> {
    const accountId = this.config.get<string>('CLOUDFLARE_ACCOUNT_ID');
    const token = this.config.get<string>('CLOUDFLARE_STREAM_TOKEN');
    if (!accountId || !token) {
      throw new ServiceUnavailableException('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_TOKEN are required');
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}${path}`,
      { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(60_000) },
    );
    if (path.endsWith('/vtt')) {
      if (!response.ok) throw new BadGatewayException(`Stream captions download failed (${response.status})`);
      return (await response.text()) as T;
    }
    if (init.method === 'DELETE' && response.ok) {
      return undefined as T;
    }

    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: T;
    } | null;
    if (!response.ok || !payload?.success) {
      throw new StreamApiError(
        response.status,
        payload?.errors?.[0]?.message ?? `Cloudflare Stream request failed (${response.status})`,
      );
    }
    return payload.result as T;
  }

  async deleteObject(key: string): Promise<void> {
    const bucket = this.config.getOrThrow<string>('CLOUDFLARE_R2_BUCKET');
    await this.createR2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async deleteStreamVideo(uid: string): Promise<void> {
    await this.streamApi<unknown>(uid, '', { method: 'DELETE' }).catch((error: unknown) => {
      if (error instanceof StreamApiError && error.status === 404) return; // already gone
      throw error;
    });
  }

  getStreamVideo(uid: string) {
    return this.streamApi<{ readyToStream: boolean; status?: { state?: string; errorReasonText?: string } }>(uid);
  }

  listStreamCaptions(uid: string) {
    return this.streamApi<StreamCaption[]>(uid, '/captions');
  }

  /** Asks Stream to create AI-generated captions (speech-to-text) for a language. */
  generateStreamCaptions(uid: string, language: string) {
    return this.streamApi<StreamCaption>(uid, `/captions/${encodeURIComponent(language)}/generate`, { method: 'POST' });
  }

  getStreamCaptionsVtt(uid: string, language: string) {
    return this.streamApi<string>(uid, `/captions/${encodeURIComponent(language)}/vtt`);
  }

  private async createStreamUpload(): Promise<UploadTarget> {
    const accountId = this.config.get<string>('CLOUDFLARE_ACCOUNT_ID');
    const token = this.config.get<string>('CLOUDFLARE_STREAM_TOKEN');
    const customerCode = this.config.get<string>('CLOUDFLARE_STREAM_CUSTOMER_CODE');

    if (!accountId || !token) {
      throw new ServiceUnavailableException(
        'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_TOKEN are required for MP4 uploads',
      );
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ maxDurationSeconds: 7200 }),
      },
    );

    const payload = (await response.json()) as {
      success: boolean;
      errors?: Array<{ message: string }>;
      result?: { uid: string; uploadURL: string };
    };

    if (!response.ok || !payload.success || !payload.result) {
      throw new BadGatewayException(
        payload.errors?.[0]?.message ?? 'Cloudflare rejected the Stream upload request',
      );
    }

    return {
      provider: 'CLOUDFLARE_STREAM',
      providerId: payload.result.uid,
      uploadUrl: payload.result.uploadURL,
      uploadMethod: 'POST',
      playbackUrl: customerCode
        ? `https://customer-${customerCode}.cloudflarestream.com/${payload.result.uid}/iframe`
        : `https://iframe.videodelivery.net/${payload.result.uid}`,
    };
  }
}