// ingest.mjs — Dereceli hadis korpusunu inşa eder.
// Kaynak: fawazahmed0/hadith-api (CDN, jsDelivr). Türkçe metin + Arapça + âlim dereceleri
// aynı kitapta hadithnumber ile hizalı olduğu için birleştiriyoruz.
//
// KRİTİK İLKE: Derece (sahih/hasen/zayıf/mevzu) HER ZAMAN veriden gelir — âlim ismiyle.
// Buhârî/Müslim: koleksiyona dahil olması = sahih (ittifak). Sünen'ler: grades[]'ten.
//
// Çıktı: corpus.json  → [{id, kitap, kitapTr, no, tr, ar, derece, dereceRaw, alimler[], kaynak, konular[]}]

import { writeFile } from 'node:fs/promises';

const CDN = 'https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions';

// Kütüb-i Sitte + Muvatta + Nevevi 40 + Kudsi.
// sahihMi: true  → tüm hadisler sahih (Buhârî/Müslim ittifakı).
// sahihMi: false → derece grades[] dizisinden okunur.
const KITAPLAR = [
  { id: 'bukhari',  tr: 'Sahîh-i Buhârî',        kisaTr: 'Buhârî',      hepSahih: true  },
  { id: 'muslim',   tr: 'Sahîh-i Müslim',        kisaTr: 'Müslim',      hepSahih: true  },
  { id: 'tirmidhi', tr: "Sünen-i Tirmizî",       kisaTr: 'Tirmizî',     hepSahih: false },
  { id: 'abudawud', tr: 'Sünen-i Ebû Dâvûd',     kisaTr: 'Ebû Dâvûd',   hepSahih: false },
  { id: 'nasai',    tr: "Sünen-i Nesâî",         kisaTr: 'Nesâî',       hepSahih: false },
  { id: 'ibnmajah', tr: 'Sünen-i İbn Mâce',      kisaTr: 'İbn Mâce',    hepSahih: false },
  { id: 'malik',    tr: "Muvatta' (İmam Mâlik)", kisaTr: 'Muvatta',     hepSahih: false },
  { id: 'nawawi',   tr: 'Nevevî Kırk Hadis',     kisaTr: 'Nevevî 40',   hepSahih: false },
  { id: 'qudsi',    tr: 'Kutsî Hadisler',        kisaTr: 'Kudsî',       hepSahih: false },
];

