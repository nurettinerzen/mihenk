// db-yap.mjs — corpus.json(.gz) + mevzuat.json + ayat.json → mihenk.db (SQLite).
// Docker inşasında bir kez çalışır; runtime (depo.mjs) DB'yi salt-okunur açar.
//
// Neden: 30.483 hadis × 6 dil JSON olarak RAM'de ~1 GB tutuyordu (Standard plan
// mecburiyeti). Metinler artık diskte; normalize kopyalar (arama) ve Motor'un BM25
// token uzayı (FTS5) İNŞA SIRASINDA hesaplanır — çalışma anındaki sonuçlar birebir
// aynı kalsın diye metin.mjs'teki AYNI fonksiyonlar kullanılır.
//
// Yerleşim notu: normalize kolonlar dil başına AYRI tabloda (hnorm_tr, hnorm_ar…).
// LIKE taramaları satır-esaslı okur; norm'lar ana tabloda kalsaydı her tarama
// 280 MB'lik tüm tabloyu okurdu — ayrı tabloda yalnız o dilin ~20 MB'i okunur.

import Database from 'better-sqlite3';
import { readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { metinAl, trNorm, arNorm, hadisMatn } from './metin.mjs';
import { tokenize } from './motor.mjs';

const yol = (f) => new URL(`./${f}`, import.meta.url).pathname;
const jsonOku = (ad) => {
  const gz = yol(`${ad}.gz`);
  if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)));
  return JSON.parse(readFileSync(yol(ad), 'utf8'));
};

const corpus = jsonOku('corpus.json');
// Mevzuat kayıtları hadis-api.mjs'tekiyle AYNI şekilde türetilir (id, alan adları).
const mevzuat = JSON.parse(readFileSync(yol('mevzuat.json'), 'utf8')).map((m, i) => ({
  id: `m${i}`, kitap: 'mevzuat', kitapTr: 'Halk arasında yaygın söz', kisaTr: 'Yaygın söz',
  no: null, tr: m.metin, ar: '', derece: m.derece, dereceRaw: m.referans,
  alimler: [], kaynak: 'Halk arasında yaygın söz', referans: m.referans, aciklama: m.aciklama, mevzuat: true,
}));
const hadisAll = [...corpus, ...mevzuat];
const ayat = JSON.parse(readFileSync(yol('ayat.json'), 'utf8'));

rmSync(yol('mihenk.db'), { force: true });
const db = new Database(yol('mihenk.db'));
db.pragma('journal_mode = OFF');
db.pragma('synchronous = OFF');

