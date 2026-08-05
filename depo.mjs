// depo.mjs — Çalışma anı veri katmanı: mihenk.db (salt-okunur) + kompakt kalıcı diziler.
//
// İlke: metinler DİSKTE kalır; RAM'de yalnız sayısal/kompakt yapılar (derece dizisi
// 30 KB, günün havuzu ~30 KB, Arapça kelime sayıları 60 KB). Korpus çapındaki
// sözcüksel taramalar SQL LIKE ile C tarafında koşar (dil başına ayrı hnorm_*
// tabloları ~20 MB — JS'e satır materyalize edilmez). Motor'un BM25'i FTS5'te
// (motor_tr/motor_en kolonları inşada Motor'un KENDİ tokenizasyonuyla yazıldı;
// sorgu tarafı da aynı tokenize'ı kullanır).

import Database from 'better-sqlite3';
import { tokenize } from './motor.mjs';

const yol = (f) => new URL(`./${f}`, import.meta.url).pathname;
const db = new Database(yol('mihenk.db'), { readonly: true, fileMustExist: true });
db.pragma('cache_size = -8000');     // 8 MB sayfa önbelleği — bütçeli, ölçülü
db.pragma('mmap_size = 0');          // RSS'i öngörülebilir tut (OOM sınırına sayılır)

const metaAl = db.prepare('SELECT v FROM meta WHERE k = ?');
export const nCorpus = Number(metaAl.get('nCorpus').v);
export const nHadisAll = Number(metaAl.get('nHadisAll').v);
export const nAyet = Number(metaAl.get('nAyet').v);

// --- kalıcı kompakt diziler ---
export const DERECE_KOD = { bilinmiyor: 0, sahih: 1, hasen: 2, zayif: 3, mevzu: 4 };
export const dereceArr = new Uint8Array(nHadisAll);        // i-1 → derece kodu
for (const [i, d] of db.prepare('SELECT i, derece FROM hadis').raw().iterate()) {
  dereceArr[i - 1] = DERECE_KOD[d] ?? 0;
}
// arapcaAra'nın uzunluk normalizasyonu: benzersiz kelime sayısı (Set boyutu)
export const arKelime = new Uint16Array(nCorpus + 1);      // i → kelime sayısı (0 = ar yok)
for (const [i, k] of db.prepare('SELECT i, kelime FROM harnorm').raw().iterate()) {
  arKelime[i] = Math.min(k, 65535);
}
export const gununHavuz = Int32Array.from(
  db.prepare('SELECT i FROM gunun_havuz ORDER BY sira').raw().all().map(r => r[0]));

// --- kayıt yeniden kurma (hadis-api'nin beklediği şekil) ---
function hadisKur(r) {
  if (!r) return null;
  const m = JSON.parse(r.meta);
  return {
    id: r.id, kitap: r.kitap, derece: r.derece, mevzuat: !!r.mevzuat,
    kitapTr: m.kitapTr, kisaTr: m.kisaTr, no: m.no, dereceRaw: m.dereceRaw,
    alimler: m.alimler, kaynak: m.kaynak, referans: m.referans, aciklama: m.aciklama,
    tr: r.tr, en: r.en, fr: r.fr, idn: r.idn, ur: r.ur, ar: r.ar,
    _i: r.i,
  };
}
function ayetKur(r) {
  if (!r) return null;
  return {
    id: r.id, sure: r.sure, sureAd: r.sure_ad, sureAdEn: r.sure_ad_en, ayet: r.ayet,
    sayfa: r.sayfa, cuz: r.cuz, ar: r.ar, okunus: r.okunus,
    tr: r.tr, en: r.en, fr: r.fr, idn: r.idn, ur: r.ur,
    kaynak: r.kaynak, kaynakEn: r.kaynak_en, _i: r.i,
  };
}

const hadisSec = db.prepare('SELECT * FROM hadis WHERE i = ?');
const ayetSec = db.prepare('SELECT * FROM ayet WHERE i = ?');
const ayetSAsec = db.prepare('SELECT * FROM ayet WHERE sure = ? AND ayet = ? LIMIT 1');
export const hadisAl = (i) => hadisKur(hadisSec.get(i));
export const ayetAl = (i) => ayetKur(ayetSec.get(i));
export const ayetBul = (sure, ayet) => ayetKur(ayetSAsec.get(sure, ayet));

