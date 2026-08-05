// embed.mjs — Yerel çok dilli embedding (anahtarsız), 512 MB instance bütçesine göre.
// Model: paraphrase-multilingual-MiniLM-L12-v2 (384 boyut, TR+AR dahil 50+ dil).
//
// ESKİ sürüm @huggingface/transformers pipeline'ıyla ~860 MB RSS tutuyordu (fp32
// ağırlıklar + JS tokenizer + ORT arena) ve Standard (2 GB) plan gerektiriyordu.
// YENİ kurulum: q8 ONNX + doğrudan onnxruntime-node (arena kapalı) + kompakt
// sentencepiece tokenizer (sp-tokenizer.mjs) → ~300 MB. Sorgu/korpus aynı uzayda:
// tokenizasyon diff testinde 21.940/21.940 örnekte birebir; q8 kuantizasyonun
// sıralamaya etkisi ihmal düzeyinde (cos > 0.99).

import { existsSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { SpTokenizer } from './sp-tokenizer.mjs';

export const DIM = 384;
const yol = (f) => new URL(`./${f}`, import.meta.url).pathname;
const MODEL_ONNX = process.env.MODEL_ONNX || [
  yol('model/model_quantized.onnx'),
  // yerel geliştirme: transformers önbelleğindeki kopya
  yol('node_modules/@huggingface/transformers/.cache/Xenova/paraphrase-multilingual-MiniLM-L12-v2/onnx/model_quantized.onnx'),
].find(existsSync);
const SP_BIN = process.env.SP_VOCAB || yol('model/sp-vocab.bin');

let _sess = null, _tok = null;
export async function embedder() {
  if (!_sess) {
    if (!MODEL_ONNX) throw new Error('model_quantized.onnx bulunamadı — önce model-indir.mjs çalıştır');
    _tok = new SpTokenizer(SP_BIN);
    // Arena/mem-pattern KAPALI: ORT arenası tek başına yüzlerce MB ayırıyordu.
    // Tek iş parçacığı: kısa sorgularda (≤512 token) inferans zaten ~5-30 ms.
    _sess = await ort.InferenceSession.create(MODEL_ONNX, {
      enableCpuMemArena: false, enableMemPattern: false,
      graphOptimizationLevel: 'disabled',
      intraOpNumThreads: 1, interOpNumThreads: 1,
    });
    await calistir([0, 2]);        // ısınma: ilk gerçek sorgu JIT bedeli ödemesin
  }
  return _sess;
}

async function calistir(ids) {
  const L = ids.length;
  const arr = new BigInt64Array(L);
  for (let i = 0; i < L; i++) arr[i] = BigInt(ids[i]);
  const out = await _sess.run({
    input_ids: new ort.Tensor('int64', arr, [1, L]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(L).fill(1n), [1, L]),
    token_type_ids: new ort.Tensor('int64', new BigInt64Array(L), [1, L]),
  });
  const h = out.last_hidden_state.data;          // [1, L, DIM]
  // mean pooling (padding yok → mask hep 1) + L2 normalize — eski pipeline'ın
  // {pooling:'mean', normalize:true} davranışının birebir karşılığı.
  const v = new Float32Array(DIM);
  for (let t = 0; t < L; t++) { const b = t * DIM; for (let d = 0; d < DIM; d++) v[d] += h[b + d]; }
  let n = 0;
  for (let d = 0; d < DIM; d++) { v[d] /= L; n += v[d] * v[d]; }
  n = Math.sqrt(n) || 1;
  for (let d = 0; d < DIM; d++) v[d] /= n;
  return v;
}

export async function embedOne(text) {
  await embedder();
  return calistir(_tok.encode(text).ids);
}

// Dizi → [n*DIM] düz Float32Array. Offline betikler için (embed-hadis/embed-kuran).
// Tek tek çalışır; offline işte toplam süre kritik değil.
export async function embedBatch(arr) {
  await embedder();
  const out = new Float32Array(arr.length * DIM);
  for (let i = 0; i < arr.length; i++) out.set(await calistir(_tok.encode(arr[i]).ids), i * DIM);
  return out;
}

// İki normalize f32 vektörün kosinüs benzerliği (nokta çarpım).
export function cos(a, aOff, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[aOff + i] * b[i];
  return s;
}

// int8 korpus vektörü (kayıt: round(v·127)) × f32 sorgu → ~kosinüs.
// 127'ye bölmek değerleri f32 kosinüs ölçeğine getirir (sıralama zaten korunur).
export function cosI8(a, aOff, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[aOff + i] * b[i];
  return s / 127;
}
