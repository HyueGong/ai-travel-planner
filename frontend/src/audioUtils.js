// frontend/src/audioUtils.js

export function createWavBlobFromFloat32(float32Data, sampleRate) {
  const numChannels = 1;
  const format = 1; // PCM
  const bitDepth = 16;

  const output = float32Data;
  const buffer = new ArrayBuffer(44 + output.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + output.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  view.setUint16(32, numChannels * (bitDepth / 8), true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, output.length * 2, true);

  const offset = 44;
  for (let i = 0; i < output.length; i++) {
    const s = Math.max(-1, Math.min(1, output[i]));
    view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([view], { type: 'audio/wav' });
}

export async function resampleTo16kHQ(float32Data, sourceSampleRate) {
  const targetRate = 16000;
  if (sourceSampleRate === targetRate) return float32Data;
  const lengthInSeconds = float32Data.length / sourceSampleRate;
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(lengthInSeconds * targetRate), targetRate);
  const buffer = offlineCtx.createBuffer(1, float32Data.length, sourceSampleRate);
  buffer.copyToChannel(float32Data, 0);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0).slice();
}

export function normalizeAudio(float32Data) {
  let max = 0;
  for (let i = 0; i < float32Data.length; i++) {
    const v = Math.abs(float32Data[i]);
    if (v > max) max = v;
  }
  if (max < 1e-6) return float32Data;
  const targetPeak = 0.7071; // -3dBFS ≈ 0.7071
  const gain = targetPeak / max;
  const out = new Float32Array(float32Data.length);
  for (let i = 0; i < float32Data.length; i++) out[i] = float32Data[i] * gain;
  return out;
}

export function trimSilence(float32Data, sampleRate, threshold = 0.01, minSilenceMs = 150) {
  const minSilenceSamples = Math.floor((minSilenceMs / 1000) * sampleRate);
  let start = 0;
  let end = float32Data.length - 1;

  let count = 0;
  for (let i = 0; i < float32Data.length; i++) {
    if (Math.abs(float32Data[i]) < threshold) {
      count++;
    } else {
      if (count >= minSilenceSamples) start = i;
      break;
    }
  }

  count = 0;
  for (let i = float32Data.length - 1; i >= 0; i--) {
    if (Math.abs(float32Data[i]) < threshold) {
      count++;
    } else {
      if (count >= minSilenceSamples) end = i;
      break;
    }
  }

  if (end <= start) return float32Data;
  return float32Data.slice(start, end + 1);
}


