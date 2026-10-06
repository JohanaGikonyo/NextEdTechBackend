import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unzipSync } from 'fflate';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { CloudflareStorageService } from './cloudflare-storage.service.js';

interface PackageMedia {
  id: string;
  type: string;
  provider: string;
  provider_id: string;
}

export type PackageDescription =
  | { kind: 'H5P'; title: string | null; mainLibrary: string | null }
  | { kind: 'SCORM'; version: '1.2' | '2004'; launch: string }
  | { kind: 'HTML'; launch: string };

const READY_MARKER = '.extracted';

/**
 * Unzips H5P / SCORM packages stored in R2 into a local cache so their
 * individual files can be served to the browser players.
 */
@Injectable()
export class PackageContentService {
  private readonly cacheRoot: string;
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly embedCache = new Map<
    string,
    { value: { kind: 'H5P_COM'; video: string | null; image: string | null }; expires: number }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly storage: CloudflareStorageService,
  ) {
    this.cacheRoot = resolve(
      this.config.get<string>('PACKAGE_CACHE_DIR') ?? join(tmpdir(), 'nextedtech-packages'),
    );
  }

  /** How to launch the package, plus its main video (used for the thumbnail). */
  async describe(media: PackageMedia): Promise<PackageDescription & { video: string | null }> {
    const dir = await this.ensureExtracted(media);
    const launch = await this.describeLaunch(media, dir);
    return { ...launch, video: await findMainVideo(media.type, dir) };
  }

  private async describeLaunch(media: PackageMedia, dir: string): Promise<PackageDescription> {
    if (media.type === 'H5P') {
      const h5pJson = await readFile(join(dir, 'h5p.json'), 'utf8').catch(() => null);
      if (!h5pJson) {
        throw new BadRequestException('This file is not a valid .h5p package (h5p.json missing)');
      }
      const parsed = JSON.parse(h5pJson) as { title?: string; mainLibrary?: string };
      return { kind: 'H5P', title: parsed.title ?? null, mainLibrary: parsed.mainLibrary ?? null };
    }

    // Zips made by compressing the publish folder put everything one level down.
    const roots = ['', ...(await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${entry.name}/`)];

    for (const root of roots) {
      const manifest = await readFile(join(dir, root, 'imsmanifest.xml'), 'utf8').catch(() => null);
      if (manifest) {
        const { version, launch } = parseScormManifest(manifest);
        return { kind: 'SCORM', version, launch: `${root}${launch}` };
      }
    }

    // No manifest: a plain HTML5 publish. It plays, but cannot report progress.
    for (const root of roots) {
      for (const page of ['index.html', 'index_scorm.html', 'story.html']) {
        if (await stat(join(dir, root, page)).catch(() => null)) {
          return { kind: 'HTML', launch: `${root}${page}` };
        }
      }
    }

    throw new BadRequestException(
      'This ZIP has neither imsmanifest.xml nor index.html. ' +
        'Publish it from Captivate as SCORM 1.2/2004 or HTML5.',
    );
  }

  /**
   * H5P.com embeds: read the player settings (H5PIntegration) from the embed
   * page to find the activity's video, so the card can show a real thumbnail.
   */
  async describeEmbed(media: PackageMedia): Promise<{ kind: 'H5P_COM'; video: string | null; image: string | null }> {
    const cached = this.embedCache.get(media.id);
    if (cached && cached.expires > Date.now()) return cached.value;

    const { video, image } = await describeH5pComEmbed(media.provider_id).catch(() => EMPTY_EMBED);
    const result = { kind: 'H5P_COM' as const, video, image };
    this.embedCache.set(media.id, { value: result, expires: Date.now() + 60 * 60 * 1000 });
    return result;
  }

  /**
   * Where a lesson's speech can be read from: an existing captions file
   * (preferred: exact text) and the main video (for speech-to-text). Each is
   * a local file path or an https URL.
   */
  async speechSources(media: PackageMedia): Promise<{ captions: string | null; video: string | null }> {
    if (media.provider === 'H5P_COM') {
      const { captions, video } = await describeH5pComEmbed(media.provider_id);
      return { captions, video };
    }

    const dir = await this.ensureExtracted(media);
    const [captions, video] = await Promise.all([
      findCaptionsFile(media.type, dir),
      findMainVideo(media.type, dir),
    ]);
    return {
      captions: captions ? join(dir, captions) : null,
      video: video ? join(dir, video) : null,
    };
  }

  /** Forgets everything cached for a lesson (unpacked files, embed lookups). */
  async evict(mediaId: string): Promise<void> {
    this.embedCache.delete(mediaId);
    await this.inFlight.get(mediaId)?.catch(() => undefined);
    await rm(join(this.cacheRoot, mediaId), { recursive: true, force: true });
  }

  /** Returns the absolute path of a file inside the extracted package. */
  async resolveFile(media: PackageMedia, relativePath: string): Promise<string> {
    const dir = await this.ensureExtracted(media);
    const filePath = resolve(dir, relativePath);
    if (!filePath.startsWith(dir + sep)) {
      throw new BadRequestException('Invalid path');
    }

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw new NotFoundException(`${relativePath} is not in this package`);
    }
    return filePath;
  }

  private ensureExtracted(media: PackageMedia): Promise<string> {
    if (media.provider !== 'CLOUDFLARE_R2' || (media.type !== 'H5P' && media.type !== 'SCORM')) {
      throw new BadRequestException('Only H5P and SCORM packages stored in R2 can be played');
    }

    let pending = this.inFlight.get(media.id);
    if (!pending) {
      pending = this.extract(media).finally(() => this.inFlight.delete(media.id));
      this.inFlight.set(media.id, pending);
    }
    return pending;
  }

  private async extract(media: PackageMedia): Promise<string> {
    const dir = join(this.cacheRoot, media.id);
    if (await stat(join(dir, READY_MARKER)).catch(() => null)) {
      return dir;
    }

    await rm(dir, { recursive: true, force: true });
    const archive = await this.storage.downloadObject(media.provider_id);
    const entries = unzipSync(archive);

    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue;
      const target = resolve(dir, name);
      // Skip entries that try to escape the package folder ("zip slip").
      if (!target.startsWith(dir + sep)) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }

    await writeFile(join(dir, READY_MARKER), new Date().toISOString());
    return dir;
  }
}

const VIDEO_FILE = /\.(mp4|m4v|webm|mov)$/i;
const CAPTIONS_FILE = /\.(vtt|srt)$/i;
const isRemote = (value: string) => /^[a-z]+:\/\//i.test(value);

/**
 * H5P: the first local captions track referenced by content.json.
 * SCORM/HTML: the first .vtt/.srt file in the package.
 */
async function findCaptionsFile(type: string, dir: string): Promise<string | null> {
  if (type === 'H5P') {
    const content = await readFile(join(dir, 'content', 'content.json'), 'utf8').catch(() => null);
    const track = content
      ? jsonStrings(JSON.parse(content)).find((s) => CAPTIONS_FILE.test(s) && !isRemote(s))
      : undefined;
    return track ? `content/${track}` : null;
  }

  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const file = entries.find((entry) => entry.isFile() && CAPTIONS_FILE.test(entry.name));
  return file ? relative(dir, join(file.parentPath, file.name)).split(sep).join('/') : null;
}

interface EmbedMedia {
  video: string | null;
  image: string | null;
  captions: string | null;
}
const EMPTY_EMBED: EmbedMedia = { video: null, image: null, captions: null };

/** Collects every string value in a parsed JSON tree. */
function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => jsonStrings(v, out));
  return out;
}

/** Extracts the `{...}` object literal starting at `start`, respecting strings. */
function sliceJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export async function describeH5pComEmbed(
  embedUrl: string,
): Promise<EmbedMedia> {
  const url = new URL(embedUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.h5p.com')) {
    return EMPTY_EMBED;
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return EMPTY_EMBED;
  const html = await response.text();

  const marker = html.indexOf('H5PIntegration');
  const objectStart = marker >= 0 ? html.indexOf('{', marker) : -1;
  const json = objectStart >= 0 ? sliceJsonObject(html, objectStart) : null;
  if (!json) return EMPTY_EMBED;

  const integration = JSON.parse(json) as {
    url?: string;
    contents?: Record<string, { jsonContent?: string }>;
  };
  const [contentKey, content] = Object.entries(integration.contents ?? {})[0] ?? [];
  if (!contentKey || !content?.jsonContent || !integration.url) return EMPTY_EMBED;

  const strings = jsonStrings(JSON.parse(content.jsonContent));
  const contentBase = `${integration.url}/content/${contentKey.replace(/^cid-/, '')}/`;

  const captionsPath = strings.find((s) => CAPTIONS_FILE.test(s) && !isRemote(s));
  const captions = captionsPath ? new URL(captionsPath, contentBase).toString() : null;

  const local = strings.find((s) => VIDEO_FILE.test(s) && !isRemote(s));
  if (local) return { video: new URL(local, contentBase).toString(), image: null, captions };

  const external = strings.find((s) => /^https:\/\/[^?#\s]+\.(mp4|m4v|webm|mov)([?#]|$)/i.test(s));
  if (external) return { video: external, image: null, captions };

  // Interactive videos sourced from YouTube: use YouTube's own thumbnail.
  const youtubeId = strings
    .map((s) => /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/.exec(s)?.[1])
    .find(Boolean);
  return {
    video: null,
    image: youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : null,
    captions,
  };
}

/**
 * H5P: the first local video referenced by content.json (e.g. Interactive Video).
 * SCORM/HTML: the largest video file in the package.
 */
async function findMainVideo(type: string, dir: string): Promise<string | null> {
  if (type === 'H5P') {
    const content = await readFile(join(dir, 'content', 'content.json'), 'utf8').catch(() => null);
    if (!content) return null;
    const found: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (VIDEO_FILE.test(value) && !/^[a-z]+:\/\//i.test(value)) found.push(value);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    walk(JSON.parse(content));
    return found[0] ? `content/${found[0]}` : null;
  }

  let best: { path: string; size: number } | null = null;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_FILE.test(entry.name)) continue;
    const full = join(entry.parentPath, entry.name);
    const { size } = await stat(full);
    if (!best || size > best.size) best = { path: full, size };
  }
  return best ? relative(dir, best.path).split(sep).join('/') : null;
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[2] ?? match[3]) : null;
}

export function parseScormManifest(xml: string): { version: '1.2' | '2004'; launch: string } {
  const schemaVersion = /<(?:\w+:)?schemaversion>([^<]*)</i.exec(xml)?.[1] ?? '';
  const version =
    /2004|CAM\s*1\.3/i.test(schemaVersion) || /adlcp_v1p3|imscp_v1p1.*adlseq/i.test(xml)
      ? '2004'
      : '1.2';

  const resources = [...xml.matchAll(/<(?:\w+:)?resource\b[^>]*>/gi)].map((m) => m[0]);
  const items = [...xml.matchAll(/<(?:\w+:)?item\b[^>]*>/gi)].map((m) => m[0]);

  const defaultOrg = attr(/<(?:\w+:)?organizations\b[^>]*>/i.exec(xml)?.[0] ?? '', 'default');
  let orgItems = items;
  if (defaultOrg) {
    const orgStart = xml.search(
      new RegExp(`<(?:\\w+:)?organization\\b[^>]*identifier\\s*=\\s*["']${defaultOrg}["']`, 'i'),
    );
    if (orgStart >= 0) {
      orgItems = [...xml.slice(orgStart).matchAll(/<(?:\w+:)?item\b[^>]*>/gi)].map((m) => m[0]);
    }
  }

  const launchItem = orgItems.find((item) => attr(item, 'identifierref'));
  const resource =
    resources.find(
      (r) => launchItem && attr(r, 'identifier') === attr(launchItem, 'identifierref'),
    ) ??
    resources.find((r) => /sco/i.test(attr(r, 'adlcp:scormtype') ?? attr(r, 'adlcp:scormType') ?? '') && attr(r, 'href')) ??
    resources.find((r) => attr(r, 'href'));

  const href = resource ? attr(resource, 'href') : null;
  if (!href) {
    throw new BadRequestException('Could not find the launch page in imsmanifest.xml');
  }

  const base = (resource && attr(resource, 'xml:base')) ?? '';
  const parameters = launchItem ? (attr(launchItem, 'parameters') ?? '') : '';
  return { version, launch: `${base}${href}${parameters}` };
}
