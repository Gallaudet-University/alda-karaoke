# CLAUDE.md — ALDAcon 2026 Karaoke

Notes for future sessions: what this project is, why it is built the way it is,
and which approaches were already tried and rejected. Read the "Dead ends"
section before changing the audio analysis.

## Project in one paragraph

A big-screen karaoke player for the ALDAcon 2026 karaoke party (Association of
Late-Deafened Adults; audience is late-deafened, deaf, hard of hearing and
hearing; motto "Whatever works!"). Requirements are in `specs.txt`: huge
white-on-black lyrics readable from dozens of feet away, a bouncing dot synced
to the words, the dot pulses with the beat (beat extracted from the audio), and
the dot color follows pitch (red = low → violet = high). Must be plain
HTML/CSS/JS with no installation. Must play the three songs in `songs/`.
User-facing docs are in `README.md`.

## Architecture

| File | Role |
|---|---|
| `index.html` | Page shell: menu, player, title/end/loading cards, controls, help |
| `css/karaoke.css` | All styles; sizes in vh so it scales on a projector |
| `js/app.js` | Library/loading, analysis cache, lyric stage, dot physics, controls |
| `js/audio.js` | Web Audio playback + latency-compensated song clock |
| `js/dsp.js` | Beat tracking + vocal pitch, zero dependencies, browser **and** Node (`module.exports`) |
| `js/dsp-worker.js` | Runs `dsp.js` in a Worker (http only) |
| `js/lyrics.js` | Builds words/lines/verses from CSV timings + lyrics text |
| `songs/songs.js` | Song list as a classic script (`window.KARAOKE_SONGS`) |
| `songs/*.pitch.json` | Optional offline vocal pitch tracks (see below) |
| `tools/make_pitch_file.py` | Demucs + pYIN generator for pitch files (organizer-only, optional) |
| `start.command` | macOS launcher: `python3 -m http.server 8765` + opens Chrome |

All scripts are **classic scripts, not ES modules**: modules (and Workers, and
`fetch`) fail on `file://` in Chrome, and the player must also work when
`index.html` is opened straight from disk.

## Data facts

- The CSVs (`word_start,word_end,line_end`) contain **no words**. They are from the
  JamendoLyrics dataset (github.com/f90/jamendolyrics); the lyrics `.txt` files were
  fetched from its `lyrics/` folder. Word count of `.txt` == CSV rows, and text line
  breaks == rows where `line_end` is not `nan` (verified for all three songs).
- Dataset lyrics are lowercase, no punctuation. `lyrics.js` capitalizes line starts
  and "I/I'm/I've/I'll/I'd" for display only.
- Licenses (from JamendoLyrics.csv): Cortéz "Feel (Stripped)" CC BY, Lower Loveday
  "Is It Right?" CC BY-SA, Rxbyn "Bad Side" CC BY. Credits are shown on title/end cards.
- All three singers are low-voiced: reference vocal ranges (5–95%) are roughly
  MIDI 42–54, 54–62 and 43–50. A low pitch estimate is NOT automatically a bug.

## Design decisions (and why)

**Display**
- Font: Atkinson Hyperlegible Next (Braille Institute, low-vision legibility),
  vendored in `fonts/` so it works offline. Weight 700 for lyrics.
- Only the current line (white) + next line (55% opacity) + one more (28%) are shown.
  Font starts at 10.5% of viewport height × user scale and shrinks until the tallest
  consecutive line pair fits in 80% of the height (one size per song, so text never
  changes size mid-song). `text-wrap: balance` prevents orphan words on wrapped lines.
- Lines scroll as a teleprompter: the dot lives *inside* the scrolling `#lyrics`
  container, so word positions and dot positions share one coordinate system and the
  scroll animation never desyncs the dot.
- Sung words: gold by default (best contrast on black); modes gold/cyan/rainbow/white
  (key C). The active word is wiped with `background-clip: text`.

