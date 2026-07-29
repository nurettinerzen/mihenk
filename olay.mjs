// Anonim ürün analitiği — kendi altyapımız, üçüncü taraf SDK yok.
//
// Neden kendimiz: Firebase/Amplitude gibi bir SDK eklemek App Store'da "Tracking"
// beyanı, privacy manifest ve çerez benzeri kimlikler getiriyor. Bize gereken şey
// kişi takibi değil, ürün hunisi: hangi ekran, ne kadar kalındı, nerede bırakıldı.
// Bunun için cihazın zaten var olan rastgele UUID'si yetiyor; isim, e-posta, IDFA,
// konum, IP saklanmıyor.
//
// Depolama: günlük JSONL dosyası (append-only) — Render diskinde kalıcı. Veritabanı
// yok çünkü yazma deseni saf ekleme, okuma ise günde birkaç kez panel açılışı.
import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIZIN = process.env.VERI_DIZIN || (existsSync('/veri') ? '/veri/olay' : './veri/olay');
try { mkdirSync(DIZIN, { recursive: true }); } catch { /* salt-okunur disk: yazma sessizce düşer */ }

const gunAdi = (d = new Date()) => d.toISOString().slice(0, 10);
const dosyaYolu = (g) => join(DIZIN, `${g}.jsonl`);

// Uygulamanın gönderebileceği olaylar. Beyaz liste: istemciden gelen serbest metin
// diske sınırsız yazılmasın (hem disk hem panel gürültüsü).
export const OLAYLAR = new Set([
  'acilis',          // uygulama açıldı            { ilk:bool, dil, tz, surum }
  'ekran',           // ekrandan ayrıldı           { ad, sn }
  'sorgu',           // AI sorgusu gönderildi      { tur, dil }
  'sonuc',           // sorgu sonuçlandı           { tur, bulundu:bool, ms }
  'paywall',         // paywall açıldı             { kaynak }
  'satinalma',       // satın alma akışı           { plan, durum: basladi|tamam|iptal|hata }
  'geri_yukle',      // satın almaları geri yükle  { durum }
  'paylas',          // paylaş                     { tur }
  'ezan_bildirim',   // ezan bildirimi anahtarı    { acik:bool }
  'kari_indir',      // tilavet indirme            { durum: basladi|bitti|iptal, kari }
  'oynat',           // tilavet çalındı            { sure }
  'dil_degis',       // uygulama dili değişti      { dil }
  'hata',            // istemci tarafı hata        { yer }
]);

// Panelde sayı olarak toplanacak alanlar dışındaki her şey atılır: istemci ne
// gönderirse göndersin diske yalnız bilinen anahtarlar iner.
const ALANLAR = ['ilk', 'dil', 'tz', 'surum', 'ad', 'sn', 'tur', 'bulundu', 'ms', 'kaynak',
  'plan', 'durum', 'acik', 'kari', 'sure', 'yer'];

function temizle(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  return String(v).slice(0, 40);
}

/** Bir cihazın olay yığınını diske yazar. Dönen sayı: kabul edilen olay adedi. */
export function olayYaz(cihaz, olaylar) {
  if (!Array.isArray(olaylar) || !olaylar.length) return 0;
  const c = String(cihaz || 'anon').slice(0, 64);
  const satirlar = [];
  // Tek istekte 100'den fazlası kabul edilmiyor: bozuk/kötü niyetli istemci diski
  // doldurmasın. İstemci zaten 20'lik yığınlar gönderiyor.
  for (const o of olaylar.slice(0, 100)) {
    if (!o || typeof o !== 'object' || !OLAYLAR.has(o.a)) continue;
    const kayit = { t: new Date().toISOString(), c, a: o.a };
    for (const k of ALANLAR) if (o[k] !== undefined && o[k] !== null) kayit[k] = temizle(o[k]);
    satirlar.push(JSON.stringify(kayit));
  }
  if (!satirlar.length) return 0;
  try { appendFileSync(dosyaYolu(gunAdi()), satirlar.join('\n') + '\n'); }
  catch (e) { console.warn('[OLAY] yazılamadı:', e.message); return 0; }
  return satirlar.length;
}

/** Son `gun` günün olaylarını okur (bugün dahil). */
export function olayOku(gun = 30) {
  const cikti = [];
  const bugun = new Date();
  for (let i = gun - 1; i >= 0; i--) {
    const d = new Date(bugun.getTime() - i * 86400_000);
    const y = dosyaYolu(gunAdi(d));
    if (!existsSync(y)) continue;
    for (const s of readFileSync(y, 'utf8').split('\n')) {
      if (!s) continue;
      try { cikti.push(JSON.parse(s)); } catch { /* yarım satır: yazma kesilmiş olabilir */ }
    }
  }
  return cikti;
}

export function diskDurumu() {
  try {
    const d = readdirSync(DIZIN);
    const bayt = d.reduce((a, f) => a + statSync(join(DIZIN, f)).size, 0);
    return { dizin: DIZIN, dosya: d.length, mb: Math.round(bayt / 1048576 * 100) / 100, kalici: DIZIN.startsWith('/veri') };
  } catch { return { dizin: DIZIN, dosya: 0, mb: 0, kalici: false }; }
}

// --- Toplama ---------------------------------------------------------------