const NORMLAR = ['tr', 'en', 'fr', 'idn', 'ur', 'ar'];
db.exec(`
CREATE TABLE hadis (
  i INTEGER PRIMARY KEY,          -- 1-bazlı; önce corpus (vektör sırası), sonra mevzuat
  id TEXT NOT NULL,
  kitap TEXT, derece TEXT NOT NULL, mevzuat INTEGER NOT NULL,
  meta TEXT NOT NULL,             -- {kitapTr,kisaTr,no,dereceRaw,alimler,kaynak,referans,aciklama} JSON
  tr TEXT, en TEXT, fr TEXT, idn TEXT, ur TEXT, ar TEXT
);
${NORMLAR.map(d => `CREATE TABLE hnorm_${d} (i INTEGER PRIMARY KEY, m TEXT NOT NULL);`).join('\n')}
CREATE TABLE harnorm (i INTEGER PRIMARY KEY, m TEXT NOT NULL, kelime INTEGER NOT NULL);
CREATE VIRTUAL TABLE hadis_fts USING fts5(motor_tr, motor_en, content='');
CREATE TABLE ayet (
  i INTEGER PRIMARY KEY,          -- 1-bazlı ayat sırası (= vektör sırası)
  id INTEGER, sure INTEGER, ayet INTEGER, sayfa INTEGER, cuz INTEGER,
  sure_ad TEXT, sure_ad_en TEXT, kaynak TEXT, kaynak_en TEXT,
  ar TEXT, okunus TEXT, tr TEXT, en TEXT, fr TEXT, idn TEXT, ur TEXT,
  norm_tr TEXT, norm_en TEXT, norm_fr TEXT, norm_idn TEXT, norm_ur TEXT, norm_ar TEXT
);
CREATE INDEX ayet_sa ON ayet(sure, ayet);
CREATE TABLE ar_df (w TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE gunun_havuz (sira INTEGER PRIMARY KEY, i INTEGER NOT NULL);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

// --- hadis + norm + fts ---
const hIns = db.prepare('INSERT INTO hadis VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const nIns = Object.fromEntries(NORMLAR.map(d => [d, db.prepare(`INSERT INTO hnorm_${d} VALUES (?,?)`)]));
const arIns = db.prepare('INSERT INTO harnorm VALUES (?,?,?)');
const fIns = db.prepare('INSERT INTO hadis_fts (rowid, motor_tr, motor_en) VALUES (?,?,?)');
// [veri alanı adı, dil kodu (metinAl için), normalize fn]
const DIL_NORM = [['tr', 'tr', trNorm], ['en', 'en', trNorm], ['fr', 'fr', trNorm], ['idn', 'id', trNorm], ['ur', 'ur', trNorm], ['ar', 'ar', arNorm]];
let t0 = Date.now();
db.transaction(() => {
  for (let idx = 0; idx < hadisAll.length; idx++) {
    const h = hadisAll[idx], i = idx + 1;
    hIns.run(
      i, h.id, h.kitap, h.derece, h.mevzuat ? 1 : 0,
      JSON.stringify({ kitapTr: h.kitapTr, kisaTr: h.kisaTr, no: h.no ?? null, dereceRaw: h.dereceRaw, alimler: h.alimler || [], kaynak: h.kaynak, referans: h.referans, aciklama: h.aciklama }),
      h.tr || '', h.en || '', h.fr || '', h.idn || '', h.ur || '', h.ar || '',
    );
    // Konu araması yalnız gerçekten o dilde bulunan çeviriyi tarar. Eksik TR/FR
    // kaydın İngilizce fallback'i râvi adlarını konu sanıp sonuç üretiyordu.
    for (const [alan,, nf] of DIL_NORM) nIns[alan].run(i, ' ' + nf(hadisMatn(h[alan] || '')));
    if (!h.mevzuat && h.ar) {
      const an = arNorm(h.ar);
      // arapcaAra, kelime kümesi (Set) boyutuyla normalize eder → benzersiz kelime sayısı.
      // Metin başa/sona boşluklu saklanır: LIKE '% w %' doğrudan tam-kelime arar.
      arIns.run(i, ' ' + an + ' ', new Set(an.split(' ')).size);
    }
    fIns.run(i, tokenize(h.tr || '').join(' '), tokenize(h.en || '').join(' '));
  }
})();
console.log(`hadis: ${hadisAll.length} kayıt (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// --- ar_df: kelime → kaç corpus kaydında geçtiği (arapcaAra idf'i) ---
t0 = Date.now();
const arDF = new Map();
for (const h of corpus) {
  if (!h.ar) continue;
  for (const w of new Set(arNorm(h.ar).split(' '))) if (w.length > 2) arDF.set(w, (arDF.get(w) || 0) + 1);
}
const aIns = db.prepare('INSERT INTO ar_df VALUES (?,?)');
db.transaction(() => { for (const [w, n] of arDF) aIns.run(w, n); })();
console.log(`ar_df: ${arDF.size} kelime (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// --- günün hadisi havuzu (hadis-api.mjs'teki filtreyle birebir; sıra korunur) ---
const GUNUN_ELE = /(kıyamet|cehennem|azâb|azap|recm|celde|kırbaç|öldür|katl|savaş|gazve|deccal|zina|cariye|köle|kesil|lânet|lanet|helâk|helak|burnu|yüzlü|hadisin (?:bir )?benzeri)/i;
const havuz = [];
for (let idx = 0; idx < corpus.length; idx++) {
  const h = corpus[idx];
  if (h.derece === 'sahih' && h.tr && h.tr.length > 60 && h.tr.length < 340
    && !GUNUN_ELE.test(h.tr) && !/^\s*(Bize|Bana)\b/.test(h.tr)) havuz.push(idx + 1);
}
const gIns = db.prepare('INSERT INTO gunun_havuz VALUES (?,?)');
db.transaction(() => { havuz.forEach((i, s) => gIns.run(s, i)); })();
console.log(`gunun_havuz: ${havuz.length} hadis`);

// --- ayet (norm kolonlar burada kalır: dil başına TEK SEFER okunup RAM'e alınıyor) ---
t0 = Date.now();
const yIns = db.prepare(`INSERT INTO ayet VALUES (${'?,'.repeat(22)}?)`);
db.transaction(() => {
  for (let idx = 0; idx < ayat.length; idx++) {
    const a = ayat[idx];
    const norm = DIL_NORM.map(([, dil, nf]) => nf(metinAl(a, dil)));
    yIns.run(
      idx + 1, a.id, a.sure, a.ayet, a.sayfa ?? null, a.cuz ?? null,
      a.sureAd || '', a.sureAdEn || '', a.kaynak || '', a.kaynakEn || '',
      a.ar || '', a.okunus || '', a.tr || '', a.en || '', a.fr || '', a.idn || '', a.ur || '',
      norm[0], norm[1], norm[2], norm[3], norm[4], norm[5],
    );
  }
})();
console.log(`ayet: ${ayat.length} kayıt (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

db.prepare('INSERT INTO meta VALUES (?,?)').run('nCorpus', String(corpus.length));
db.prepare('INSERT INTO meta VALUES (?,?)').run('nHadisAll', String(hadisAll.length));
db.prepare('INSERT INTO meta VALUES (?,?)').run('nAyet', String(ayat.length));
db.exec('ANALYZE');
db.close();
console.log(`mihenk.db hazır: ${(statSync(yol('mihenk.db')).size / 1048576).toFixed(0)} MB`);
