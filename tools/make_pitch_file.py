#!/usr/bin/env python3
"""
Optional: create a high-quality vocal pitch track for a song.

The karaoke player estimates the singer's pitch in the browser, straight
from the full mix. That works with no setup, but instruments sometimes
confuse it. This tool isolates the vocals with Demucs (a neural source
separation model) and tracks their pitch with pYIN, then writes
<song>.pitch.json next to the audio. The player picks that file up
automatically and uses it to color the bouncing dot.

Setup (once):
    python3 -m venv ~/karaoke-tools
    ~/karaoke-tools/bin/pip install demucs librosa soundfile

Usage:
    ~/karaoke-tools/bin/python tools/make_pitch_file.py songs/My_Song.mp3 [more.mp3 ...]
"""
import json
import os
import subprocess
import sys
import tempfile

import librosa
import numpy as np

SR = 22050
HOP = 256  # ~11.6 ms frames


def isolate_vocals(audio_path, workdir):
    subprocess.run(
        [sys.executable, '-m', 'demucs', '-d', 'cpu', '--two-stems=vocals', '-n', 'htdemucs', '-o', workdir, audio_path],
        check=True,
    )
    base = os.path.splitext(os.path.basename(audio_path))[0]
    return os.path.join(workdir, 'htdemucs', base, 'vocals.wav')


def pitch_track(vocals_path):
    y, _ = librosa.load(vocals_path, sr=SR, mono=True)
    f0, voiced, _ = librosa.pyin(y, fmin=70, fmax=1100, sr=SR, frame_length=2048, hop_length=HOP)
    midi = librosa.hz_to_midi(np.where(voiced, f0, np.nan))
    return [None if np.isnan(v) else round(float(v), 2) for v in midi]


def main(paths):
    if not paths:
        print(__doc__)
        sys.exit(1)
    for path in paths:
        out = os.path.splitext(path)[0] + '.pitch.json'
        print(f'== {path}')
        with tempfile.TemporaryDirectory() as tmp:
            midi = pitch_track(isolate_vocals(path, tmp))
        with open(out, 'w') as fh:
            json.dump({'version': 1, 'hop': HOP / SR, 'source': 'demucs htdemucs vocals + pyin', 'midi': midi}, fh, separators=(',', ':'))
        print(f'   wrote {out}')


if __name__ == '__main__':
    main(sys.argv[1:])
