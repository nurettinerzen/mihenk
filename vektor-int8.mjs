// vektor-int8.mjs — Hadis f32 vektörlerini int8'e kuantalar (90 MB → 22,5 MB RAM).
// Vektörler L2-normalize (|v|≤1) → q = round(v·127) kayıpsız aralıkta. Sıralama
// (kosinüs karşılaştırması) için yeterli; betik örneklem üzerinde sapmayı ölçüp yazar.
// Kur'an vektörleri f32 kalır (18 MB — kuranKonu'daki toplamsal skor sabitleri
// ölçeğe duyarlı, oraya dokunmuyoruz).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const yol = (f) => new URL(`./${f}`, import.meta.url).pathname;
const DIM = 384;
mkdirSync(yol('model'), { recursive: true });

for (const ad of ['vektor-hadis-tr', 'vektor-hadis-en']) {
  const b = readFileSync(yol(`${ad}.f32`));
  const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  const q = new Int8Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const x = Math.round(f[i] * 127);
    q[i] = x > 127 ? 127 : x < -127 ? -127 : x;
  }
  // doğrulama: rastgele 300 vektör çiftinde f32 kosinüs ile i8 yaklaşığı arasındaki sapma
  const n = f.length / DIM;
  let enBuyuk = 0;
  for (let t = 0; t < 300; t++) {
    const a = (t * 104729) % n, c = (t * 130363 + 7) % n;     // sabit adımlar (tekrarlanabilir)
    let s32 = 0, s8 = 0;
    for (let d = 0; d < DIM; d++) {
      s32 += f[a * DIM + d] * f[c * DIM + d];
      s8 += q[a * DIM + d] * (f[c * DIM + d]);
    }
    const fark = Math.abs(s32 - s8 / 127);
    if (fark > enBuyuk) enBuyuk = fark;
  }
  writeFileSync(yol(`model/${ad}.i8`), Buffer.from(q.buffer));
  console.log(`${ad}.i8: ${n} vektör, ${(q.length / 1048576).toFixed(1)} MB, azami kosinüs sapması ${enBuyuk.toFixed(5)}`);
  if (enBuyuk > 0.01) { console.error('SAPMA BEKLENENDEN BÜYÜK — kuantizasyonu gözden geçir'); process.exit(1); }
}
console.log('int8 vektörler hazır.');
