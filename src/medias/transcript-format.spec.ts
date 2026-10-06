import { describe, expect, it } from 'vitest';
import { parseSubtitles, segmentsFromWhisper } from './transcript-format.js';

describe('parseSubtitles', () => {
  it('parses WebVTT with headers, cue ids, tags and hour-less timings', () => {
    const vtt = `WEBVTT

NOTE produced by H5P

intro
00:01.000 --> 00:04.500
<v Narrator>Welcome to the <i>React</i> workshop.

00:00:05.000 --> 00:00:08.250 align:start
Today we build
a todo app.`;

    expect(parseSubtitles(vtt)).toEqual([
      { start: 1, end: 4.5, text: 'Welcome to the React workshop.' },
      { start: 5, end: 8.25, text: 'Today we build a todo app.' },
    ]);
  });

  it('parses SRT and merges repeated roll-up lines', () => {
    const srt = `1\r\n00:00:01,000 --> 00:00:02,000\r\n{\\an8}Hello\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,500\r\nHello\r\n\r\n3\r\n01:00:00,000 --> 01:00:01,000\r\nOne hour in`;

    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 3.5, text: 'Hello' },
      { start: 3600, end: 3601, text: 'One hour in' },
    ]);
  });
});

describe('segmentsFromWhisper', () => {
  it('shifts Whisper segments by the chunk offset', () => {
    const result = { segments: [{ start: 1.5, end: 4, text: ' Hello there. ' }, { start: 4, end: 5, text: ' ' }] };
    expect(segmentsFromWhisper(result, 600, 600)).toEqual([{ start: 601.5, end: 604, text: 'Hello there.' }]);
  });

  it('groups word timings into sentences when only words are returned', () => {
    const words = ['Hi', 'all.', 'Next', 'part'].map((word, i) => ({ word, start: i, end: i + 0.5 }));
    expect(segmentsFromWhisper({ words }, 10, 600)).toEqual([
      { start: 10, end: 11.5, text: 'Hi all.' },
      { start: 12, end: 13.5, text: 'Next part' },
    ]);
  });
});
