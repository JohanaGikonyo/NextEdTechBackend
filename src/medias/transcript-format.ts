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
