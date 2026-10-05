/*
 * ALDAcon Karaoke — audio analysis (pure JavaScript, no dependencies).
 *
 *  - Beat tracking: log-mel spectral-flux onset envelope, autocorrelation
 *    tempo estimate with a log-normal tempo prior, and Ellis' dynamic-
 *    programming beat tracker (the same approach as librosa.beat.beat_track).
 *  - Vocal pitch: harmonic-summation salience (Melodia-style) restricted to
 *    the singing range, Viterbi-smoothed per sung phrase to avoid octave
 *    jumps. The lyric timings tell us *when* someone is singing, so we only
 *    have to find *which* pitch is the voice.
 *
 * Works in the browser (window.KaraokeDSP) and in Node (module.exports) so
 * it can be tested against reference implementations.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- FFT ---

  const fftCache = new Map();

  function makeFFT(n) {
    if (fftCache.has(n)) return fftCache.get(n);
    const levels = Math.round(Math.log2(n));
    if (1 << levels !== n) throw new Error('FFT size must be a power of 2');
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let j = 0, x = i; j < levels; j++, x >>= 1) r = (r << 1) | (x & 1);
      rev[i] = r;
    }
    // In-place forward complex FFT.
    function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = im[l] * cos[k] - re[l] * sin[k];
            re[l] = re[j] - tre;
            im[l] = im[j] - tim;
            re[j] += tre;
            im[j] += tim;
          }
        }
      }
    }
    fftCache.set(n, fft);
    return fft;
  }

  function hann(n, periodic = true) {
    const w = new Float64Array(n);
    const d = periodic ? n : n - 1;
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
    return w;
  }

  /**
   * Centered short-time power spectrum. Calls onFrame(t, power) for every
   * frame; `power` (length nFFT/2+1) is reused between calls.
   */
  function stftPower(x, { nWin, nFFT, hop }, onFrame, frameFilter) {
    const fft = makeFFT(nFFT);
    const win = hann(nWin);
    const re = new Float64Array(nFFT);
    const im = new Float64Array(nFFT);
    const power = new Float64Array(nFFT / 2 + 1);
    const nFrames = 1 + Math.floor(x.length / hop);
    const half = nWin >> 1;
    for (let t = 0; t < nFrames; t++) {
      if (frameFilter && !frameFilter(t)) continue;
      re.fill(0);
      im.fill(0);
      const start = t * hop - half;
      for (let i = 0; i < nWin; i++) {
        const k = start + i;
        if (k >= 0 && k < x.length) re[i] = x[k] * win[i];
      }
      fft(re, im);
      for (let k = 0; k <= nFFT / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
      onFrame(t, power);
    }
    return nFrames;
  }

  // ------------------------------------------------------- mel / onsets ---

  function hzToMel(f) {
    const fSp = 200 / 3;
    const minLogHz = 1000;
    const minLogMel = minLogHz / fSp;
    const logstep = Math.log(6.4) / 27;
    return f < minLogHz ? f / fSp : minLogMel + Math.log(f / minLogHz) / logstep;
  }

  function melToHz(m) {
    const fSp = 200 / 3;
    const minLogHz = 1000;
    const minLogMel = minLogHz / fSp;
    const logstep = Math.log(6.4) / 27;
    return m < minLogMel ? m * fSp : minLogHz * Math.exp(logstep * (m - minLogMel));
  }

  /** Slaney-style mel filterbank (librosa defaults). Returns sparse rows. */
  function melFilterbank(sr, nFFT, nMels, fMin = 0, fMax = sr / 2) {
    const nBins = nFFT / 2 + 1;
    const mMin = hzToMel(fMin);
    const mMax = hzToMel(fMax);
    const hz = [];
    for (let i = 0; i < nMels + 2; i++) hz.push(melToHz(mMin + ((mMax - mMin) * i) / (nMels + 1)));
    const filters = [];
    for (let m = 0; m < nMels; m++) {
      const lo = hz[m], mid = hz[m + 1], hi = hz[m + 2];
      const enorm = 2 / (hi - lo);
      const idx = [], w = [];
      for (let k = 0; k < nBins; k++) {
        const f = (k * sr) / nFFT;
        const v = Math.max(0, Math.min((f - lo) / (mid - lo), (hi - f) / (hi - mid)));
        if (v > 0) { idx.push(k); w.push(v * enorm); }
      }
      filters.push({ idx, w });
    }
    return filters;
  }

  /** Spectral-flux onset strength envelope on a log-mel spectrogram. */
  function onsetStrength(x, sr, opts = {}) {
    const nFFT = opts.nFFT || 2048;
    const hop = opts.hop || 512;
    const nMels = opts.nMels || 128;
    const filters = melFilterbank(sr, nFFT, nMels);
    const mel = [];
    let globalMax = 1e-10;
    stftPower(x, { nWin: nFFT, nFFT, hop }, (t, p) => {
      const row = new Float32Array(nMels);
      for (let m = 0; m < nMels; m++) {
        const f = filters[m];
        let s = 0;
        for (let j = 0; j < f.idx.length; j++) s += p[f.idx[j]] * f.w[j];
        row[m] = s;
        if (s > globalMax) globalMax = s;
      }
      mel.push(row);
    });
    // power_to_db(ref=max, top_db=80)
    const refDb = 10 * Math.log10(globalMax);
    const floorDb = -80;
    for (const row of mel) {
      for (let m = 0; m < nMels; m++) {
        const db = 10 * Math.log10(Math.max(1e-10, row[m])) - refDb;
        row[m] = db < floorDb ? floorDb : db;
      }
    }
    const n = mel.length;
    const env = new Float32Array(n);
    // Diff with lag 1, then shift right by the centering offset (librosa).
    const shift = 1 + Math.floor(nFFT / (2 * hop));
    for (let t = 1; t < n; t++) {
      const a = mel[t], b = mel[t - 1];
      let s = 0;
      for (let m = 0; m < nMels; m++) {
        const d = a[m] - b[m];
        if (d > 0) s += d;
      }
      const dst = t - 1 + shift;
      if (dst < n) env[dst] = s / nMels;
    }
    return { env, frameRate: sr / hop, hop, sr };
  }

  // -------------------------------------------------------------- tempo ---

  /** Global tempo (BPM) from the mean windowed autocorrelation. */
  function estimateTempo(env, frameRate, opts = {}) {
    const startBpm = opts.startBpm || 120;
    const stdBpm = opts.stdBpm || 1.0;
    const maxBpm = opts.maxBpm || 320;
    const winLen = Math.floor(8.0 * frameRate); // 8-second analysis windows
    const nFFT = 1 << Math.ceil(Math.log2(2 * winLen));
    const fft = makeFFT(nFFT);
    const win = hann(winLen);
    const re = new Float64Array(nFFT);
    const im = new Float64Array(nFFT);
    const acc = new Float64Array(winLen);
    const half = winLen >> 1;
    const n = env.length;
    let count = 0;
    const stride = 2;
    for (let c = 0; c < n; c += stride) {
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < winLen; i++) {
        let k = c - half + i;
        // linear-ramp-ish padding: just clamp to zero outside the signal
        re[i] = k >= 0 && k < n ? env[k] * win[i] : 0;
      }
      fft(re, im);
      for (let k = 0; k < nFFT; k++) {
        re[k] = re[k] * re[k] + im[k] * im[k];
        im[k] = 0;
      }
      fft(re, im); // power spectrum is real & symmetric => forward FFT == n*IFFT
      const norm = re[0];
      if (norm <= 0) continue;
      for (let l = 0; l < winLen; l++) acc[l] += re[l] / norm;
      count++;
    }
    let best = -Infinity, bestLag = 0;
    const tgAt = (l) => acc[l] / Math.max(1, count);
    for (let l = 1; l < winLen; l++) {
      const bpm = (60 * frameRate) / l;
      if (bpm > maxBpm) continue;
      const logPrior = -0.5 * Math.pow((Math.log2(bpm) - Math.log2(startBpm)) / stdBpm, 2);
      const score = Math.log1p(1e6 * Math.max(0, tgAt(l))) + logPrior;
      if (score > best) { best = score; bestLag = l; }
    }
    // Integer lags are coarse (~4 BPM apart near 100 BPM): refine to a
    // fractional lag with a parabola through the autocorrelation peak.
    let lag = bestLag;
    if (bestLag > 1 && bestLag < winLen - 1) {
      const a = tgAt(bestLag - 1), b = tgAt(bestLag), c = tgAt(bestLag + 1);
      const den = a - 2 * b + c;
      if (den < 0) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    return { bpm: (60 * frameRate) / lag, lag };
  }

  /**
   * Studio recordings usually sit on an exact tempo grid. A comb filter
   * swept finely around the coarse estimate (best phase per tempo) finds it
   * to within ~0.05 BPM, which keeps the beat tracker from drifting.
   */
  function refineTempo(env, frameRate, bpm0, opts = {}) {
    const spread = opts.spread || 0.04;
    const step = opts.step || 0.05;
    const nPhase = 48;
    const n = env.length;
    const at = (f) => {
      const i = Math.floor(f);
      if (i < 0 || i >= n - 1) return 0;
      const u = f - i;
      return env[i] * (1 - u) + env[i + 1] * u;
    };
    let best = -Infinity, bestBpm = bpm0;
    for (let bpm = bpm0 * (1 - spread); bpm <= bpm0 * (1 + spread); bpm += step) {
      const period = (60 * frameRate) / bpm;
      for (let p = 0; p < nPhase; p++) {
        let s = 0, c = 0;
        for (let f = (p / nPhase) * period; f < n - 1; f += period, c++) s += at(f);
        const score = s / Math.max(1, c);
        if (score > best) { best = score; bestBpm = bpm; }
      }
    }
    return bestBpm;
  }

  // -------------------------------------------------------------- beats ---

  function std(a) {
    let m = 0;
    for (let i = 0; i < a.length; i++) m += a[i];
    m /= a.length;
    let v = 0;
    for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
    return Math.sqrt(v / Math.max(1, a.length - 1));
  }

  /** Ellis (2007) dynamic-programming beat tracker. Returns beat frames. */
  function trackBeats(env, frameRate, bpm, opts = {}) {
    const tightness = opts.tightness || 100;
    const n = env.length;
    const period = (frameRate * 60) / bpm;
    const fpb = Math.round(period);
    // Normalize onsets and compute the local score.
    const sd = std(env) + 1e-12;
    const onset = new Float64Array(n);
    for (let i = 0; i < n; i++) onset[i] = env[i] / sd;
    const kernel = [];
    for (let k = -fpb; k <= fpb; k++) kernel.push(Math.exp(-0.5 * Math.pow((k * 32) / fpb, 2)));
    const local = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < kernel.length; k++) {
        const j = i + k - fpb;
        if (j >= 0 && j < n) s += onset[j] * kernel[k];
      }
      local[i] = s;
    }
    let localMax = 0;
    for (let i = 0; i < n; i++) if (local[i] > localMax) localMax = local[i];

    // Dynamic programming.
    const wStart = -Math.round(2 * period);
    const wEnd = -Math.round(period / 2);
    const txwt = [];
    for (let w = wStart; w <= wEnd; w++) txwt.push(-tightness * Math.pow(Math.log(-w / period), 2));
    const cum = new Float64Array(n);
    const back = new Int32Array(n).fill(-1);
    let firstBeat = true;
    for (let i = 0; i < n; i++) {
      let best = -Infinity, bestK = 0;
      for (let k = 0; k < txwt.length; k++) {
        const j = i + wStart + k;
        const c = txwt[k] + (j >= 0 ? cum[j] : 0);
        if (c > best) { best = c; bestK = k; }
      }
      cum[i] = local[i] + best;
      if (firstBeat && local[i] < 0.01 * localMax) {
        back[i] = -1;
      } else {
        back[i] = i + wStart + bestK;
        firstBeat = false;
      }
    }
    // Last beat: last local max of the cumulative score above half the median.
    const maxima = [];
    for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(i);
    const medVals = maxima.map((i) => cum[i]).sort((a, b) => a - b);
    const med = medVals.length ? medVals[medVals.length >> 1] : 0;
    let tail = n - 1;
    for (let k = maxima.length - 1; k >= 0; k--) {
      if (2 * cum[maxima[k]] > med) { tail = maxima[k]; break; }
    }
    let beats = [];
    for (let b = tail; b >= 0; b = back[b]) beats.push(b);
    beats.reverse();

    // Trim weak leading/trailing beats.
    const lsb = beats.map((b) => local[b]);
    const smooth = lsb.map((_, i) => {
      const a = i > 0 ? lsb[i - 1] : 0;
      const c = i < lsb.length - 1 ? lsb[i + 1] : 0;
      return 0.5 * a + lsb[i] + 0.5 * c;
    });
    const rms = Math.sqrt(smooth.reduce((s, v) => s + v * v, 0) / Math.max(1, smooth.length));
    const thr = 0.5 * rms;
    let lo = 0, hi = beats.length - 1;
    while (lo <= hi && smooth[lo] <= thr) lo++;
    while (hi >= lo && smooth[hi] <= thr) hi--;
    beats = beats.slice(lo, hi + 1);
    return { frames: beats, local };
  }

  // --------------------------------------------------------- vocal pitch ---

  const P = {
    sr: 22050,
    nWin: 2048,
    nFFT: 8192,
    hop: 256,
    fMinSal: 55, // salience grid start (A1)
    binsPerSemitone: 5, // 20-cent resolution
    nSemis: 60, // 5 octaves: A1 .. A6
    nHarm: 20,
    alpha: 0.8,
    peakDbRange: 40,
    maxPeaks: 40,
    vocalLoMidi: 40, // E2 ~ 82 Hz
    vocalHiMidi: 84, // C6 ~ 1047 Hz
  };

  function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function hzToMidi(f) { return 69 + 12 * Math.log2(f / 440); }

  /**
   * Computes a voice pitch contour (MIDI, NaN = unvoiced) on a fixed frame
   * grid, only for frames inside the given voiced intervals [[t0,t1],...].
   */
  function vocalPitch(x, sr, voiced, opts = {}) {
    // beta < 1 compresses peak magnitudes so many weak vocal harmonics can
    // outvote a few loud accompaniment partials; the gentle high-pass keeps
    // the bass line from capturing the melody. Tuned against Demucs+pYIN
    // references (see README).
    const cfg = Object.assign({ nHarm: P.nHarm, beta: 0.5, hpHz: 120, maxPeaks: P.maxPeaks, jumpCost: 0.25 }, opts);
    const hop = opts.hop || Math.round((P.hop * sr) / P.sr);
    const nWin = opts.nWin || Math.round((P.nWin * sr) / P.sr);
    const nFFT = 1 << Math.ceil(Math.log2(nWin * (opts.zeroPad || 4)));
    const nFrames = 1 + Math.floor(x.length / hop);
    const frameT = (t) => (t * hop) / sr;
    const bps = P.binsPerSemitone;
    const nBins = P.nSemis * bps;
    const midi0 = hzToMidi(P.fMinSal);
    const binMidi = (b) => midi0 + b / bps;

    // Mark voiced frames.
    const isVoiced = new Uint8Array(nFrames);
    for (const [a, b] of voiced) {
      const f0 = Math.max(0, Math.ceil((a * sr) / hop));
      const f1 = Math.min(nFrames - 1, Math.floor((b * sr) / hop));
      for (let f = f0; f <= f1; f++) isVoiced[f] = 1;
    }

    const sal = new Map(); // frame -> Float32Array(nBins)
    const binHz = sr / nFFT;
    const kMin = Math.floor(P.fMinSal / binHz);
    const kMax = Math.min(nFFT / 2 - 1, Math.ceil(5000 / binHz));
    const harmW = [];
    for (let h = 1; h <= cfg.nHarm; h++) harmW.push(Math.pow(P.alpha, h - 1));
    const spread = bps; // +/- 1 semitone

    const hpW = new Float64Array(nFFT / 2 + 1);
    for (let k = 0; k < hpW.length; k++) {
      const f = k * binHz;
      hpW[k] = cfg.hpHz ? f / Math.sqrt(f * f + cfg.hpHz * cfg.hpHz) : 1;
    }

    const mag = new Float64Array(nFFT / 2 + 1);
    stftPower(
      x,
      { nWin, nFFT, hop },
      (t, power) => {
        let maxMag = 0;
        for (let k = 0; k < mag.length; k++) {
          mag[k] = Math.sqrt(power[k]) * hpW[k];
          if (k >= kMin && k <= kMax && mag[k] > maxMag) maxMag = mag[k];
        }
        if (maxMag <= 0) return;
        const minMag = maxMag * Math.pow(10, -P.peakDbRange / 20);
        // Spectral peaks with parabolic interpolation (in dB).
        const peaks = [];
        for (let k = Math.max(kMin, 1); k <= kMax; k++) {
          const m = mag[k];
          if (m < minMag || m <= mag[k - 1] || m < mag[k + 1]) continue;
          const a = 20 * Math.log10(mag[k - 1] + 1e-12);
          const b = 20 * Math.log10(m + 1e-12);
          const c = 20 * Math.log10(mag[k + 1] + 1e-12);
          const den = a - 2 * b + c;
          const off = den !== 0 ? (0.5 * (a - c)) / den : 0;
          const peakDb = b - 0.25 * (a - c) * off;
          peaks.push([(k + off) * binHz, Math.pow(10, peakDb / 20)]);
        }
        peaks.sort((u, v) => v[1] - u[1]);
        if (peaks.length > cfg.maxPeaks) peaks.length = cfg.maxPeaks;
        const s = new Float32Array(nBins);
        for (const [f, a] of peaks) {
          const ab = cfg.beta === 1 ? a : Math.pow(a, cfg.beta);
          for (let h = 1; h <= cfg.nHarm; h++) {
            const f0 = f / h;
            if (f0 < P.fMinSal) break;
            const bc = (hzToMidi(f0) - midi0) * bps;
            const b0 = Math.round(bc);
            const w = ab * harmW[h - 1];
            for (let d = -spread; d <= spread; d++) {
              const bb = b0 + d;
              if (bb < 0 || bb >= nBins) continue;
              const dist = Math.abs(bb - bc) / (spread + 1);
              if (dist >= 1) continue;
              const cw = Math.cos((Math.PI / 2) * dist);
              s[bb] += w * cw * cw;
            }
          }
        }
        sal.set(t, s);
      },
      (t) => isVoiced[t] === 1
    );

    // Viterbi over semitone states, separately for each voiced run.
    const loS = Math.max(0, Math.round(P.vocalLoMidi - midi0));
    const hiS = Math.min(P.nSemis - 1, Math.round(P.vocalHiMidi - midi0));
    const nS = hiS - loS + 1;
    const jumpCost = cfg.jumpCost;
    const midi = new Float32Array(nFrames).fill(NaN);
    const conf = new Float32Array(nFrames);

    let t = 0;
    while (t < nFrames) {
      if (!sal.has(t)) { t++; continue; }
      const run = [];
      while (t < nFrames && sal.has(t)) run.push(t++);
      // Emission: log of semitone-pooled salience relative to the frame max.
      const em = run.map((f) => {
        const s = sal.get(f);
        const e = new Float64Array(nS);
        let mx = 1e-12;
        for (let i = 0; i < nS; i++) {
          const semi = loS + i;
          let v = 0;
          for (let j = -2; j <= 2; j++) {
            const b = semi * bps + j;
            if (b >= 0 && b < nBins && s[b] > v) v = s[b];
          }
          e[i] = v;
          if (v > mx) mx = v;
        }
        for (let i = 0; i < nS; i++) e[i] = Math.log(e[i] / mx + 1e-3);
        return e;
      });
      const L = run.length;
      const score = new Float64Array(nS);
      const backp = [];
      for (let i = 0; i < nS; i++) score[i] = em[0][i];
      for (let k = 1; k < L; k++) {
        const bp = new Int16Array(nS);
        const next = new Float64Array(nS);
        for (let i = 0; i < nS; i++) {
          let best = -Infinity, bi = 0;
          for (let j = 0; j < nS; j++) {
            const v = score[j] - jumpCost * Math.abs(i - j);
            if (v > best) { best = v; bi = j; }
          }
          next[i] = best + em[k][i];
          bp[i] = bi;
        }
        score.set(next);
        backp.push(bp);
      }
      let state = 0;
      for (let i = 1; i < nS; i++) if (score[i] > score[state]) state = i;
      const path = new Int16Array(L);
      path[L - 1] = state;
      for (let k = L - 1; k > 0; k--) { state = backp[k - 1][state]; path[k - 1] = state; }
      // Refine within +/- 2 sub-bins of the chosen semitone.
      for (let k = 0; k < L; k++) {
        const s = sal.get(run[k]);
        const center = (loS + path[k]) * bps;
        let bb = center, bv = -1;
        for (let j = -2; j <= 2; j++) {
          const b = center + j;
          if (b > 0 && b < nBins - 1 && s[b] > bv) { bv = s[b]; bb = b; }
        }
        let off = 0;
        if (bb > 0 && bb < nBins - 1) {
          const a = s[bb - 1], b = s[bb], c = s[bb + 1];
          const den = a - 2 * b + c;
          if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
        }
        midi[run[k]] = binMidi(bb + off);
        conf[run[k]] = Math.exp(em[k][path[k]]);
      }
    }
    // 5-frame median filter inside voiced runs.
    const out = new Float32Array(nFrames).fill(NaN);
    for (let f = 0; f < nFrames; f++) {
      if (isNaN(midi[f])) continue;
      const w = [];
      for (let d = -2; d <= 2; d++) {
        const v = midi[f + d];
        if (v !== undefined && !isNaN(v)) w.push(v);
      }
      w.sort((a, b) => a - b);
      out[f] = w[w.length >> 1];
    }
    return { midi: out, conf, hop: hop / sr, frameT };
  }

  // ----------------------------------------------------------- pipeline ---

  function median(arr) {
    if (!arr.length) return NaN;
    const s = Array.from(arr).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  function percentile(arr, p) {
    if (!arr.length) return NaN;
    const s = Array.from(arr).sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, (p / 100) * (s.length - 1)));
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }

  const LOUD_HOP = 1024;

  /** Loudness per frame, 0 (40 dB below the loud parts, or silent) .. 1. */
  function loudnessEnvelope(x, sr, hop) {
    const n = Math.floor(x.length / hop);
    const db = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = i * hop; k < (i + 1) * hop; k++) s += x[k] * x[k];
      db[i] = 10 * Math.log10(s / hop + 1e-12);
    }
    const ref = percentile(db, 95);
    return Array.from(db, (v) => +Math.max(0, Math.min(1, (v - ref + 40) / 40)).toFixed(2));
  }

  /**
   * The beat tracker trims weak beats at the very start and end. Continue the
   * grid at the song tempo wherever music is still audible, so the dot keeps
   * time through quiet intros and fade-outs. Modifies the arrays in place.
   */
  function extendBeatGrid(beats, strength, period, loud, loudRate, duration) {
    if (!beats.length) return;
    const loudAt = (t) => loud[Math.max(0, Math.min(loud.length - 1, Math.floor(t * loudRate)))] || 0;
    const audible = 0.2;
    const head = [], headS = [];
    for (let t = beats[0] - period; t >= 0.05; t -= period) {
      if (loudAt(t) < audible) break;
      head.unshift(t);
      headS.unshift(0.35);
    }
    beats.unshift(...head);
    strength.unshift(...headS);
    for (let t = beats[beats.length - 1] + period; t < duration - 0.05; t += period) {
      if (loudAt(t) < audible) break;
      beats.push(t);
      strength.push(0.35);
    }
  }

  /**
   * Full analysis of a mono signal given word timings [{start,end}].
   * Calls progress(fraction, label) as it goes; yields between stages.
   */
  async function analyze(x, sr, words, progress = () => {}, opts = {}) {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    progress(0.05, 'Listening for the beat');
    await tick();
    const { env, frameRate } = onsetStrength(x, sr);
    progress(0.3, 'Finding the tempo');
    await tick();
    const tempo = estimateTempo(env, frameRate);
    tempo.bpm = refineTempo(env, frameRate, tempo.bpm);
    const bt = trackBeats(env, frameRate, tempo.bpm);
    const beats = bt.frames.map((f) => f / frameRate);
    // Beat strength: onset peak near each beat, normalized to ~[0,1].
    const raw = bt.frames.map((f) => {
      let m = 0;
      for (let d = -2; d <= 2; d++) if (env[f + d] > m) m = env[f + d];
      return m;
    });
    const p90 = percentile(raw, 90) || 1;
    const strength = raw.map((v) => Math.max(0.15, Math.min(1, v / p90)));

    // Loudness lets the player show "music is playing" even when nobody
    // sings, and come to rest when the music really stops.
    const loud = loudnessEnvelope(x, sr, LOUD_HOP);
    extendBeatGrid(beats, strength, 60 / tempo.bpm, loud, sr / LOUD_HOP, x.length / sr);

    let pitch;
    if (opts.pitchTrack) {
      // Supplied pitch file (e.g. from isolated vocals): use it as-is.
      pitch = { midi: Float32Array.from(opts.pitchTrack.midi, (v) => (v === null ? NaN : v)), hop: opts.pitchTrack.hop };
    } else {
      progress(0.45, 'Tracing the melody');
      await tick();
      pitch = vocalPitch(x, sr, words.map((w) => [w.start, w.end]));
    }

    // Per-word pitch = median of the frames inside the word.
    const wordPitch = words.map((w) => {
      const f0 = Math.ceil(w.start / pitch.hop);
      const f1 = Math.floor(w.end / pitch.hop);
      const vals = [];
      for (let f = f0; f <= f1; f++) if (!isNaN(pitch.midi[f])) vals.push(pitch.midi[f]);
      return vals.length ? median(vals) : NaN;
    });
    // Repair octave errors at the word level against the phrase median.
    const valid = wordPitch.filter((v) => !isNaN(v));
    const songMed = median(valid);
    for (let i = 0; i < wordPitch.length; i++) {
      if (isNaN(wordPitch[i])) continue;
      const nb = [];
      for (let j = Math.max(0, i - 4); j <= Math.min(wordPitch.length - 1, i + 4); j++) {
        if (j !== i && !isNaN(wordPitch[j])) nb.push(wordPitch[j]);
      }
      const ref = nb.length >= 3 ? median(nb) : songMed;
      let v = wordPitch[i];
      while (v - ref > 9) v -= 12;
      while (ref - v > 9) v += 12;
      wordPitch[i] = v;
    }
    const fixed = wordPitch.filter((v) => !isNaN(v));
    const range = { lo: percentile(fixed, 8), hi: percentile(fixed, 92) };
    if (!(range.hi - range.lo >= 5)) {
      const mid = isNaN(songMed) ? 60 : songMed;
      range.lo = mid - 4;
      range.hi = mid + 4;
    }
    progress(1, 'Ready');
    return {
      version: 1,
      pitchSource: opts.pitchTrack ? 'file' : 'live',
      tempo: tempo.bpm,
      beats,
      beatStrength: strength,
      loudHop: LOUD_HOP / sr,
      loudness: loud,
      pitchHop: pitch.hop,
      pitch: pitch.midi,
      wordPitch,
      range,
    };
  }

  const api = {
    makeFFT, hann, stftPower, melFilterbank, onsetStrength, estimateTempo, refineTempo,
    trackBeats, vocalPitch, analyze, loudnessEnvelope, median, percentile, midiToHz, hzToMidi,
  };
  root.KaraokeDSP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
