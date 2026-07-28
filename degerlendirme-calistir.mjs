// degerlendirme-calistir.mjs — konu araması SIRALAMA kalitesini ölçer.
//
// Neden var: konu() içindeki sıralama formülü (semantik × lexical harmanı, tek-terim
// kapısı, ağırlıklar) alakasız sonuçlar üretebiliyor ("tevazu" → Mushaf yazımı).
// Formülü ölçüm seti olmadan ayarlamak körlemesine iş; bu betik o ölçümü verir.
//
//   npm start                       # backend'i ayağa kaldır (8788)
//   node degerlendirme-calistir.mjs # varsayılan port 8788
//   node degerlendirme-calistir.mjs 8799 --ayrinti
//
// GÖSTERGE: anahtarIsabetIlk5 — ilk 5 sonucun kaçında konunun anahtar kelimesi
// geçiyor. KABA bir vekildir (gerçek alaka insan kararıdır) ama regresyonu güvenilir
// yakalar: toplam düşüyorsa değişikliği geri al. Değişiklikten sonra --ayrinti ile
// ilk 3 metni GÖZLE de oku; sayı yükselirken anlam bozulabilir.

import { readFileSync } from 'node:fs';

const PORT = process.argv.find(a => /^\d+$/.test(a)) || '8788';
const AYRINTI = process.argv.includes('--ayrinti');
const API = `http://localhost:${PORT}`;
const KEY = process.env.APP_KEY || 'mihenk_dd4e1cc82891921d3fa559e8';
const set = JSON.parse(readFileSync(new URL('./degerlendirme-konu.json', import.meta.url), 'utf8'));

// Arapça/Urduca metinde harekeler harflerin ARASINA giriyor: ham `includes('صبر')`
// "الصَّبْرُ" ile eşleşmez ve her Arapça sorgu yanlışlıkla 0 puan alırdı.
export const olcNorm = (s) => (s || '')
  .replace(/[ً-ْٰـۖ-ۭ]/g, '')
  .replace(/ٱ/g, 'ا').replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .toLocaleLowerCase('tr');
export const isabet = (metin, anahtarlar) => {
  const t = olcNorm(metin);
  return (anahtarlar || []).some(k => t.includes(olcNorm(k)));
};

// Doğrudan çalıştırılmadıysa (başka betik olcNorm/isabet için import ettiyse)
// ölçümü koşturma.
if (process.argv[1] !== new URL(import.meta.url).pathname) {
  // sadece yardımcılar dışa verilir
} else {

let n = 0;
async function sorgula(q) {
  const r = await fetch(API + '/api/konu', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-app-key': KEY },
    // Her sorguya AYRI cihaz kimliği: günlük 5 ücretsiz sorgu kotasına takılmayalım.
    body: JSON.stringify({ konu: q.sorgu, dil: q.dil, cihaz: 'degerlendirme-' + (n++) }),
  });
  if (!r.ok) throw new Error(`${q.id}: HTTP ${r.status}`);
  return (await r.json()).sonuclar || [];
}

let t5 = 0, t10 = 0, b5 = 0, kotu = [];
console.log(`Set: ${set.sorgular.length} sorgu | temel çizgi: ${set.uyari}\n`);
for (const q of set.sorgular) {
  const son = await sorgula(q);
  const i5 = son.slice(0, 5).filter(h => isabet(h.tr, q.kabulAnahtar)).length;
  const i10 = son.filter(h => isabet(h.tr, q.kabulAnahtar)).length;
  const t = q.temelCizgi || {};
  const fark = i5 - (t.anahtarIsabetIlk5 ?? i5);
  t5 += i5; t10 += i10; b5 += (t.anahtarIsabetIlk5 ?? 0);
  const im = fark > 0 ? `+${fark} ↑` : fark < 0 ? `${fark} ↓` : '  =';
  console.log(`${q.id.padEnd(16)} ilk5 ${i5}/5 (temel ${t.anahtarIsabetIlk5 ?? '-'}) ${im}  ilk10 ${i10}/10   ${q.sorgu}`);
  if (i5 <= 2) kotu.push(q.id);
  if (AYRINTI) {
    console.log(`   beklenen: ${q.beklenen}`);
    if (q.redOrnek) console.log(`   bilinen hata: ${q.redOrnek}`);
    son.slice(0, 3).forEach((h, i) => console.log(`   ${i + 1}. [${h.kaynak}] ${(h.tr || '').replace(/\s+/g, ' ').slice(0, 130)}`));
  }
}
console.log(`\nTOPLAM ilk5 = ${t5}/${set.sorgular.length * 5}  (temel çizgi ${b5}) ` +
  (t5 > b5 ? `→ +${t5 - b5} İYİLEŞME` : t5 < b5 ? `→ ${t5 - b5} REGRESYON, değişikliği geri al` : '→ değişiklik yok'));
console.log(`TOPLAM ilk10 = ${t10}/${set.sorgular.length * 10}`);
if (kotu.length) console.log(`Hâlâ zayıf (ilk5 ≤ 2): ${kotu.join(', ')}`);

}
