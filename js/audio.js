/*
 * ALDAcon Karaoke — audio playback with a sample-accurate song clock.
 *
 * Plays a decoded AudioBuffer through Web Audio and reports the song
 * position of the sound *currently coming out of the speakers* (using the
 * output timestamp, which accounts for output latency), so the lyrics and
 * the bouncing dot stay locked to what people hear.
 */
(function (root) {
  'use strict';

  class KaraokeAudio {
    constructor() {
      this.ctx = null;
      this.buffer = null;
      this.src = null;
      this.playing = false;
      this.offset = 0; // song position while paused
      this.startCtx = 0; // context time at which playback (re)started
      this.startOffset = 0; // song position at startCtx
      this.lastT = 0;
      this.onended = null;
    }

    context() {
      if (!this.ctx) {
        // iOS mutes Web Audio while the phone is in silent mode unless the page
        // says it is a media player (Audio Session API, Safari 16.4+).
        try {
          if (root.navigator && navigator.audioSession) navigator.audioSession.type = 'playback';
        } catch (e) { /* not supported */ }
        const AC = root.AudioContext || root.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'playback' });
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      }
      return this.ctx;
    }

    async load(arrayBuffer) {
      this.stop();
      this.buffer = await this.context().decodeAudioData(arrayBuffer.slice(0));
      this.offset = 0;
      this.lastT = 0;
    }

    get duration() {
      return this.buffer ? this.buffer.duration : 0;
    }

    async play() {
      if (!this.buffer || this.playing) return;
      const ctx = this.context();
      if (ctx.state !== 'running') await ctx.resume();
      if (this.offset >= this.buffer.duration - 0.05) this.offset = 0;
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.connect(this.gain);
      const when = ctx.currentTime + 0.03;
      this.gain.gain.cancelScheduledValues(when);
      this.gain.gain.setValueAtTime(0, when);
      this.gain.gain.linearRampToValueAtTime(1, when + 0.02);
      src.start(when, this.offset);
      src.onended = () => {
        if (this.src !== src) return;
        this.src = null;
        this.playing = false;
        this.offset = this.buffer.duration;
        if (this.onended) this.onended();
      };
      this.src = src;
      this.startCtx = when;
      this.startOffset = this.offset;
      this.lastT = this.offset;
      this.playing = true;
    }

    pause() {
      if (!this.playing) return;
      this.offset = Math.min(this.duration, this.time());
      this._stopSource();
    }

    stop() {
      this._stopSource();
      this.offset = 0;
      this.lastT = 0;
    }

    _stopSource() {
      if (this.src) {
        const src = this.src;
        this.src = null;
        const t = this.ctx.currentTime;
        this.gain.gain.cancelScheduledValues(t);
        this.gain.gain.setValueAtTime(this.gain.gain.value, t);
        this.gain.gain.linearRampToValueAtTime(0, t + 0.02);
        try { src.stop(t + 0.025); } catch (e) { /* already stopped */ }
      }
      this.playing = false;
    }

    async seek(t) {
      t = Math.max(0, Math.min(this.duration - 0.05, t));
      const wasPlaying = this.playing;
      this._stopSource();
      this.offset = t;
      this.lastT = t;
      if (wasPlaying) await this.play();
    }

    /** Song position (seconds) of the audio currently audible. */
    time() {
      if (!this.playing) return this.offset;
      const ctx = this.ctx;
      let now = ctx.currentTime;
      if (ctx.getOutputTimestamp) {
        const ts = ctx.getOutputTimestamp();
        if (ts.contextTime > 0 && ts.performanceTime > 0) {
          now = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        }
      }
      let t = this.startOffset + Math.max(0, now - this.startCtx);
      // Never step backwards because of clock jitter.
      if (t < this.lastT && this.lastT - t < 0.05) t = this.lastT;
      this.lastT = t;
      return t;
    }
  }

  root.KaraokeAudio = KaraokeAudio;
})(typeof window !== 'undefined' ? window : globalThis);