**Dot motion** (`dotPosition` in app.js)
- Built from a list of "landings": every word onset, plus beat times during the intro
  and any gap > 1.6 s (bounce in place over the *next* word). This keeps the beat
  visible during instrumentals, which matters for deaf singers.
- Between landings: dwell/slide along the current word, then a parabolic hop that
  lands exactly at the next onset. Hop length ≤ 0.85 s; apex height scales with hop
  duration. Landing accuracy was checked: < 1 px at all 536 landings of "Bad Side".
- Beat pulse: scale `1 + 0.5·strength·exp(-Δt/0.13)` plus an expanding ring.
- Count-in dots (up to 4, one disappears per beat) before lines that follow ≥ 3 s of silence.
- Intro/outro feedback (user request: a long intro looked "stalled"). The title and end
  cards each have a gold music dot (`renderMusicMeter`) that bounces on the beat, with
  height scaled by the audio's loudness, and rests when paused or silent. Its label
  counts down to the first sung word ("singing starts in N s") or shows "♪ Music still
  playing" / "Song finished". The lyric dot keeps bouncing on the last word until the
  end card. Gold (not pitch color) marks "music only, nobody singing".
- On lower rows of a wrapped line, the bounce height is capped at 0.3 × font size
  (`wordRow`), otherwise the dot covers the row above.
- Line switch time: shortly after the previous line's last word (never before the
  middle of that word, never after the next line starts).

**Timing / audio**
- Playback via `AudioBufferSourceNode`; song time from `getOutputTimestamp()`
  extrapolated with `performance.now()` so it reflects what is audible (output latency
  included). Never steps backwards by small jitter. Manual offset with [ ] keys
  (25 ms steps) for Bluetooth/PA delay — not yet calibrated with real speakers.
- iOS mutes Web Audio while the phone is in silent mode, even though the dot and lyrics
  keep running. Fixed by `navigator.audioSession.type = 'playback'` before creating the
  AudioContext (Safari 16.4+; commit ca51f89, confirmed by the user on iOS 26 in Safari
  and Chrome). All iOS browsers use WebKit, so Safari and Chrome behave the same.
  iOS ≤ 15 (iPhone 6s/7/SE1) would still be muted; workaround (silent looping
  `<audio>` element) deliberately not built.
- Analysis decodes with `OfflineAudioContext(…, 22050)` so `decodeAudioData`
  resamples to 22.05 kHz; channels are averaged to mono.

**Loading**
- http(s): fetch files, analyze all songs in the background in a Worker at startup.
- `file://`: fetch/Workers fail → menu shows "Choose the songs folder…"
  (`<input webkitdirectory>`), analysis runs on the main thread (~3 s for all songs
  with pitch files). The same picker ("Add songs from a folder…") can add new songs at
  the event; files are paired by base name (`X.mp3` + `X.csv` + `X.txt` [+ `X.pitch.json`]).
- Analysis results are cached in localStorage under
  `aldak:analysis:v<ANALYSIS_VERSION>:<id>:<byteLength>:<file|live>`.
  **Bump `ANALYSIS_VERSION` in app.js whenever dsp.js output changes**, or stale
  results will be used.

## Audio analysis: what works

**Beat** (`onsetStrength` → `estimateTempo` → `refineTempo` → `trackBeats`):
librosa-style log-mel spectral-flux onset envelope (n_fft 2048, hop 512 @ 22.05 kHz,
128 mels), windowed autocorrelation tempo with log-normal prior at 120 BPM, then a
**fine comb-filter tempo search** (±4 %, 0.05 BPM steps, best phase), then Ellis DP
beat tracker (tightness 100) with weak-beat trimming.

| Song | Final | librosa | Comb peak | Onset strength at beats (ours / librosa) |
|---|---|---|---|---|
| Feel | 100.0 | 99.4 | 100.0 | 3.03 / 2.98 |
| Is It Right? | 135.0 | 136.0 | 135.0 | 3.22 / 3.20 |
| Bad Side | 146.7 | 143.6 | 146.7 | 2.26 / 2.25 |

