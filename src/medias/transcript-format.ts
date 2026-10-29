export interface TranscriptSegment {
  start: number; // seconds
  end: number;
  text: string;
}

const TIMING = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function seconds(h: string | undefined, m: string, s: string, ms: string): number {
  return (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms.padEnd(3, '0'), 10) / 1000;
}

function cleanCueText(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/<[^>]*>/g, '') // <v Speaker>, <i>, <00:00:01.000> karaoke tags
    .replace(/\{\\[^}]*\}/g, '') // SRT positioning like {\an8}
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parses WebVTT or SRT captions into timed segments. */
export function parseSubtitles(source: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = source.replace(/^﻿/, '').split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex < 0) continue; // WEBVTT header, NOTE, STYLE, REGION blocks

    const m = TIMING.exec(lines[timingIndex])!;
    const text = cleanCueText(lines.slice(timingIndex + 1));
    if (!text) continue;

    const segment = {
      start: seconds(m[1]?.slice(0, -1), m[2], m[3], m[4]),
      end: seconds(m[5]?.slice(0, -1), m[6], m[7], m[8]),
      text,
    };
    // Roll-up captions repeat the previous line; skip exact repeats.
    const previous = segments[segments.length - 1];
    if (previous && previous.text === segment.text) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    segments.push(segment);
  }

  return segments.sort((a, b) => a.start - b.start);
}

interface WhisperResult {
  text?: string;
  vtt?: string;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

/**
 * Converts one Whisper response (for an audio chunk starting at `offset`
 * seconds into the video) into transcript segments on the video's timeline.
 */
export function segmentsFromWhisper(result: WhisperResult, offset: number, chunkDuration: number): TranscriptSegment[] {
  const shift = (s: TranscriptSegment) => ({ ...s, start: s.start + offset, end: s.end + offset });

  if (result.segments?.length) {
    return result.segments
      .map((s) => ({ start: s.start ?? 0, end: s.end ?? s.start ?? 0, text: (s.text ?? '').trim() }))
      .filter((s) => s.text)
      .map(shift);
  }
  if (result.vtt && result.vtt.includes('-->')) {
    return parseSubtitles(result.vtt).map(shift);
  }
  if (result.words?.length) {
    // Group words into readable lines: break at sentence ends or every ~14 words.
    const out: TranscriptSegment[] = [];
    let current: TranscriptSegment | null = null;
    let count = 0;
    for (const w of result.words) {
      const word = (w.word ?? '').trim();
      if (!word) continue;
      if (!current) {
        current = { start: w.start ?? 0, end: w.end ?? w.start ?? 0, text: word };
        count = 1;
      } else {
        current.text += ` ${word}`;
        current.end = w.end ?? current.end;
        count++;
      }
      if (/[.!?]$/.test(word) || count >= 14) {
        out.push(current);
        current = null;
      }
    }
    if (current) out.push(current);
    return out.map(shift);
  }
  const text = result.text?.trim();
  return text ? [{ start: offset, end: offset + chunkDuration, text }] : [];
}

const MAX_EDITED_SEGMENTS = 20_000;
const MAX_SEGMENT_TEXT = 2_000;

/**
 * Validates a transcript sent back by the editor: every line keeps a valid
 * time range, whitespace is tidied, lines emptied by the teacher are dropped.
 * Throws with a readable message when the input can't be saved.
 */
export function cleanEditedSegments(input: unknown): TranscriptSegment[] {
  if (!Array.isArray(input)) throw new Error('Send the transcript as a list of lines');
  if (input.length > MAX_EDITED_SEGMENTS) throw new Error(`A transcript can have at most ${MAX_EDITED_SEGMENTS} lines`);

  const segments: TranscriptSegment[] = [];
  for (const item of input) {
    const { start, end, text } = (item ?? {}) as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error('Every line needs a valid start and end time');
    }
    if (typeof text !== 'string') throw new Error('Every line needs text');
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length > MAX_SEGMENT_TEXT) throw new Error(`A line can be at most ${MAX_SEGMENT_TEXT} characters`);
    if (clean) segments.push({ start, end, text: clean });
  }

  if (!segments.length) throw new Error('The transcript has no text left. Keep at least one line.');
  return segments.sort((a, b) => a.start - b.start);
}
