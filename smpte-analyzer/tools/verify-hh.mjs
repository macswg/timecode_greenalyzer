import { readFileSync } from "node:fs";
import { MultiRateDecoder, tcString } from "../src/ltcDecoder.js";
import { performance } from "node:perf_hooks";
function parseWav(buf){const sr=buf.readUInt32LE(24);const n=(buf.length-44)/2;const o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=buf.readInt16LE(44+i*2)/32768;return{samples:o,sampleRate:sr};}
let now=1000; performance.now=()=>now;
const files=["ltc_30nd_0130","ltc_30nd_1200","ltc_30nd_2330"];
const CHUNK=2048;
for(const f of files){
  const {samples,sampleRate}=parseWav(readFileSync(new URL(`./generated_tc/${f}.wav`,import.meta.url)));
  now=1000; const mrd=new MultiRateDecoder(); let first=null,last=null;
  for(let off=0;off<samples.length;off+=CHUNK){const end=Math.min(off+CHUNK,samples.length);const t0=now;now+=((end-off)/sampleRate)*1000;mrd.feed(samples.subarray(off,end),sampleRate,t0,now);const lf=mrd.lastFrame;if(lf){if(!first)first=tcString(lf);last=tcString(lf);}}
  const cad=mrd.cadence();
  const dur=(samples.length/sampleRate).toFixed(1);
  console.log(`${f.padEnd(16)} key=${String(mrd.detectedRateKey()).padEnd(5)} df=${cad?.dropFrame} dur=${dur}s first=${first} last=${last}`);
}
