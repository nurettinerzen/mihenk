// embed.mjs — Yerel çok dilli embedding (anahtarsız). Sorgu ve korpus aynı uzayda.
// Model: paraphrase-multilingual-MiniLM-L12-v2 (384 boyut, TR+AR dahil 50+ dil).

import { pipeline } from '@huggingface/transformers';

export const DIM = 384;
let _e = null;

export async function embedder() {
  if (!_e) {
    process.env.TRANSFORMERS_VERBOSITY = 'error';
    _e = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  }
  return _e;
}

export async function embedOne(text) {
  const e = await embedder();
  const o = await e(text, { pooling: 'mean', normalize: true });
  return o.data; // Float32Array(384), normalize edilmiş
}

// Dizi → [n*DIM] düz Float32Array (satır satır normalize vektörler)
export async function embedBatch(arr) {
  const e = await embedder();
  const o = await e(arr, { pooling: 'mean', normalize: true });
  return o.data;
}

// İki normalize vektörün kosinüs benzerliği (nokta çarpım).
export function cos(a, aOff, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[aOff + i] * b[i];
  return s;
}