/** Panel ve /olcum için özet. Ham olay döndürmez; yalnız toplamlar. */
export function ozet(gun = 30) {
  const ev = olayOku(gun);
  const say = (o, k, n = 1) => { if (k !== undefined) o[k] = (o[k] || 0) + n; };

  const gunluk = {};            // gün -> { cihaz:Set, olay, sorgu, paywall, satis }
  const cihazIlk = {};          // cihaz -> ilk görülme günü
  const cihazSon = {};          // cihaz -> son görülme günü
  const ekranSure = {};         // ekran -> { sn, kez }
  const dil = {}, tz = {}, surum = {};
  const sorguTur = {}, sonucTur = {};
  const paywallKaynak = {}, satinalma = {}, plan = {};
  const paylas = {}, kariIndir = {}, oynat = {}, hata = {};
  let bildirimAc = 0, bildirimKapa = 0, geriYukle = 0;

  for (const e of ev) {
    const g = (e.t || '').slice(0, 10);
    const G = gunluk[g] || (gunluk[g] = { cihaz: new Set(), olay: 0, sorgu: 0, paywall: 0, satis: 0 });
    G.cihaz.add(e.c); G.olay++;
    if (!cihazIlk[e.c] || g < cihazIlk[e.c]) cihazIlk[e.c] = g;
    if (!cihazSon[e.c] || g > cihazSon[e.c]) cihazSon[e.c] = g;

    switch (e.a) {
      case 'acilis': say(dil, e.dil); say(tz, e.tz); say(surum, e.surum); break;
      case 'ekran': {
        const k = ekranSure[e.ad] || (ekranSure[e.ad] = { sn: 0, kez: 0 });
        k.sn += Number(e.sn) || 0; k.kez++;
        break;
      }
      case 'sorgu': say(sorguTur, e.tur); G.sorgu++; break;
      case 'sonuc': say(sonucTur, `${e.tur}/${e.bulundu ? 'bulundu' : 'boş'}`); break;
      case 'paywall': say(paywallKaynak, e.kaynak); G.paywall++; break;
      case 'satinalma':
        say(satinalma, e.durum); say(plan, e.plan);
        if (e.durum === 'tamam') G.satis++;
        break;
      case 'geri_yukle': geriYukle++; break;
      case 'paylas': say(paylas, e.tur); break;
      case 'ezan_bildirim': e.acik ? bildirimAc++ : bildirimKapa++; break;
      case 'kari_indir': say(kariIndir, e.durum); break;
      case 'oynat': say(oynat, e.sure); break;
      case 'hata': say(hata, e.yer); break;
    }
  }

  // Huni: uygulamayı açan cihazlardan kaçı sorguya, paywall'a, satın almaya gitti.
  const kume = (ad) => new Set(ev.filter(e => e.a === ad).map(e => e.c));
  const acan = new Set(ev.map(e => e.c));
  const huni = {
    acan: acan.size,
    sorguYapan: kume('sorgu').size,
    paywallGoren: kume('paywall').size,
    satinAlmaBaslatan: new Set(ev.filter(e => e.a === 'satinalma' && e.durum === 'basladi').map(e => e.c)).size,
    abone: new Set(ev.filter(e => e.a === 'satinalma' && e.durum === 'tamam').map(e => e.c)).size,
  };

  // Elde tutma: ilk günü D olan cihazlardan kaçı D+1 / D+7'de geri geldi.
  const eldeTutma = (n) => {
    let kohort = 0, donen = 0;
    const gunler = new Set(ev.map(e => (e.t || '').slice(0, 10)));
    for (const [c, ilk] of Object.entries(cihazIlk)) {
      const hedef = new Date(new Date(ilk).getTime() + n * 86400_000).toISOString().slice(0, 10);
      if (!gunler.has(hedef)) continue;             // o gün hiç veri yoksa kohortu sayma
      kohort++;
      if (ev.some(e => e.c === c && (e.t || '').slice(0, 10) === hedef)) donen++;
    }
    return kohort ? { kohort, donen, oran: Math.round(donen / kohort * 100) } : null;
  };

  const gunListe = Object.entries(gunluk).sort(([a], [b]) => a < b ? -1 : 1).map(([g, v]) => ({
    gun: g, cihaz: v.cihaz.size, olay: v.olay, sorgu: v.sorgu, paywall: v.paywall, satis: v.satis,
    yeni: Object.values(cihazIlk).filter(x => x === g).length,
  }));

  return {
    aralik: `son ${gun} gün`,
    toplamOlay: ev.length,
    toplamCihaz: acan.size,
    gunluk: gunListe,
    huni,
    eldeTutma: { d1: eldeTutma(1), d7: eldeTutma(7) },
    ekran: Object.fromEntries(Object.entries(ekranSure).map(([k, v]) =>
      [k, { kez: v.kez, ortSn: Math.round(v.sn / v.kez * 10) / 10, toplamDk: Math.round(v.sn / 60) }])),
    dil, tz, surum, sorguTur, sonucTur, paywallKaynak, satinalma, plan,
    paylas, kariIndir, oynat, hata, geriYukle,
    bildirim: { acan: bildirimAc, kapatan: bildirimKapa },
    disk: diskDurumu(),
  };
}
