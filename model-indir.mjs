// model-indir.mjs — Docker inşasında (ya da yerelde bir kez) model dosyalarını indirir:
//   model/model_quantized.onnx  (~113 MB, q8 — runtime bunu yükler)
//   model/tokenizer.json        (~17 MB — sadece sp-hazirla.mjs girdisi)
// Runtime @huggingface/transformers'a bağımlı DEĞİL; indirme düz fetch.

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const KOK = 'https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main';
const HEDEFLER = [
  { url: `${KOK}/onnx/model_quantized.onnx`, dosya: 'model/model_quantized.onnx', enAz: 90e6 },
  { url: `${KOK}/tokenizer.json`, dosya: 'model/tokenizer.json', enAz: 10e6 },
];

mkdirSync(new URL('./model/', import.meta.url), { recursive: true });
for (const { url, dosya, enAz } of HEDEFLER) {
  const hedef = new URL(`./${dosya}`, import.meta.url).pathname;
  if (existsSync(hedef) && statSync(hedef).size >= enAz) { console.log(`${dosya} zaten var, atlandı`); continue; }
  process.stdout.write(`${dosya} indiriliyor... `);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) { console.error(`indirilemedi (${r.status}): ${url}`); process.exit(1); }
  await pipeline(Readable.fromWeb(r.body), createWriteStream(hedef));
  const mb = (statSync(hedef).size / 1048576).toFixed(1);
  if (statSync(hedef).size < enAz) { console.error(`eksik indi (${mb} MB): ${url}`); process.exit(1); }
  console.log(`${mb} MB ✓`);
}
console.log('model hazır.');