**Loudness + beat-grid extension:** `loudnessEnvelope` (RMS every 1024 samples at
22.05 kHz, mapped to 0..1 over the 40 dB below the song's 95th percentile) and
`extendBeatGrid` (continue the beat grid at the song tempo before the first and after
the last tracked beat while loudness ≥ 0.2). The DP tracker trims weak beats in
fade-outs. Measured: the music stops 4–7 s after the last word, followed by up to ~5 s
of silence, so the outro dot must follow loudness rather than bounce until the file ends.

**Pitch** (`vocalPitch`): Melodia-style harmonic summation over spectral peaks,
only on frames inside sung words (the timings give voicing for free). Final
settings: window 2048 / FFT 8192 / hop 256 @ 22.05 kHz, 20 harmonics, α = 0.8,
**β = 0.5** (compressed magnitudes), **soft first-order high-pass at 120 Hz**,
salience on 20-cent bins A1–A6, Viterbi over semitone states E2–C6 with
jump cost 0.25, sub-bin refinement, 5-frame median. Word pitch = median of frames,
then octave-folded toward neighbors. Color range = 8th–92nd percentile of word
pitches per song.

Accuracy against reference (Demucs vocals + pYIN), final settings:
frames within 1 semitone 0.63 / 0.74 / 0.63; words within 2 semitones
0.70 / 0.80 / 0.70; word correlation 0.52 / 0.38 / 0.46; octave errors ≈ 1–4 %.

## Dead ends — do not retry without a new idea

| Tried | Result | Why it failed |
|---|---|---|
| librosa's integer-lag tempo as-is | 99.4 / 143.6 BPM, beat F-measure vs. own tracker down to 0.64 | Lags are ~4 BPM apart near 100 BPM; drift over a song. Fixed by parabolic lag + comb refinement. |
| Parabolic lag interpolation alone | Better on "Feel", worse on "Bad Side" (145.7 vs true 146.7) | Hann-windowed autocorrelation peak is biased; comb search is what nails it. |
| **A-weighting** before salience | Frames within 1 semitone fell from 0.55 / 0.52 / 0.55 to 0.52 / 0.44 / 0.27 (mono), and to 0.15–0.40 combined with the center mask; octave errors up to 28 % | These singers' fundamentals are ~90–185 Hz; A-weighting deletes them, so the octave above wins. Use only the gentle 120 Hz high-pass. |
| **Stereo center-channel mask** (L+iR single FFT, mask = (\|L+R\|−\|L−R\|)/(\|L+R\|+\|L−R\|)) | No gain or worse (with β = 0.5: 0.59 / 0.58 / 0.44 vs mono 0.62 / 0.71 / 0.60), slower | Bass/kick/keys are centered too in these mixes. Code removed. |
| **REPET-SIM** accompaniment removal (librosa nn_filter + soft mask) before pitch | Much worse (frames 0.35–0.39, octave errors 14–31 %) | Removes the singer's repeated sustained low notes too. |
| More harmonics (20 vs 12) | Tiny gain | Kept 20 anyway; not a lever. |
| β = 0.33 | Worse than 0.5 | Over-compression lets noise peaks vote. |
| Jump cost 0.08 / 0.35 | Both worse than 0.18–0.25 | 0.25 chosen. |
| Window 1024 | Mixed (better on one song, worse on others) | Kept 2048. |
| Ceiling of classic salience methods | ~60–75 % frames within a semitone on these mixes | Further gains need source separation (see open decision). |

**Ideas considered but not built** (heavy): in-browser neural vocal separation
(Open-Unmix exported to ONNX + onnxruntime-web, ~35 MB model, ~10–30 s per song on
WASM; MDX-Net models are larger with unclear licenses); CREPE/Basic Pitch in
TF.js (monophonic / not vocal-specific, poor on mixes).

## Pitch source: keep both (decided 2026-10-04)

The user chose to keep **both** pitch paths for flexibility:
- `songs/*.pitch.json` (offline, Demucs + pYIN; more accurate) is used when present
  (setting `pitch: 'file'`, the default).
- The live in-browser estimate (~70–80% of words within 2 semitones) is used for songs
  without a pitch file, or when the user presses **P**.

Do not remove either path or change the default without asking.

## To do

- **Stop browsers serving stale files from the deployment** (decided: on the list, not
  done yet). The user's deployment is https://tap.gallaudet.edu/cvogler/alda-karaoke/
  (Apache 2.4.37 on RHEL). It sends `Last-Modified` and `ETag` but no `Cache-Control`
  or `Expires`, so browsers use heuristic freshness (RFC 9111 §4.2.2, typically 10% of
  the file's age). After the iOS fix, Safari kept the old `js/audio.js` even after the
  tab was closed; only a private window loaded the new one.
  - Planned fix: an `.htaccess` in the deployment folder with
    `Header set Cache-Control "no-cache"` for `html|js|css|json|csv|txt` (inside
    `<IfModule mod_headers.c>`), leaving the MP3s cacheable. `no-cache` = revalidate
    every time; unchanged files cost only a 304 thanks to the ETag.
  - Works only if the server allows `.htaccess` overrides and has `mod_headers`.
    Verify after upload: `curl -I …/js/audio.js` must show the `Cache-Control` line.
  - Version query strings (`audio.js?v=2`) alone are NOT enough: `index.html` gets
    the same heuristic caching, so a stale page never sees the new version tag.
    They're only worth adding on top of `no-cache` if long JS/CSS caching is wanted.
  - Also add a README note on deploying the `.htaccess` file.

## Most likely to break — test these next

Everything so far was tested with this Mac's Chrome driven headless and **muted**, at
1920×1080, with three steady-tempo studio songs by low-voiced singers. Nobody has yet
watched and listened at the same time on real hardware.

1. **Audio/visual sync on real speakers.** The `getOutputTimestamp` extrapolation, HDMI
   and Bluetooth latency, the [ ] offset, pause/resume and seeking, and switching output
   devices mid-session (plugging in the projector's HDMI can change the sample rate or
   suspend the AudioContext). Check that the dot lands on the sung syllable by eye and ear.
2. **Projector sizes and window resizes.** 4:3, 1280×720, 1024×768, ultrawide;
   entering/leaving full screen while playing (`layoutStage` re-measures). Long lines
   (63 characters max in the current songs) and `text-wrap: balance` (Chrome 114+).
   Check that the current + next line always fit and wrapped rows don't collide with the dot.
3. **New songs with messy data.** Overlapping or zero-length words, `word_end` after
   the next `word_start`, songs that start singing at 0 s or have intros under 6 s (the
   title-card timing branch), lyrics/CSV word-count mismatches (should show the error
   on the menu card), non-ASCII file names in the folder picker.
4. **Beat tracking beyond these three songs.** Tempo changes, rubato ballads, swing,
   songs without drums, and half/double-tempo errors (the tempo prior is centered at
   120 BPM; the ±4% comb refinement cannot fix octave errors).
5. **Pitch colors on other voices.** All three test singers are low (MIDI ~42–62).
   High female voices, duets/harmonies, rap, and songs without a pitch file (live
   estimate, ~70–80% of words within 2 semitones) are untested. Watch for colors
   jumping wildly between neighboring words.
6. **Opening `index.html` from disk.** No Worker there, so live-pitch analysis blocks
   the main thread (~4–5 s per song, menu animation freezes); the folder picker must be
   used once per session. `start.command` may be blocked by Gatekeeper after download
   (right-click → Open), and `python3` may trigger the Xcode tools install prompt.
7. **Stale analysis cache.** The cache key is song id + file byte length + pitch
   source. Replacing an audio file with one of the same size, or changing `dsp.js`
   without bumping `ANALYSIS_VERSION`, silently reuses old beats/pitch.
8. **Long sessions.** A karaoke night runs for hours. The screen wake lock is not
   requested again after the tab is hidden and shown; memory use across many song
   switches; rAF throttling in background tabs.
9. **Keyboard and focus.** Space while a control-bar button has focus (possible double
   toggle); presentation clickers (PageUp/PageDown/B) are not mapped.
10. **Rendering cost on a weaker laptop.** Glow, blur trail and box-shadow every frame
    (0.5 ms/frame on this Mac).

## Enhancement ideas (shortlist)

- "Singing resumes in N s" label during long mid-song instrumentals (as on the intro card).
- In-app settings panel instead of keyboard-only options; per-song sync offsets.
- Upcoming-melody "pitch lane" (notes shown ahead of time, SingStar-style) so singers
  can see the melody coming, not just the current note.
- Beat you can feel: send beats to phones (vibration) or a bass shaker/lights over
  WebSocket/Web Bluetooth, for participants who can't hear the music.
- Space for an ASL interpreter or a camera picture-in-picture (getUserMedia), in the
  "whatever works" spirit.
- Duets/parts: a per-word singer column in the CSV, with a different text color per singer.
- Tap-along timing editor to create the CSV for new songs in the browser; LRC/enhanced-LRC import.
- Performer queue with names and auto-advance; phone or clicker remote control.
- Downbeat/bar detection to emphasize the "1" of each bar.
- In-browser vocal separation (e.g. Open-Unmix exported to ONNX + onnxruntime-web) for
  pitch without Python, if the download size and speed are acceptable.

## Tooling gotchas

- **Claude in Chrome extension was not connected** in the first session. Testing used
  `puppeteer-core@19.11.1` (Node 16 compatible) driving
  `/Applications/Google Chrome.app` headless at 1920×1080 with
  `--autoplay-policy=no-user-gesture-required --mute-audio`. Install it in the
  scratchpad, not the project. `window.__karaoke` exposes `audio`, `library`, `stage`,
  `render`, `settings`, `dotPosition`, `landingPoint` for such tests; `?song=N` opens a song.
- Uploading to a `webkitdirectory` input with puppeteer: pass the **folder path**
  (`uploadFile('/…/songs')`), not a list of files — the file list fires no change event.
- **Demucs on Apple Silicon GPU (MPS) crashes** ("Output channels > 65536 not
  supported at the MPS device"). Use `-d cpu` (`tools/make_pitch_file.py` already does).
- Node test harness pattern: `ffmpeg -i song.mp3 -ac 1 -ar 22050 -f f32le x.f32`,
  read into a Float32Array, `require('./js/dsp.js').analyze(x, 22050, words)`.
  Reference: Python venv with `librosa` (+ `demucs`, `soundfile`) in the scratchpad;
  beat comparison with `librosa.beat.beat_track`, pitch reference = `librosa.pyin`
  on Demucs `vocals.wav` (fmin 70, fmax 1100, frame 2048, hop 256 — same frame grid
  as `vocalPitch`). Metrics used: frames within 1 semitone, words within 1/2
  semitones, word-median correlation, octave-error rate.
- Port 8765 is the project's local server port (`start.command`).

## Conventions

- Code is MIT-licensed (`LICENSE`, © 2026 Christian Vogler). Song audio/lyrics are CC
  per song, CSV timings are MIT (JamendoLyrics authors), the font is OFL. Keep the
  third-party section of `LICENSE` up to date when adding content.

- Keep `dsp.js` dependency-free and runnable in Node; keep everything working from
  `file://`.
- Black background and white/bright text are hard requirements; don't add
  decorative backgrounds behind lyrics.
- Test changes at 1920×1080 and check the console for errors in both http and
  `file://` modes.
