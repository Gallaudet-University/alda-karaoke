/*
 * ALDAcon Karaoke — application: song menu, loading/analysis, lyric stage,
 * bouncing dot, controls.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const ANALYSIS_VERSION = 4;
  const SAMPLE_RATE = 22050;

  // ------------------------------------------------------------ settings ---

  // pitch: 'file' = use <song>.pitch.json when there is one, 'live' = always
  // estimate from the audio in the browser.
  const DEFAULTS = { scale: 1, syncMs: 0, sung: 'gold', trail: true, pitch: 'file' };
  const SUNG_MODES = ['gold', 'cyan', 'rainbow', 'white'];
  const SUNG_LABEL = { gold: 'Gold', cyan: 'Cyan', rainbow: 'Pitch rainbow', white: 'White' };

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('aldak:settings') || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  const settings = loadSettings();
  function saveSettings() {
    try { localStorage.setItem('aldak:settings', JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------------- pitch color ---

  // Lowest sung pitches are red, highest are violet (hue 0 → 275).
  function pitchHue(midi, range) {
    if (!range || isNaN(midi)) return 45;
    const u = clamp((midi - range.lo) / (range.hi - range.lo), 0, 1);
    return u * 275;
  }
  function hueColor(h, light = 60) {
    // Blues/violets look darker on black; lift them a little.
    const boost = h > 200 ? ((h - 200) / 75) * 8 : 0;
    return `hsl(${h.toFixed(1)}, 100%, ${(light + boost).toFixed(1)}%)`;
  }

  // ------------------------------------------------------------- library ---

  const isFile = location.protocol === 'file:';
  const library = (window.KARAOKE_SONGS || []).map((m) => ({
    meta: Object.assign({}, m),
    files: null, // File objects when loaded through the folder picker
    status: 'idle',
    progress: 0,
    label: '',
    model: null,
    analysis: null,
    bytes: null,
    error: null,
  }));

  async function readSongInputs(song) {
    const m = song.meta;
    if (song.files) {
      return {
        csv: await song.files.timing.text(),
        lyrics: await song.files.lyrics.text(),
        bytes: await song.files.audio.arrayBuffer(),
        pitch: song.files.pitch ? JSON.parse(await song.files.pitch.text()) : null,
      };
    }
    const base = m.base || 'songs/';
    const get = async (name, kind) => {
      const r = await fetch(base + encodeURIComponent(name));
      if (!r.ok) throw new Error(`Could not load ${name} (${r.status})`);
      return kind === 'bin' ? r.arrayBuffer() : kind === 'json' ? r.json() : r.text();
    };
    // Optional high-quality pitch track next to the audio (see tools/).
    const pitchName = m.pitch || m.audio.replace(/\.[^.]+$/, '') + '.pitch.json';
    const [csv, lyrics, bytes, pitch] = await Promise.all([
      get(m.timing), get(m.lyrics), get(m.audio, 'bin'), get(pitchName, 'json').catch(() => null),
    ]);
    return { csv, lyrics, bytes, pitch };
  }

  // Analysis cache (beats + pitch are small) so songs start instantly later.
  function cacheKey(song) {
    return `aldak:analysis:v${ANALYSIS_VERSION}:${song.meta.id}:${song.bytes.byteLength}:${song.pitchTrack ? 'file' : 'live'}`;
  }
  function cacheGet(song) {
    try {
      const raw = localStorage.getItem(cacheKey(song));
      if (!raw) return null;
      const a = JSON.parse(raw);
      a.pitch = Float32Array.from(a.pitch, (v) => (v < 0 ? NaN : v / 100));
      a.wordPitch = a.wordPitch.map((v) => (v === null ? NaN : v));
      return a;
    } catch (e) {
      return null;
    }
  }
  function cachePut(song, a) {
    try {
      const enc = Object.assign({}, a, {
        pitch: Array.from(a.pitch, (v) => (isNaN(v) ? -1 : Math.round(v * 100))),
        beats: a.beats.map((v) => +v.toFixed(4)),
        beatStrength: a.beatStrength.map((v) => +v.toFixed(3)),
      });
      localStorage.setItem(cacheKey(song), JSON.stringify(enc));
    } catch (e) { /* storage full or unavailable: fine, we just recompute */ }
  }

  let worker = null;
  let workerFailed = isFile; // workers can't load from file:// pages
  let jobId = 0;
  function analyzeInWorker(samples, words, pitchTrack, onProgress) {
    if (!worker && !workerFailed) {
      try {
        worker = new Worker('js/dsp-worker.js');
      } catch (e) {
        workerFailed = true;
      }
    }
    if (!worker) return window.KaraokeDSP.analyze(samples, SAMPLE_RATE, words, onProgress, { pitchTrack });
    const id = ++jobId;
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (e.data.id !== id) return;
        if (e.data.type === 'progress') onProgress(e.data.fraction, e.data.label);
        else {
          worker.removeEventListener('message', onMsg);
          if (e.data.type === 'done') resolve(e.data.result);
          else reject(new Error(e.data.message));
        }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ id, samples, sampleRate: SAMPLE_RATE, words: words.map((w) => ({ start: w.start, end: w.end })), pitchTrack }, [samples.buffer]);
    });
  }

  const preparing = new Map();
  function prepareSong(song) {
    if (song.status === 'ready') return Promise.resolve(song);
    if (preparing.has(song)) return preparing.get(song);
    const p = (async () => {
      try {
        song.status = 'loading';
        song.label = 'Loading';
        song.error = null;
        renderMenu();
        if (!song.bytes) {
          const { csv, lyrics, bytes, pitch } = await readSongInputs(song);
          song.bytes = bytes;
          song.model = window.KaraokeLyrics.build(csv, lyrics);
          song.pitchFile = pitch && Array.isArray(pitch.midi) ? { hop: pitch.hop, midi: pitch.midi } : null;
        }
        song.pitchTrack = settings.pitch === 'file' ? song.pitchFile : null;
        let analysis = cacheGet(song);
        if (!analysis) {
          song.status = 'analyzing';
          song.label = 'Decoding audio';
          renderMenu();
          const off = new OfflineAudioContext(1, 1, SAMPLE_RATE);
          const buf = await off.decodeAudioData(song.bytes.slice(0));
          const mono = new Float32Array(buf.length);
          for (let c = 0; c < buf.numberOfChannels; c++) {
            const ch = buf.getChannelData(c);
            for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
          }
          analysis = await analyzeInWorker(mono, song.model.words, song.pitchTrack, (f, label) => {
            song.progress = f;
            song.label = label;
            renderMenu();
            if (current === song) updateLoading(song);
          });
          cachePut(song, analysis);
        }
        song.analysis = analysis;
        song.status = 'ready';
        song.label = `${Math.round(analysis.tempo)} beats per minute · pitch ${analysis.pitchSource === 'file' ? 'from pitch file' : 'estimated live'}`;
      } catch (err) {
        console.error(err);
        song.status = 'error';
        song.error = err.message || String(err);
      }
      preparing.delete(song);
      renderMenu();
      return song;
    })();
    preparing.set(song, p);
    return p;
  }

  async function prepareAllInBackground() {
    for (const song of library) {
      if (song.status === 'idle' && (!isFile || song.files)) await prepareSong(song);
    }
  }

  // --------------------------------------------------------- folder picker ---

  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|webm)$/i;
  function niceName(base) {
    return base.replace(/_-_/g, ' – ').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function addFolder(fileList) {
    const groups = new Map();
    for (const f of fileList) {
      const name = f.name;
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const isPitch = /\.pitch\.json$/i.test(name);
      const base = isPitch ? name.slice(0, -'.pitch.json'.length) : name.slice(0, dot);
      const g = groups.get(base) || {};
      if (isPitch) g.pitch = f;
      else if (AUDIO_EXT.test(name)) g.audio = f;
      else if (/\.csv$/i.test(name)) g.timing = f;
      else if (/\.txt$/i.test(name)) g.lyrics = f;
      groups.set(base, g);
    }
    let added = 0;
    for (const [base, g] of groups) {
      if (!g.audio || !g.timing || !g.lyrics) continue;
      let song = library.find((s) => s.meta.audio === g.audio.name);
      if (!song) {
        const nice = niceName(base);
        const parts = nice.split(' – ');
        song = {
          meta: {
            id: 'local-' + base,
            title: parts.length > 1 ? parts.slice(1).join(' – ') : nice,
            artist: parts.length > 1 ? parts[0] : '',
            audio: g.audio.name,
          },
          status: 'idle', progress: 0, label: '', model: null, analysis: null, bytes: null, error: null,
        };
        library.push(song);
        added++;
      }
      song.files = g;
      song.bytes = null;
      if (song.status === 'error') song.status = 'idle';
    }
    fileMode = true;
    renderMenu();
    prepareAllInBackground();
    return added;
  }

  // ------------------------------------------------------------------ menu ---

  let menuIndex = 0;
  let fileMode = false;
  let view = 'menu'; // 'menu' | 'player'

  function statusText(song) {
    switch (song.status) {
      case 'ready': return '✓ Ready · ' + song.label;
      case 'error': return '⚠ ' + song.error;
      case 'idle': return isFile && !song.files ? 'Choose the songs folder to load' : 'Waiting…';
      default: return `${song.label || 'Loading'}… ${Math.round(song.progress * 100)}%`;
    }
  }

  function renderMenu() {
    const list = $('#song-list');
    if (!list) return;
    list.innerHTML = '';
    library.forEach((song, i) => {
      const li = document.createElement('li');
      li.className = 'song-card' + (i === menuIndex ? ' selected' : '') + ' status-' + song.status;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === menuIndex ? 'true' : 'false');
      li.innerHTML = `
        <span class="song-num">${i + 1}</span>
        <span class="song-text">
          <span class="song-title"></span>
          <span class="song-artist"></span>
          <span class="song-status"></span>
        </span>
        <span class="song-go" aria-hidden="true">▶</span>`;
      li.querySelector('.song-title').textContent = song.meta.title;
      li.querySelector('.song-artist').textContent = song.meta.artist;
      li.querySelector('.song-status').textContent = statusText(song);
      li.addEventListener('click', () => { menuIndex = i; openSong(song); });
      list.appendChild(li);
    });
    $('#file-notice').hidden = !(isFile && !fileMode);
  }

  function showView(v) {
    view = v;
    $('#menu').hidden = v !== 'menu';
    $('#player').hidden = v !== 'player';
    document.body.classList.toggle('in-player', v === 'player');
  }

  // Decorative bouncing dot over the menu title letters.
  function menuDotLoop(now) {
    if (view === 'menu') {
      const letters = document.querySelectorAll('#menu-title .letter');
      const dot = $('#menu-dot');
      if (letters.length && dot) {
        const per = 0.42;
        const t = now / 1000;
        const n = letters.length;
        const k = Math.floor(t / per) % (2 * n - 2);
        const idx = k < n ? k : 2 * n - 2 - k;
        const nextK = (k + 1) % (2 * n - 2);
        const nIdx = nextK < n ? nextK : 2 * n - 2 - nextK;
        const u = (t % per) / per;
        const host = $('#menu-title').getBoundingClientRect();
        const a = letters[idx].getBoundingClientRect();
        const b = letters[nIdx].getBoundingClientRect();
        const x = lerp(a.left + a.width / 2, b.left + b.width / 2, u) - host.left;
        const y = -4 * 0.22 * a.height * u * (1 - u);
        const hue = (idx / (n - 1)) * 275;
        dot.style.transform = `translate(${x}px, ${y}px)`;
        dot.style.background = hueColor(lerp(hue, (nIdx / (n - 1)) * 275, u));
        dot.style.boxShadow = `0 0 0.5em ${hueColor(hue)}`;
        letters.forEach((l, i) => l.classList.toggle('lit', i === idx && u < 0.25));
      }
    }
    requestAnimationFrame(menuDotLoop);
  }

  // ---------------------------------------------------------------- player ---

  const audio = new window.KaraokeAudio();
  let current = null; // song being shown in the player
  let stage = null; // per-song render state
  let wakeLock = null;

  async function openSong(song) {
    if (isFile && !song.files) {
      $('#folder-input').click();
      return;
    }
    current = song;
    showView('player');
    $('#loading').hidden = false;
    $('#title-card').classList.remove('show');
    $('#end-card').classList.remove('show');
    $('#lyrics').innerHTML = '';
    updateLoading(song);
    await prepareSong(song);
    if (current !== song) return;
    if (song.status !== 'ready') {
      $('#loading-label').textContent = 'Sorry — this song could not be loaded: ' + song.error;
      return;
    }
    $('#loading-label').textContent = 'Getting the music ready…';
    await audio.load(song.bytes);
    if (current !== song) return;
    $('#loading').hidden = true;
    buildStage(song);
    showControls();
  }

  function updateLoading(song) {
    $('#loading-title').textContent = song.meta.title;
    $('#loading-label').textContent = `${song.label || 'Loading'}…`;
    $('#loading-bar').style.width = `${Math.round((song.progress || 0) * 100)}%`;
  }

  function closePlayer() {
    audio.stop();
    current = null;
    stage = null;
    releaseWakeLock();
    showView('menu');
    renderMenu();
  }

  // Build lyric DOM, timeline and dot landings for a song.
  function buildStage(song) {
    const { words, lines } = song.model;
    const an = song.analysis;
    const lyr = $('#lyrics');
    lyr.innerHTML = '';
    const lineEls = [];
    const wordEls = [];
    for (const line of lines) {
      const el = document.createElement('div');
      el.className = 'line future' + (line.verseStart ? ' verse-start' : '');
      line.words.forEach((wi, k) => {
        if (k) el.appendChild(document.createTextNode(' '));
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = words[wi].text;
        el.appendChild(span);
        wordEls[wi] = span;
      });
      lyr.appendChild(el);
      lineEls.push(el);
    }
    const countdown = document.createElement('div');
    countdown.id = 'countdown';
    lyr.appendChild(countdown);
    const trail = [];
    for (let i = 0; i < 7; i++) {
      const g = document.createElement('div');
      g.className = 'ghost';
      lyr.appendChild(g);
      trail.push(g);
    }
    const ball = document.createElement('div');
    ball.id = 'ball';
    ball.innerHTML = '<div class="ring"></div><div class="core"></div>';
    lyr.appendChild(ball);

    const firstStart = words.length ? words[0].start : 0;
    // Title shows over the intro; lyrics take over a few seconds before singing.
    const titleEnd = firstStart > 10 ? firstStart - 6 : Math.max(1.2, firstStart * 0.45);
    const beats = an.beats;
    const period = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;

    // When each line becomes the "current" line on screen.
    const lineSwitch = lines.map((line, i) => {
      if (i === 0) return -Infinity;
      const prevLast = words[lines[i - 1].words[lines[i - 1].words.length - 1]];
      let s = Math.min(line.start - 0.15, prevLast.end + 0.3);
      s = Math.max(s, (prevLast.start + prevLast.end) / 2);
      return Math.min(s, line.start);
    });

    // Dot landings: every word onset, plus beat-bounces through the intro and
    // instrumental gaps so the beat is always visible.
    const landings = [];
    const beatsIn = (a, b) => beats.filter((t) => t >= a && t <= b);
    if (words.length) {
      for (const t of beatsIn(titleEnd, firstStart - 0.18)) landings.push({ t, w: 0, beat: true });
    }
    words.forEach((w, i) => {
      landings.push({ t: w.start, w: i, beat: false });
      const next = words[i + 1];
      if (next && next.start - w.end > 1.6) {
        for (const t of beatsIn(w.end + 0.35, next.start - 0.18)) landings.push({ t, w: i + 1, beat: true });
      }
    });
    // Keep bouncing on the last word until the end card takes over.
    if (words.length) {
      const last = words[words.length - 1];
      for (const t of beatsIn(last.end + 0.35, last.end + 2.4)) landings.push({ t, w: words.length - 1, beat: true });
    }
    landings.sort((a, b) => a.t - b.t);

    // Count-in dots before lines that follow a long pause.
    const countdowns = [];
    lines.forEach((line, i) => {
      const prevEnd = i === 0 ? titleEnd : lines[i - 1].end;
      if (line.start - prevEnd < 3) return;
      const bs = beats.filter((t) => t < line.start - 0.1 && t > line.start - 4.6 * period).slice(-4);
      if (bs.length >= 2) countdowns.push({ line: i, beats: bs });
    });

    stage = {
      song, words, lines, an, lineEls, wordEls, ball, trail, countdown,
      titleEnd, lineSwitch, landings, countdowns, period,
      pos: [], lineTop: [], lineH: [],
      curLine: -1, scrollY: null, lastFrame: 0, landIdx: 0,
      activeWord: -1, sungUpTo: -1, colorMidi: NaN, trailPts: [],
      fontPx: 0,
    };

    $('#tc-title').textContent = song.meta.title;
    $('#tc-artist').textContent = song.meta.artist;
    $('#tc-credit').textContent = song.meta.credit || '';
    $('#ec-title').textContent = `“${song.meta.title}” · ${song.meta.artist}`;
    $('#ec-credit').textContent = song.meta.credit || '';
    applySungMode();
    layoutStage();
    // Ensure the start state is drawn (title card + "press play").
    stage.scrollY = null;
    render(0, true);
  }

  // Choose a font size so the current + next line always fit on screen.
  function layoutStage() {
    if (!stage) return;
    const vp = $('#lyrics-viewport');
    const H = vp.clientHeight;
    const lyr = $('#lyrics');
    const avail = H * 0.8;
    let size = H * 0.105 * settings.scale;
    for (let iter = 0; iter < 4; iter++) {
      lyr.style.fontSize = size + 'px';
      measure();
      let need = 0;
      for (let i = 0; i < stage.lines.length; i++) {
        const h = stage.lineH[i] + (i + 1 < stage.lines.length ? stage.lineTop[i + 1] - stage.lineTop[i] - stage.lineH[i] + stage.lineH[i + 1] : 0);
        if (h > need) need = h;
      }
      if (need <= avail) break;
      size *= Math.max(0.6, avail / need) * 0.98;
    }
    stage.fontPx = size;
    stage.scrollY = null;
  }

  function measure() {
    const lyr = $('#lyrics');
    const prev = lyr.style.transform;
    lyr.style.transform = 'none';
    const base = lyr.getBoundingClientRect();
    stage.lineTop = stage.lineEls.map((el) => el.offsetTop);
    stage.lineH = stage.lineEls.map((el) => el.offsetHeight);
    stage.pos = stage.wordEls.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
    });
    lyr.style.transform = prev;
  }

  function applySungMode() {
    document.body.dataset.sung = settings.sung;
    if (!stage) return;
    stage.wordEls.forEach((el, i) => {
      if (settings.sung === 'rainbow') {
        const p = stage.an.wordPitch[i];
        el.style.setProperty('--word-color', hueColor(pitchHue(p, stage.an.range), 70));
      } else {
        el.style.removeProperty('--word-color');
      }
    });
  }

  // ------------------------------------------------------------ rendering ---

  function bsearch(arr, t, key) {
    // index of last element with key <= t (or -1)
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((key ? arr[mid][key] : arr[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function landingPoint(L, along) {
    const p = stage.pos[L.w];
    if (!p) return { x: 0, y: 0 };
    const f = stage.fontPx;
    const u = along === undefined ? 0.3 : along;
    return { x: p.x + clamp(p.w * u, 0.12 * f, Math.max(0.12 * f, p.w - 0.12 * f)), y: p.y + 0.13 * f };
  }

  // Visual row of a word within its (possibly wrapped) line, 0 = first row.
  function wordRow(w) {
    const p = stage.pos[w];
    const first = stage.pos[stage.lines[stage.words[w].line].words[0]];
    return p && first ? Math.round((p.y - first.y) / (stage.fontPx * 1.55)) : 0;
  }

  // Position of the dot at time t: dwell on a word, then hop to the next.
  function dotPosition(t) {
    const Ls = stage.landings;
    const f = stage.fontPx;
    if (!Ls.length) return null;
    let i = bsearch(Ls, t, 't');
    if (i < 0) {
      const p = landingPoint(Ls[0]);
      return { x: p.x, y: p.y, sinceLand: Infinity };
    }
    const A = Ls[i];
    const B = Ls[i + 1];
    if (!B) {
      const w = stage.words[A.w];
      const u = clamp((t - w.start) / Math.max(0.2, w.end - w.start), 0, 1);
      const p = landingPoint(A, lerp(0.3, 0.7, u));
      return { x: p.x, y: p.y, sinceLand: t - A.t };
    }
    const d = B.t - A.t;
    const sameSpot = A.w === B.w;
    let hop = sameSpot ? d : d <= 0.42 ? d : Math.min(d, 0.42 + 0.25 * (d - 0.42), 0.85);
    const hopStart = B.t - hop;
    const slideEnd = sameSpot ? 0.3 : lerp(0.3, 0.7, clamp((hopStart - A.t) / 1.2, 0, 1));
    if (t < hopStart) {
      const u = (t - A.t) / Math.max(1e-3, hopStart - A.t);
      const p = landingPoint(A, lerp(0.3, slideEnd, u));
      return { x: p.x, y: p.y, sinceLand: t - A.t };
    }
    const p0 = landingPoint(A, slideEnd);
    const p1 = landingPoint(B, 0.3);
    const u = clamp((t - hopStart) / hop, 0, 1);
    let height = (sameSpot ? clamp(0.35 + 0.6 * hop, 0.35, 0.8) : clamp(0.3 + 0.8 * hop, 0.3, 1.0)) * f;
    // Over a wrapped line's lower rows there is text just above: keep the
    // bounce low so the dot never covers the row above.
    if (wordRow(A.w) > 0 || wordRow(B.w) > 0) height = Math.min(height, 0.3 * f);
    const x = lerp(p0.x, p1.x, u);
    const y = lerp(p0.y, p1.y, u) - 4 * height * u * (1 - u);
    return { x, y, sinceLand: t - A.t };
  }

  function targetPitch(t) {
    const { words, an } = stage;
    const wi = bsearch(words, t, 'start');
    if (wi < 0) return an.wordPitch.find((v) => !isNaN(v));
    const w = words[wi];
    let ref = an.wordPitch[wi];
    if (isNaN(ref)) return NaN;
    if (t > w.end) return ref;
    const fp = an.pitch[Math.round(t / an.pitchHop)];
    if (fp === undefined || isNaN(fp)) return ref;
    let v = fp;
    while (v - ref > 6) v -= 12;
    while (ref - v > 6) v += 12;
    return clamp(v, ref - 3, ref + 3);
  }

  function render(t, force) {
    const s = stage;
    if (!s) return;
    const now = performance.now();
    const dt = s.lastFrame ? Math.min(0.1, (now - s.lastFrame) / 1000) : 0;
    s.lastFrame = now;
    const { words, lines } = s;
    const started = audio.playing || t > 0.01;
    if (s.lastT === undefined || Math.abs(t - s.lastT) > 0.3) s.trailPts.length = 0; // seek: drop old trail
    s.lastT = t;

    // Title / end cards.
    const lastEnd = words.length ? words[words.length - 1].end : 0;
    const showTitle = !started || t < s.titleEnd;
    $('#title-card').classList.toggle('show', showTitle);
    $('#tc-hint').hidden = started;
    const ended = t > lastEnd + 2.5;
    $('#end-card').classList.toggle('show', ended);
    $('#lyrics').classList.toggle('hidden', showTitle || ended);

    // Current line and scroll.
    let cur = 0;
    for (let i = 1; i < lines.length; i++) if (t >= s.lineSwitch[i]) cur = i;
    if (cur !== s.curLine) {
      s.lineEls.forEach((el, i) => {
        const d = i - cur;
        el.className = 'line ' + (d < 0 ? 'past' : d === 0 ? 'current' : d === 1 ? 'next' : d === 2 ? 'next2' : 'future') + (lines[i].verseStart ? ' verse-start' : '');
      });
      s.curLine = cur;
    }
    const H = $('#lyrics-viewport').clientHeight;
    const target = H * 0.17 - s.lineTop[cur];
    if (s.scrollY === null || force || Math.abs(target - s.scrollY) > H) s.scrollY = target;
    else s.scrollY += (target - s.scrollY) * (1 - Math.exp(-dt / 0.11));
    $('#lyrics').style.transform = `translate3d(0, ${s.scrollY.toFixed(1)}px, 0)`;

    // Words: sung / active wipe.
    let active = -1;
    const wi = bsearch(words, t, 'start');
    if (wi >= 0 && t < words[wi].end) active = wi;
    const sungUpTo = wi >= 0 ? (active === wi ? wi - 1 : wi) : -1;
    if (sungUpTo !== s.sungUpTo || force) {
      const lo = Math.min(sungUpTo, s.sungUpTo);
      const hi = Math.max(sungUpTo, s.sungUpTo);
      for (let k = force ? 0 : Math.max(0, lo); k <= (force ? words.length - 1 : hi); k++) {
        if (k >= 0) s.wordEls[k].classList.toggle('sung', k <= sungUpTo);
      }
      s.sungUpTo = sungUpTo;
    }
    if (active !== s.activeWord) {
      if (s.activeWord >= 0) s.wordEls[s.activeWord].classList.remove('active');
      if (active >= 0) s.wordEls[active].classList.add('active');
      s.activeWord = active;
    }
    if (active >= 0) {
      const w = words[active];
      const p = clamp((t - w.start) / (w.end - w.start), 0, 1);
      s.wordEls[active].style.setProperty('--p', (p * 100).toFixed(1) + '%');
    }

    // Beat pulse.
    const beats = s.an.beats;
    const bi = bsearch(beats, t);
    const sinceBeat = bi >= 0 ? t - beats[bi] : Infinity;
    const strength = bi >= 0 ? s.an.beatStrength[bi] : 0;
    const pulse = started ? strength * Math.exp(-sinceBeat / 0.13) : 0;

    // Pitch color (smoothed).
    const tp = targetPitch(t);
    if (!isNaN(tp)) {
      if (isNaN(s.colorMidi) || force) s.colorMidi = tp;
      else s.colorMidi += (tp - s.colorMidi) * (1 - Math.exp(-dt / 0.06));
    }
    const hue = pitchHue(s.colorMidi, s.an.range);
    const color = hueColor(hue);

    // Dot.
    const f = s.fontPx;
    const r = 0.19 * f;
    const pos = dotPosition(t);
    const visible = pos && !showTitle && !ended;
    s.ball.style.opacity = visible ? '1' : '0';
    if (pos) {
      const squashK = pos.sinceLand < 0.09 ? 1 - pos.sinceLand / 0.09 : 0;
      const scale = 1 + 0.5 * pulse;
      const sx = scale * (1 + 0.14 * squashK);
      const sy = scale * (1 - 0.2 * squashK);
      s.ball.style.width = s.ball.style.height = 2 * r + 'px';
      s.ball.style.transform = `translate3d(${(pos.x - r).toFixed(1)}px, ${(pos.y - 2 * r).toFixed(1)}px, 0) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
      s.ball.style.transformOrigin = '50% 100%';
      const core = s.ball.firstChild.nextSibling;
      core.style.background = `radial-gradient(circle at 35% 30%, #fff 0%, ${hueColor(hue, 82)} 18%, ${color} 55%, ${hueColor(hue, 38)} 100%)`;
      core.style.boxShadow = `0 0 ${(0.25 + 0.5 * pulse) * f}px ${(0.04 + 0.12 * pulse) * f}px ${color}`;
      const ring = s.ball.firstChild;
      const ru = clamp(sinceBeat / 0.45, 0, 1);
      ring.style.borderColor = color;
      ring.style.opacity = started && ru < 1 ? (0.85 * (1 - ru) * strength).toFixed(3) : '0';
      ring.style.transform = `scale(${(1 + 1.8 * ru).toFixed(3)})`;

      // Comet trail.
      s.trailPts.unshift({ x: pos.x, y: pos.y - r, c: color });
      if (s.trailPts.length > 24) s.trailPts.length = 24;
      s.trail.forEach((g, k) => {
        const pt = s.trailPts[(k + 1) * 3];
        if (!settings.trail || !visible || !pt || !audio.playing) {
          g.style.opacity = '0';
          return;
        }
        const gr = r * (0.75 - k * 0.08);
        g.style.width = g.style.height = 2 * gr + 'px';
        g.style.background = pt.c;
        g.style.opacity = (0.32 - k * 0.042).toFixed(3);
        g.style.transform = `translate3d(${(pt.x - gr).toFixed(1)}px, ${(pt.y - gr).toFixed(1)}px, 0)`;
      });
    }

    // Count-in dots.
    let cdHtml = '';
    for (const cd of s.countdowns) {
      const line = lines[cd.line];
      if (t < cd.beats[0] - s.period * 1.2 || t >= line.start) continue;
      const remaining = cd.beats.filter((b) => b > t).length;
      if (remaining === 0) continue;
      const p = s.pos[line.words[0]];
      const dotsW = 4 * 0.42 * f;
      let x = p.x - dotsW - 0.35 * f;
      let y = p.y + p.h * 0.5 - 0.11 * f;
      if (x < 0) { x = p.x; y = p.y - 0.42 * f; }
      s.countdown.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      for (let k = 0; k < 4; k++) cdHtml += `<span class="cd${k < 4 - remaining ? ' gone' : ''}"></span>`;
      break;
    }
    if (s.countdown.innerHTML !== cdHtml) s.countdown.innerHTML = cdHtml;
    s.countdown.style.fontSize = f + 'px';

    if (showTitle) renderMusicMeter($('#tc-meter'), t, 'intro', started);
    if (ended) renderMusicMeter($('#ec-meter'), t, 'outro', started);

    // Progress.
    $('#progress-fill').style.width = `${(100 * t) / Math.max(1, audio.duration)}%`;
    $('#time').textContent = `${fmtTime(t)} / ${fmtTime(audio.duration)}`;
  }

  // Loudness 0..1 at time t (max over ~0.25 s so short dips don't freeze the dot).
  function loudnessAt(t) {
    const an = stage.an;
    if (!an.loudness) return 1;
    const i = Math.floor(t / an.loudHop);
    let m = 0;
    for (let k = i - 2; k <= i + 2; k++) if (an.loudness[k] > m) m = an.loudness[k];
    return m;
  }

  // Last moment the music is clearly audible (fade-outs end in silence).
  function musicEndTime() {
    const an = stage.an;
    if (stage.musicEnd !== undefined) return stage.musicEnd;
    let end = audio.duration;
    if (an.loudness) {
      for (let i = an.loudness.length - 1; i >= 0; i--) {
        if (an.loudness[i] >= 0.2) { end = (i + 1) * an.loudHop; break; }
      }
    }
    stage.musicEnd = end;
    return end;
  }

  /**
   * Title/end-card dot: bounces on the beat while music plays (higher when
   * louder) and rests when the music is quiet, paused or over — so the screen
   * never looks frozen while only instruments are playing.
   */
  function renderMusicMeter(el, t, mode, started) {
    const dot = el.querySelector('.music-dot');
    const ring = dot.firstChild;
    const label = el.querySelector('.music-label');
    el.classList.toggle('idle', !started);
    const finished = mode === 'outro' && (t >= musicEndTime() || (!audio.playing && t >= audio.duration - 0.1));
    const loud = audio.playing && !finished ? loudnessAt(t) : 0;
    const beats = stage.an.beats;
    const bi = bsearch(beats, t);
    let y = 0, pulse = 0, squash = 0, ringU = 1;
    if (bi >= 0 && bi < beats.length - 1 && loud > 0.05) {
      const b0 = beats[bi], b1 = beats[bi + 1];
      const u = clamp((t - b0) / (b1 - b0), 0, 1);
      const H = el.clientHeight * 0.42;
      y = -4 * H * clamp(loud * 1.15, 0, 1) * u * (1 - u);
      const since = t - b0;
      pulse = stage.an.beatStrength[bi] * loud * Math.exp(-since / 0.13);
      squash = since < 0.09 ? 1 - since / 0.09 : 0;
      ringU = clamp(since / 0.45, 0, 1);
    }
    const sc = 1 + 0.45 * pulse;
    dot.style.transform = `translateY(${y.toFixed(1)}px) scale(${(sc * (1 + 0.14 * squash)).toFixed(3)}, ${(sc * (1 - 0.2 * squash)).toFixed(3)})`;
    dot.firstChild.nextSibling.style.boxShadow = `0 0 ${(1 + 2.5 * pulse).toFixed(2)}vh ${(0.2 + 0.6 * pulse).toFixed(2)}vh rgba(255, 210, 63, ${(0.35 + 0.5 * loud).toFixed(2)})`;
    ring.style.opacity = ringU < 1 ? (0.8 * (1 - ringU) * loud).toFixed(3) : '0';
    ring.style.transform = `scale(${(1 + 1.6 * ringU).toFixed(3)})`;

    let text = '';
    if (!started) text = '';
    else if (finished) text = 'Song finished';
    else if (!audio.playing) text = '❚❚ Paused';
    else if (mode === 'intro') {
      const first = stage.words.length ? stage.words[0].start : 0;
      text = `♪ Music intro · singing starts in ${Math.max(1, Math.ceil(first - t))} s`;
    } else text = '♪ Music still playing';
    if (label.textContent !== text) label.textContent = text;
  }

  function fmtTime(t) {
    t = Math.max(0, Math.floor(t));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  function songTime() {
    return audio.time() - settings.syncMs / 1000;
  }

  function frame() {
    if (view === 'player' && stage) {
      render(songTime(), false);
      updateControlsVisibility();
      if (audio.playing !== frame.wasPlaying) { frame.wasPlaying = audio.playing; updatePlayButton(); }
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------- controls ---

  // Controls show on activity and hide again after a few idle seconds of playback.
  let lastActivity = 0;
  function showControls() {
    lastActivity = performance.now();
    document.body.classList.add('controls-visible');
  }
  function updateControlsVisibility() {
    const idle = performance.now() - lastActivity > 2600;
    document.body.classList.toggle('controls-visible', !(audio.playing && idle));
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* not available */ }
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  async function togglePlay() {
    if (!stage) return;
    if (audio.playing) {
      audio.pause();
      document.body.classList.add('controls-visible');
    } else {
      if ($('#end-card').classList.contains('show')) await audio.seek(0);
      await audio.play();
      requestWakeLock();
      showControls();
    }
    updatePlayButton();
  }
  function updatePlayButton() {
    const b = $('#btn-play');
    b.textContent = audio.playing ? '❚❚' : '▶';
    b.setAttribute('aria-label', audio.playing ? 'Pause' : 'Play');
  }
  async function seekBy(d) {
    if (!stage) return;
    await audio.seek(audio.time() + d);
    stage.scrollY = null;
    render(songTime(), true);
    toast(d > 0 ? `+${d} s` : `${d} s`);
  }
  async function restart() {
    if (!stage) return;
    await audio.seek(0);
    stage.scrollY = null;
    render(songTime(), true);
  }
  function changeScale(d) {
    settings.scale = clamp(+(settings.scale + d).toFixed(2), 0.6, 1.6);
    saveSettings();
    layoutStage();
    toast(`Text size ${Math.round(settings.scale * 100)}%`);
  }
  function changeSync(d) {
    settings.syncMs = clamp(settings.syncMs + d, -1000, 1000);
    saveSettings();
    toast(`Lyrics ${settings.syncMs === 0 ? 'in sync (0 ms)' : settings.syncMs > 0 ? `${settings.syncMs} ms later` : `${-settings.syncMs} ms earlier`}`);
  }
  function cycleSung() {
    settings.sung = SUNG_MODES[(SUNG_MODES.indexOf(settings.sung) + 1) % SUNG_MODES.length];
    saveSettings();
    applySungMode();
    toast(`Sung words: ${SUNG_LABEL[settings.sung]}`);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  async function togglePitchSource() {
    if (!current) return;
    settings.pitch = settings.pitch === 'file' ? 'live' : 'file';
    saveSettings();
    if (settings.pitch === 'file' && !current.pitchFile) {
      toast('No pitch file for this song — using live pitch');
    } else {
      toast(settings.pitch === 'file' ? 'Dot color: pitch file' : 'Dot color: live pitch estimate');
    }
    // Re-analyze the current song (others pick it up when opened).
    const song = current;
    const t = audio.time();
    const wasPlaying = audio.playing;
    audio.pause();
    for (const s2 of library) if (s2.status === 'ready') s2.status = 'idle';
    $('#loading').hidden = false;
    updateLoading(song);
    await prepareSong(song);
    if (current !== song) return;
    $('#loading').hidden = true;
    buildStage(song);
    await audio.seek(t);
    if (wasPlaying) await audio.play();
    updatePlayButton();
  }

  function nextSong() {
    const i = library.indexOf(current);
    const nxt = library[(i + 1) % library.length];
    audio.stop();
    updatePlayButton();
    menuIndex = library.indexOf(nxt);
    openSong(nxt);
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'f' || k === 'F') { toggleFullscreen(); e.preventDefault(); return; }
    if (k === '?' || k === 'h' || k === 'H') { $('#help').classList.toggle('show'); e.preventDefault(); return; }
    if (view === 'menu') {
      if (k === 'ArrowDown') { menuIndex = (menuIndex + 1) % library.length; renderMenu(); }
      else if (k === 'ArrowUp') { menuIndex = (menuIndex - 1 + library.length) % library.length; renderMenu(); }
      else if (k === 'Enter' || k === ' ') { if (library[menuIndex]) openSong(library[menuIndex]); }
      else if (/^[1-9]$/.test(k) && library[+k - 1]) { menuIndex = +k - 1; renderMenu(); openSong(library[menuIndex]); }
      else return;
      e.preventDefault();
      return;
    }
    showControls();
    switch (k) {
      case ' ': case 'k': case 'K': case 'Enter':
        if (k === 'Enter' && $('#end-card').classList.contains('show')) nextSong();
        else togglePlay();
        break;
      case 'ArrowLeft': seekBy(e.shiftKey ? -15 : -5); break;
      case 'ArrowRight': seekBy(e.shiftKey ? 15 : 5); break;
      case 'Home': case '0': restart(); break;
      case 'Escape': if ($('#help').classList.contains('show')) $('#help').classList.remove('show'); else closePlayer(); break;
      case '+': case '=': changeScale(0.1); break;
      case '-': case '_': changeScale(-0.1); break;
      case ']': changeSync(25); break;
      case '[': changeSync(-25); break;
      case 'c': case 'C': cycleSung(); break;
      case 't': case 'T': settings.trail = !settings.trail; saveSettings(); toast(`Dot trail ${settings.trail ? 'on' : 'off'}`); break;
      case 'n': case 'N': nextSong(); break;
      case 'p': case 'P': togglePitchSource(); break;
      default: return;
    }
    e.preventDefault();
  }

  // ------------------------------------------------------------------ init ---

  function init() {
    // Split menu title into letters for the bouncing dot.
    const mt = $('#menu-title');
    const word = mt.textContent.trim();
    mt.innerHTML = '<span id="menu-dot" aria-hidden="true"></span>' + [...word].map((c) => `<span class="letter">${c}</span>`).join('');
    mt.setAttribute('aria-label', word);

    $('#folder-input').addEventListener('change', (e) => {
      const n = addFolder(e.target.files);
      if (n) toast(`Added ${n} song${n === 1 ? '' : 's'}`);
      e.target.value = '';
    });
    document.querySelectorAll('[data-pick-folder]').forEach((b) => b.addEventListener('click', () => $('#folder-input').click()));

    $('#btn-play').addEventListener('click', togglePlay);
    $('#btn-back').addEventListener('click', () => seekBy(-5));
    $('#btn-fwd').addEventListener('click', () => seekBy(5));
    $('#btn-restart').addEventListener('click', restart);
    $('#btn-menu').addEventListener('click', closePlayer);
    $('#btn-smaller').addEventListener('click', () => changeScale(-0.1));
    $('#btn-bigger').addEventListener('click', () => changeScale(0.1));
    $('#btn-earlier').addEventListener('click', () => changeSync(-25));
    $('#btn-later').addEventListener('click', () => changeSync(25));
    $('#btn-color').addEventListener('click', cycleSung);
    $('#btn-full').addEventListener('click', toggleFullscreen);
    $('#btn-help').addEventListener('click', () => $('#help').classList.toggle('show'));
    $('#help').addEventListener('click', () => $('#help').classList.remove('show'));
    $('#ec-next').addEventListener('click', nextSong);
    $('#ec-menu').addEventListener('click', closePlayer);
    $('#tc-start').addEventListener('click', togglePlay);
    $('#progress').addEventListener('click', async (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      await audio.seek(((e.clientX - r.left) / r.width) * audio.duration);
      if (stage) { stage.scrollY = null; render(songTime(), true); }
    });

    audio.onended = () => {
      updatePlayButton();
      releaseWakeLock();
      document.body.classList.add('controls-visible');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousemove', () => { if (view === 'player') showControls(); });
    window.addEventListener('resize', () => { if (stage) { layoutStage(); render(songTime(), true); } });
    document.fonts && document.fonts.ready.then(() => { if (stage) layoutStage(); });

    showView('menu');
    renderMenu();
    requestAnimationFrame(frame);
    requestAnimationFrame(menuDotLoop);
    if (!isFile) prepareAllInBackground();

    // Testing hook: ?song=N opens a song directly.
    const q = new URLSearchParams(location.search);
    if (q.get('song')) {
      const s = library[+q.get('song') - 1];
      if (s) { menuIndex = library.indexOf(s); openSong(s); }
    }
    window.__karaoke = { audio, library, get stage() { return stage; }, render, settings, dotPosition, landingPoint };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
