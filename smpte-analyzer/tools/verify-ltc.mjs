import { readFileSync } from "node:fs";
import { MultiRateDecoder, tcString } from "../src/ltcDecoder.js";
import { performance } from "node:perf_hooks";

function parseWav(buf) {
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const dataOff = 44;
  const n = (buf.length - dataOff) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  return { samples: out, sampleRate, bits };
}

let now = 1000;
performance.now = () => now;

const files = ["ltc_24","ltc_25","ltc_2997df","ltc_2997ndf","ltc_30","ltc_50","ltc_5994df","ltc_60"];
const CHUNK = 2048;
for (const f of files) {
  const { samples, sampleRate } = parseWav(readFileSync(new URL(`./out/${f}.wav`, import.meta.url)));
  now = 1000;
  const mrd = new MultiRateDecoder();
  let firstTc=null,lastTc=null;
  for (let off=0; off<samples.length; off+=CHUNK){
    const end=Math.min(off+CHUNK,samples.length);
    const t0=now; now+=((end-off)/sampleRate)*1000;
    mrd.feed(samples.subarray(off,end),sampleRate,t0,now);
    const lf=mrd.lastFrame;
    if(lf){if(!firstTc)firstTc=tcString(lf);lastTc=tcString(lf);}
  }
  const cad=mrd.cadence();
  console.log(`${f.padEnd(12)} key=${String(mrd.detectedRateKey()).padEnd(9)} cadFps=${cad?.fps} df=${cad?.dropFrame} first=${firstTc} last=${lastTc}`);
}
