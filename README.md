# ALDAcon 2026 Karaoke

A big-screen karaoke player for the ALDAcon karaoke party. It is pure HTML, CSS and
JavaScript with no installs and no internet needed. The lyrics are huge white text
on black. A bouncing dot lands on each word as it is sung, **pulses with the beat**,
and **changes color with the singer's pitch**: red for low notes, through the
rainbow, to violet for the highest.

## Running it

**Easiest (Mac):** double-click `start.command`. It starts a tiny local web server
(using the `python3` that ships with macOS developer tools) and opens Chrome at
<http://localhost:8765/>. Leave its window open while singing.

**Or:** open `index.html` directly in Chrome. Chrome doesn't let pages opened from
disk read nearby files, so the player asks you to choose the `songs` folder once
per session. After that, everything works the same.

Press **F** for full screen. Then pick a song with the arrow keys and Enter (or
1/2/3), and press **Space** to start.

## Controls

| Key | Action |
|---|---|
| Space | Play / pause |
| ← → | Back / forward 5 s (Shift: 15 s) |
| Home | Restart song |
| N | Next song |
| Esc | Back to song list |
| F | Full screen |
| + / − | Bigger / smaller lyrics |
| [ / ] | Lyrics earlier / later in 25 ms steps (fixes speaker or Bluetooth delay) |
| C | Color of sung words: gold, cyan, pitch rainbow, white |
| T | Dot trail on / off |
| P | Dot color from the pitch file, or the live estimate |
| ? | Help |

Moving the mouse shows an on-screen control bar. It hides itself during playback,
and so does the mouse pointer. Settings are remembered in the browser.

## What's on screen

- The **current line** is white, with the next line dimmed below it. The text is
  sized so the current and next lines always fit, about 10% of the screen height.
  Wrapped lines are balanced.
- Sung words fill in left to right, timed to the syllable.
- The **dot** lands exactly on each word's start time (checked to within 1 px at all
  536 landings in "Bad Side") and slides along long, held words. It squashes a little
  on landing, swells with a glow ring on every beat (strong beats pulse more), and
  leaves a short comet trail.
- During the intro and instrumental breaks, the dot bounces in place on the beat
  over the next word to be sung. **Count-in dots** disappear one per beat before a
  line that follows a pause.
- A title card covers the intro, and a "Thank you!" card shows at the end with the
  song's Creative Commons credit. Neither is ever still while music plays: a gold
  **music dot** bounces on the beat (higher when the music is louder) with a large
  label, such as "♪ Music intro · singing starts in 15 s" or "♪ Music still playing".
  It comes to rest on "Paused" or "Song finished", so the screen never looks frozen
  when only instruments are playing. After the last word, the lyric dot keeps
  bouncing on the beat until the end card appears.

## Adding songs

Each song needs three files in `songs/` with the same base name:

- `My_Song.mp3`: audio (mp3, m4a, wav, ogg or flac)
- `My_Song.csv`: one row per word, with columns `word_start,word_end,line_end` in
  seconds (the JamendoLyrics format)
- `My_Song.txt`: lyrics, one line per lyric line, with a blank line between verses.
  Words must be in the same order as the CSV rows.

Then add an entry to `songs/songs.js`. Or, at the event, use **"Add songs from a
folder…"** on the start screen to load a folder of songs without editing anything.

## How the music analysis works (all in the browser)

`js/dsp.js` analyzes each song when the player loads it. It runs in a background
worker and is cached afterwards.

**Beat:** a spectral-flux onset envelope on a log-mel spectrogram, then a tempo
estimate by autocorrelation. A fine comb-filter search then refines the tempo (studio
tracks sit on an exact grid), and Ellis' dynamic-programming beat tracker places the
beats (the same method librosa uses). Checked against librosa on all three songs:

| Song | Player tempo | librosa | Comb-filter peak | Onset strength at beats (player / librosa) |
|---|---|---|---|---|
| Feel (Stripped) | 100.0 | 99.4 | 100.0 | 3.03 / 2.98 |
| Is It Right? | 135.0 | 136.0 | 135.0 | 3.22 / 3.20 |
| Bad Side | 146.7 | 143.6 | 146.7 | 2.26 / 2.25 |

**Pitch:** harmonic-summation salience with compressed magnitudes and a gentle bass
high-pass, measured only while words are being sung (the lyric timings tell us when
someone is singing). A Viterbi path then picks the melody and suppresses octave
jumps. The colors are spread over each song's own range (8th–92nd percentile), so
every song uses the full rainbow.

### Optional pitch files (better colors)

Picking the voice out of a full band mix is hard. Measured against vocals isolated
with Demucs and tracked with pYIN, the live estimate gets about **70–80% of words
within two semitones**. That's good enough to follow the shape of the melody, but
instruments sometimes win. For more accurate colors, the player also reads
`songs/<song>.pitch.json` when it exists. These files are included for the three
conference songs. To make one for a new song (this is the only part that needs
installing anything, and only on the organizer's machine):

```sh
python3 -m venv ~/karaoke-tools
~/karaoke-tools/bin/pip install demucs librosa soundfile
~/karaoke-tools/bin/python tools/make_pitch_file.py songs/My_Song.mp3
```

Press **P** in the player to compare the file against the live estimate.

## Files

```
index.html            page shell
css/karaoke.css       styles
js/app.js             menu, player, lyric stage, bouncing dot, controls
js/audio.js           Web Audio playback with a latency-compensated song clock
js/dsp.js             beat tracking + vocal pitch (no dependencies)
js/dsp-worker.js      runs dsp.js off the main thread
js/lyrics.js          builds words/lines from the CSV + lyrics text
songs/                audio, timings, lyrics, pitch files, songs.js list
fonts/                Atkinson Hyperlegible Next (SIL Open Font License)
tools/                optional pitch-file generator
start.command         macOS launcher
```

## License and credits

The player's code is released under the [MIT License](LICENSE). The songs, lyrics,
timings, pitch files and font keep their own licenses, listed in `LICENSE`:

- Songs and lyrics come from the
  [JamendoLyrics](https://github.com/f90/jamendolyrics) dataset under Creative
  Commons: "Feel (Stripped)" by Cortéz (CC BY), "Is It Right?" by Lower Loveday
  (CC BY-SA), and "Bad Side" by Rxbyn (CC BY). Credit the artists when you show them.
- Word timings: JamendoLyrics, MIT License (Stoller, Durand, Ewert).
- Pitch files are derived from the recordings and use each song's license.
- Font: Atkinson Hyperlegible Next by the Braille Institute (SIL OFL 1.1).

If you add your own songs, make sure you have the rights to play them at your event.
