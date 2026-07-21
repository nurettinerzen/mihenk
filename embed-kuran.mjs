// embed-kuran.mjs — ayat meallerini embed'leyip vektor-kuran-{dil}.f32 (binary) yazar.
// Her dil için ayrı vektör (TR meal + EN meal). Tek seferlik/offline.

import { readFileSync, writeFileSync } from 'node:fs';
import { embedBatch, DIM } from './embed.mjs';

const ayat = JSON.parse(readFileSync(new URL('./ayat.json', import.meta.url), 'utf8'));
const N = ayat.length;
const B = 64;

for (const dil of ['tr', 'en']) {
  const out = new Float32Array(N * DIM);
  console.log(`\n[${dil}] ${N} ayet embed'leniyor...`);
  const t0 = Date.now();
  for (let i = 0; i < N; i += B) {
    const grup = ayat.slice(i, i + B).map(a => a[dil] || a.tr);
    const v = await embedBatch(grup);
    out.set(v, i * DIM);
    if (i % (B * 10) === 0) process.stdout.write(`\r  ${Math.min(i + B, N)}/${N}`);
  }
  const dosya = new URL(`./vektor-kuran-${dil}.f32`, import.meta.url);
  writeFileSync(dosya, Buffer.from(out.buffer));
  console.log(`\n  vektor-kuran-${dil}.f32 (${(out.byteLength / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
