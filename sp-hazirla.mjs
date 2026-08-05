// sp-hazirla.mjs — tokenizer.json (XLM-R unigram, 250k parça) → model/sp-vocab.bin
//
// Neden: @huggingface/transformers'ın JS tokenizer'ı vocab'ı JS objelerinde tutup
// ~170-235 MB RSS yiyordu; native (Rust) paket de ~287 MB. 512 MB'lık instance'a
// sığmak için vocab'ı typed-array'lere seriliyoruz (~10 MB): sp-tokenizer.mjs okur.
//
// Biçim (little-endian):
//   0   : 'SPV1' (4 bayt)
//   4   : u32 parça sayısı (N)
//   8   : u32 parça baytları toplam uzunluğu
//   12  : u32 en uzun parça (bayt)
//   16  : f32 unk cezası (minSkor - 10, HF Unigram davranışı)
//   20  : f32[N] skorlar (logprob)
//   ...: u32[N+1] offset'ler (parça baytları içinde)
//   ...: parça baytları (UTF-8, ardışık)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const KAYNAKLAR = [
  process.env.TOKENIZER_JSON,
  new URL('./model/tokenizer.json', import.meta.url).pathname,
  new URL('./node_modules/@huggingface/transformers/.cache/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tokenizer.json', import.meta.url).pathname,
].filter(Boolean);
const kaynak = KAYNAKLAR.find(p => existsSync(p));
if (!kaynak) { console.error('tokenizer.json bulunamadı — önce model-indir.mjs çalıştır.'); process.exit(1); }

const j = JSON.parse(readFileSync(kaynak, 'utf8'));
if (j.model?.type !== 'Unigram') { console.error('Beklenen model tipi Unigram, gelen: ' + j.model?.type); process.exit(1); }
const vocab = j.model.vocab;             // [parça, logprob][] — dizin = token id
const N = vocab.length;

let piecesLen = 0, maxPiece = 0, minSkor = 0;
const parcaBuf = [];
for (const [p, s] of vocab) {
  const b = Buffer.from(p, 'utf8');
  parcaBuf.push(b);
  piecesLen += b.length;
  if (b.length > maxPiece) maxPiece = b.length;
  if (s < minSkor) minSkor = s;
}

const bas = 20;
const out = Buffer.alloc(bas + N * 4 + (N + 1) * 4 + piecesLen);
out.write('SPV1', 0, 'ascii');
out.writeUInt32LE(N, 4);
out.writeUInt32LE(piecesLen, 8);
out.writeUInt32LE(maxPiece, 12);
out.writeFloatLE(minSkor - 10, 16);       // HF tokenizers: unk_score = min_score - 10
let of = bas;
for (const [, s] of vocab) { out.writeFloatLE(s, of); of += 4; }
let cum = 0;
for (let i = 0; i < N; i++) { out.writeUInt32LE(cum, of); of += 4; cum += parcaBuf[i].length; }
out.writeUInt32LE(cum, of); of += 4;
for (const b of parcaBuf) { b.copy(out, of); of += b.length; }

mkdirSync(new URL('./model/', import.meta.url), { recursive: true });
const hedef = new URL('./model/sp-vocab.bin', import.meta.url).pathname;
writeFileSync(hedef, out);
console.log(`sp-vocab.bin: ${N} parça, ${(out.length / 1048576).toFixed(1)} MB (en uzun parça ${maxPiece} bayt)`);
