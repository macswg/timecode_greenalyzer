// Shared WAV writer for the one-off generator scripts in this folder.
// Float32 [-1,1] -> 16-bit PCM mono WAV (RIFF). Standard, maximally compatible
// (Windows Media Player, foobar2000, VLC, Audacity) and re-ingestible by the
// analyzer's "ANALYZE FILE…" drop zone.
export function float32ToWav(samples, sampleRate) {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);          // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);           // audio format = PCM
  buf.writeUInt16LE(1, 22);           // channels = 1
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (1ch * 2 bytes)
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2);
  }
  return buf;
}