// --- Motor.ara'nın FTS5 karşılığı ---
// bm25() küçükken daha iyi (negatif); pozitife çevirip Motor'daki 'bilinmiyor'
// tie-break'ini (×0.92) koruyoruz. (k1 1.5→1.2 farkı sıralamada ihmal düzeyi;
// sonuçlar zaten LLM eşleştirme adayı.)
const ftsSec = db.prepare('SELECT rowid, bm25(hadis_fts) FROM hadis_fts WHERE hadis_fts MATCH ? ORDER BY bm25(hadis_fts) LIMIT ?').raw();
export function hadisAra(dil, sorgu, k = 8, sadeceSaglam = false) {
  const toks = tokenize(sorgu);
  if (!toks.length) return [];
  const kolon = dil === 'en' ? 'motor_en' : 'motor_tr';
  const match = `${kolon} : (${toks.map(t => `"${t}"`).join(' OR ')})`;
  let rows;
  try { rows = ftsSec.all(match, k * 4); } catch { return []; }
  const skorlu = rows.map(([i, s]) => [i, -s * (dereceArr[i - 1] === 0 ? 0.92 : 1)]);
  skorlu.sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [i, s] of skorlu) {
    if (out.length >= k) break;
    if (sadeceSaglam && dereceArr[i - 1] !== 1 && dereceArr[i - 1] !== 2) continue;
    const h = hadisAl(i);
    h._skor = +s.toFixed(2);
    out.push(h);
  }
  return out;
}

// --- LIKE taramaları (C tarafında; JS'e yalnız rowid listesi döner) ---
// LIKE deseni içi güvenlik: normalize edilmiş sorgu kelimelerinde %/_ zaten yok
// (trNorm harf/rakam dışını boşluk yapar) ama yine de süz.
const likeTemiz = (v) => String(v).replace(/[%_]/g, '');
const NORM_TABLO = { tr: 'hnorm_tr', en: 'hnorm_en', fr: 'hnorm_fr', id: 'hnorm_idn', ur: 'hnorm_ur', ar: 'hnorm_ar' };
const tabloAl = (dil) => NORM_TABLO[dil] || NORM_TABLO.tr;

// Alakasızlık kapısı: kelimelerden HERHANGİ biri normalize metinlerde (substring)
// geçiyor mu? (hadisNormAl + includes davranışının birebir SQL karşılığı.)
export function hadisKapiVar(dil, kelimeler) {
  const ks = kelimeler.map(likeTemiz).filter(Boolean);
  if (!ks.length) return false;
  const kosul = ks.map(() => 'm LIKE ?').join(' OR ');
  const args = ks.map(w => `%${w}%`);
  return !!db.prepare(`SELECT 1 FROM ${tabloAl(dil)} WHERE ${kosul} LIMIT 1`).get(...args);
}

// lexHadis satır kümesi: varyantlardan herhangi biri eşleşen kayıtların i listesi.
// TR tarzı dillerde kelime-başı eşleşme (' '+v — norm metinler baştan boşluklu),
// Arapça'da substring (kökler eklerin içinde geçer).
export function hadisEslesen(dil, varyantlar) {
  const vs = varyantlar.map(likeTemiz).filter(Boolean);
  if (!vs.length) return [];
  const arMi = dil === 'ar';
  const kosul = vs.map(() => 'm LIKE ?').join(' OR ');
  const args = vs.map(v => arMi ? `%${v}%` : `% ${v}%`);
  return db.prepare(`SELECT i FROM ${tabloAl(dil)} WHERE ${kosul}`).raw().all(...args).map(r => r[0]);
}

// arapcaAra tarama: TAM kelime (harnorm baştan/sondan boşluklu saklanır).
export function arTamKelime(w) {
  const t = likeTemiz(w);
  if (!t) return [];
  return db.prepare('SELECT i FROM harnorm WHERE m LIKE ?').raw().all(`% ${t} %`).map(r => r[0]);
}
const arDfSec = db.prepare('SELECT n FROM ar_df WHERE w = ?');
export const arDf = (w) => arDfSec.get(w)?.n || 0;

// --- Kur'an dil verisi: dil başına TEK SEFER yüklenir, hadis-api LRU'sunda tutulur ---
// (6236 satır ≈ 2-4 MB/dil; kuranIndeks'in RAM'de Set kurduğu eski düzenin
// kontrollü karşılığı. norm/metin çiftleri lexPuan + kuranKonu ana döngüsü için.)
const AYET_METIN = { tr: 'tr', en: 'en', fr: 'fr', id: 'idn', ur: 'ur', ar: 'ar' };
const AYET_NORM = { tr: 'norm_tr', en: 'norm_en', fr: 'norm_fr', id: 'norm_idn', ur: 'norm_ur', ar: 'norm_ar' };
export function ayetDilYukle(dil) {
  const mk = AYET_METIN[dil] || 'tr', nk = AYET_NORM[dil] || 'norm_tr';
  const norm = new Array(nAyet), metin = new Array(nAyet);
  for (const [i, n, m] of db.prepare(
    `SELECT i, ${nk}, COALESCE(NULLIF(${mk},''), NULLIF(en,''), tr) FROM ayet`).raw().iterate()) {
    norm[i - 1] = n || ''; metin[i - 1] = m || '';
  }
  return { norm, metin };
}