async function getir(edisyon) {
  const url = `${CDN}/${edisyon}.min.json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  return j.hadiths || [];
}

// Ham dereceyi normalize et → sahih | hasen | zayif | mevzu | bilinmiyor
function normalizeDerece(ham) {
  const s = (ham || '').toLowerCase();
  if (!s) return 'bilinmiyor';
  if (s.includes('mawdu') || s.includes('fabricat') || s.includes('mevzu') || s.includes("maudu")) return 'mevzu';
  if (s.includes('sahih') || s.includes('sahih li') || s.includes('authentic')) return 'sahih';
  if (s.includes('hasan')) return 'hasen';
  if (s.includes('da\'if') || s.includes('daif') || s.includes('weak') || s.includes('zaif') || s.includes('munkar')) return 'zayif';
  return 'bilinmiyor';
}

// Nevevî 40: metin sonundaki kaynak parantezinden derece çıkar.
// [Buhari]/[Müslim] geçiyorsa = sahih (iki Sahîh). Diğer Sünen kaynakları için ihtiyaten belirsiz bırak.
function nawawiDerece(metin) {
  const m = (metin || '').match(/\[([^\]]{2,40})\]\s*$/);
  if (!m) return { derece: 'bilinmiyor', raw: '', alimler: [] };
  const kaynak = m[1].trim();
  const k = kaynak.toLowerCase();
  if (k.includes('buhari') || k.includes('müslim') || k.includes('muslim')) {
    return { derece: 'sahih', raw: `Sahih (${kaynak})`, alimler: [{ alim: `${kaynak} — Nevevî derlemesi`, derece: 'Sahih', norm: 'sahih' }] };
  }
  return { derece: 'bilinmiyor', raw: `Kaynak: ${kaynak}`, alimler: [{ alim: `Kaynak: ${kaynak}`, derece: '—', norm: 'bilinmiyor' }] };
}

// grades[] dizisinden en güvenilir dereceyi seç (Elbânî önceliği) + tüm âlimleri döndür.
function dereceSec(grades) {
  if (!grades || !grades.length) return { derece: 'bilinmiyor', raw: '', alimler: [] };
  const alimler = grades
    .filter(g => g && g.grade)
    .map(g => ({ alim: (g.name || 'Kaynak').trim(), derece: g.grade.trim(), norm: normalizeDerece(g.grade) }));
  if (!alimler.length) return { derece: 'bilinmiyor', raw: '', alimler: [] };
  // Öncelik: Al-Albani > Ahmad Shakir > Shuayb > Darussalam > ilk
  const oncelik = ['albani', 'shakir', 'shuayb', 'arna', 'darussalam', 'zubair'];
  let sec = null;
  for (const p of oncelik) { sec = alimler.find(a => a.alim.toLowerCase().includes(p)); if (sec) break; }
  if (!sec) sec = alimler[0];
  return { derece: sec.norm, raw: sec.derece, alimler };
}

async function main() {
  const corpus = [];
  let idSayac = 0;

  for (const kitap of KITAPLAR) {
    process.stdout.write(`\n${kitap.kisaTr} indiriliyor... `);
    const [tur, ara, eng] = await Promise.all([
      getir(`tur-${kitap.id}`),
      getir(`ara-${kitap.id}`),
      getir(`eng-${kitap.id}`),
    ]);
    if (!tur || !tur.length) { console.log('Türkçe metin yok, atlanıyor.'); continue; }

    // Arapça, İngilizce derece ve İngilizce metni hadithnumber ile indeksle
    const araMap = new Map((ara || []).map(h => [h.hadithnumber, h.text]));
    const engMap = new Map((eng || []).map(h => [h.hadithnumber, h.grades]));
    const engMetinMap = new Map((eng || []).map(h => [h.hadithnumber, (h.text || '').trim()]));

    let eklendi = 0;
    for (const h of tur) {
      const metin = (h.text || '').trim();
      if (metin.length < 20) continue; // boş/çok kısa kayıtları atla
      const arapca = araMap.get(h.hadithnumber) || '';
      let dSel;
      if (kitap.hepSahih) {
        dSel = { derece: 'sahih', raw: 'Sahih (koleksiyon şartı)', alimler: [{ alim: `${kitap.kisaTr} ittifakı`, derece: 'Sahih', norm: 'sahih' }] };
      } else if (kitap.id === 'nawawi') {
        dSel = nawawiDerece(metin);
      } else {
        dSel = dereceSec(engMap.get(h.hadithnumber));
      }
      corpus.push({
        id: `h${idSayac++}`,
        kitap: kitap.id,
        kitapTr: kitap.tr,
        kisaTr: kitap.kisaTr,
        no: h.hadithnumber,
        tr: metin,
        en: engMetinMap.get(h.hadithnumber) || '',
        ar: arapca,
        derece: dSel.derece,
        dereceRaw: dSel.raw,
        alimler: dSel.alimler,
        kaynak: `${kitap.kisaTr} ${h.hadithnumber}`,
      });
      eklendi++;
    }
    process.stdout.write(`${eklendi} hadis (tr:${tur.length} ar:${ara?.length||0} eng:${eng?.length||0})`);
  }

  // Özet istatistik
  const say = { sahih: 0, hasen: 0, zayif: 0, mevzu: 0, bilinmiyor: 0 };
  for (const h of corpus) say[h.derece]++;
  console.log(`\n\n=== KORPUS HAZIR: ${corpus.length} hadis ===`);
  console.log(say);

  await writeFile(new URL('./corpus.json', import.meta.url), JSON.stringify(corpus));
  const mb = (JSON.stringify(corpus).length / 1e6).toFixed(1);
  console.log(`corpus.json yazıldı (${mb} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
