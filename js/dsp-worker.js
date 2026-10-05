/* Runs the audio analysis off the main thread so the screen stays smooth. */
importScripts('dsp.js');

self.onmessage = async (e) => {
  const { id, samples, sampleRate, words, pitchTrack } = e.data;
  try {
    const result = await self.KaraokeDSP.analyze(samples, sampleRate, words, (fraction, label) => {
      self.postMessage({ id, type: 'progress', fraction, label });
    }, { pitchTrack });
    self.postMessage({ id, type: 'done', result }, [result.pitch.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
