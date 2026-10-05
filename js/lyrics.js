/*
 * ALDAcon Karaoke — lyric/timing model.
 *
 * Combines a timing CSV (word_start,word_end,line_end — one row per word)
 * with a plain-text lyric file (one lyric line per text line, blank lines
 * between verses) into words, lines and verse breaks.
 */
(function (root) {
  'use strict';

  function parseCsv(text) {
    const rows = text.trim().split(/\r?\n/);
    const header = rows.shift().split(',').map((h) => h.trim().toLowerCase());
    const iStart = header.indexOf('word_start');
    const iEnd = header.indexOf('word_end');
    const iLine = header.indexOf('line_end');
    if (iStart < 0 || iEnd < 0) throw new Error('Timing file needs word_start and word_end columns');
    return rows
      .filter((r) => r.trim())
      .map((r) => {
        const c = r.split(',');
        const lineEnd = iLine >= 0 ? parseFloat(c[iLine]) : NaN;
        return { start: parseFloat(c[iStart]), end: parseFloat(c[iEnd]), lineEnd: !isNaN(lineEnd) };
      });
  }

  // The source lyrics are lower-case without punctuation; make them read
  // naturally on the big screen.
  const PRONOUN_I = /^i('(m|ve|ll|d|s))?$/i;
  function prettify(word, firstInLine) {
    if (PRONOUN_I.test(word)) return 'I' + word.slice(1);
    if (firstInLine) return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
  }

  function build(csvText, lyricsText) {
    const timing = parseCsv(csvText);
    const textLines = [];
    let pendingBreak = false;
    for (const raw of lyricsText.split(/\r?\n/)) {
      const tokens = raw.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) {
        pendingBreak = textLines.length > 0;
        continue;
      }
      textLines.push({ tokens, verseStart: pendingBreak });
      pendingBreak = false;
    }
    const nTokens = textLines.reduce((s, l) => s + l.tokens.length, 0);
    if (nTokens !== timing.length) {
      throw new Error(`Lyrics have ${nTokens} words but the timing file has ${timing.length} rows`);
    }
    const words = [];
    const lines = [];
    for (const tl of textLines) {
      const line = { index: lines.length, words: [], verseStart: tl.verseStart };
      tl.tokens.forEach((tok, k) => {
        const t = timing[words.length];
        line.words.push(words.length);
        words.push({ index: words.length, line: line.index, text: prettify(tok, k === 0), start: t.start, end: Math.max(t.end, t.start + 0.05) });
      });
      line.start = words[line.words[0]].start;
      line.end = words[line.words[line.words.length - 1]].end;
      lines.push(line);
    }
    return { words, lines, duration: words.length ? words[words.length - 1].end : 0 };
  }

  const api = { parseCsv, build, prettify };
  root.KaraokeLyrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
