/*
 * Song list for the ALDAcon Karaoke player.
 *
 * Each song needs three files in this folder:
 *   audio   – the music (mp3, m4a, wav, ...)
 *   timing  – CSV with columns word_start,word_end,line_end (seconds), one row per word
 *   lyrics  – plain text, one lyric line per line, blank line between verses;
 *             the words must appear in the same order as the CSV rows
 *
 * To add a song: copy the three files here and add an entry below.
 * (Songs can also be added at the event without editing this file: use
 * "Add songs from a folder…" on the start screen.)
 */
window.KARAOKE_SONGS = [
  {
    id: 'cortez-feel-stripped',
    title: 'Feel (Stripped)',
    artist: 'Cortéz',
    audio: 'Cortez_-_Feel__Stripped_.mp3',
    timing: 'Cortez_-_Feel__Stripped_.csv',
    lyrics: 'Cortez_-_Feel__Stripped_.txt',
    credit: 'Licensed CC BY · jamendo.com/track/1481500',
  },
  {
    id: 'lower-loveday-is-it-right',
    title: 'Is It Right?',
    artist: 'Lower Loveday',
    audio: 'Lower_Loveday_-_Is_It_Right_.mp3',
    timing: 'Lower_Loveday_-_Is_It_Right_.csv',
    lyrics: 'Lower_Loveday_-_Is_It_Right_.txt',
    credit: 'Licensed CC BY-SA · jamendo.com/track/1559614',
  },
  {
    id: 'rxbyn-bad-side',
    title: 'Bad Side',
    artist: 'Rxbyn',
    audio: 'Rxbyn_-_Bad_Side.mp3',
    timing: 'Rxbyn_-_Bad_Side.csv',
    lyrics: 'Rxbyn_-_Bad_Side.txt',
    credit: 'Licensed CC BY · jamendo.com/track/1556580',
  },
];
