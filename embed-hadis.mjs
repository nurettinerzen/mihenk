// embed-hadis.mjs — corpus.json hadislerini (TR + EN) embed'ler → vektor-hadis-{dil}.f32
// Konu araması semantik olsun diye. Tek seferlik/offline. ~13 dk (30k × 2 dil).

import { readFileSync, writeFileSync } from 'node:fs';
import { embedBatch, DIM } from './embed.mjs';

const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));
const N = corpus.length;
const B = 64;

for (const dil of ['tr', 'en']) {
  const out = new Float32Array(N * DIM);
  console.log(`\n[${dil}] ${N} hadis embed'leniyor...`);
  const t0 = Date.now();
  for (let i = 0; i < N; i += B) {
    const grup = corpus.slice(i, i + B).map(h => (h[dil] || h.tr || '').slice(0, 500));
    const v = await embedBatch(grup);
    out.set(v, i * DIM);
    if (i % (B * 20) === 0) process.stdout.write(`\r  ${Math.min(i + B, N)}/${N} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  writeFileSync(new URL(`./vektor-hadis-${dil}.f32`, import.meta.url), Buffer.from(out.buffer));
  console.log(`\n  vektor-hadis-${dil}.f32 (${(out.byteLength / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log('\nBİTTİ.');
