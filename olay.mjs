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
import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, accessSync, constants, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DIZIN = process.env.VERI_DIZIN || (existsSync('/veri') ? '/veri/olay' : './veri/olay');
try { mkdirSync(DIZIN, { recursive: true }); } catch { /* salt-okunur disk: yazma sessizce düşer */ }

const gunAdi = (d = new Date()) => d.toISOString().slice(0, 10);
const dosyaYolu = (g) => join(DIZIN, `${g}.jsonl`);
const GUNLUK_MAX_BAYT = Math.max(1, Number(process.env.OLAY_GUNLUK_MAX_MB || 20)) * 1048576;
const SAKLAMA_GUN = Math.max(7, Number(process.env.OLAY_SAKLAMA_GUN || 90));
const TEST_CIHAZ = [/^kurulum-testi$/, /^ekran-goruntusu-/, /^test-/];
const testMi = (c) => TEST_CIHAZ.some((r) => r.test(String(c || '')));
const cihazOzet = (c) => {
  const ham = String(c || 'anon').slice(0, 128);
  // Test kimlikleri panel filtresi için görünür kalır; gerçek UUID tek yönlü
  // özetlenir. Sunucudaki kota/RevenueCat kimliği analitik dosyasına girmez.
  return testMi(ham) ? ham : `u_${createHash('sha256').update(ham).digest('hex').slice(0, 24)}`;
};
let sonBakim = '';
function eskiyiTemizle() {
  const bugun = gunAdi(); if (sonBakim === bugun) return;
  sonBakim = bugun;
  const esik = Date.now() - SAKLAMA_GUN * 86400_000;
  try {
    for (const f of readdirSync(DIZIN)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/); if (!m) continue;
      if (new Date(`${m[1]}T00:00:00Z`).getTime() < esik) unlinkSync(join(DIZIN, f));
    }
  } catch (e) { console.warn('[OLAY] saklama bakımı yapılamadı:', e.message); }
}

// Uygulamanın gönderebileceği olaylar. Beyaz liste: istemciden gelen serbest metin
// diske sınırsız yazılmasın (hem disk hem panel gürültüsü).
export const OLAYLAR = new Set([
  'acilis',          // uygulama açıldı            { ilk:bool, dil, tz, surum }
  'ekran',           // ekrandan ayrıldı           { ad, sn }
  'sorgu',           // AI sorgusu gönderildi      { tur, dil }
  'sonuc',           // sorgu sonuçlandı           { tur, bulundu:bool, ms, kalan }
  'paywall',         // paywall açıldı             { kaynak/sebep, kalan, urunHazir }
  // durum: basladi | tamam | iptal | hata | urun-yok | urun-geldi
  // `urun-yok` KRİTİK: StoreKit ürünleri yüklenmediği için kullanıcı satın
  // ALAMADI. Bunu ölçmeden dönüşüm oranı yorumlanamaz (paydası yanlış olur).
  'satinalma',       // satın alma akışı           { plan, durum, sebep }
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
// ⚠️ Beyaz listede OLMAYAN alan sessizce düşer. `kalan` istemcide 28 Tem'de
// gönderilmeye başlanmıştı ama buraya eklenmediği için diske hiç inmedi —
// "kaç kullanıcı 5 ücretsiz sorguyu gerçekten tüketiyor" sorusu ölçülemedi.
const ALANLAR = ['ilk', 'dil', 'tz', 'surum', 'ad', 'sn', 'tur', 'bulundu', 'ms', 'kaynak',
  'plan', 'durum', 'acik', 'kari', 'sure', 'yer', 'kalan', 'sebep', 'urunHazir'];

function temizle(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  return String(v).slice(0, 40);
}

/** Bir cihazın olay yığınını diske yazar. Dönen sayı: kabul edilen olay adedi. */
export function olayYaz(cihaz, olaylar) {
  if (!Array.isArray(olaylar) || !olaylar.length) return 0;
  const c = cihazOzet(cihaz);
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
  try {
    eskiyiTemizle();
    const y = dosyaYolu(gunAdi()), veri = satirlar.join('\n') + '\n';
    const mevcut = existsSync(y) ? statSync(y).size : 0;
    if (mevcut + Buffer.byteLength(veri) > GUNLUK_MAX_BAYT) {
      console.warn('[OLAY] günlük disk kotası doldu; yığın yazılmadı'); return 0;
    }
    appendFileSync(y, veri);
  }
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
    accessSync(DIZIN, constants.W_OK);
    const s = statfsSync(DIZIN);
    return { dizin: DIZIN, dosya: d.length, mb: Math.round(bayt / 1048576 * 100) / 100,
      bosMB: Math.round(s.bavail * s.bsize / 1048576), yazilabilir: true,
      kalici: DIZIN.startsWith('/veri'), saklamaGun: SAKLAMA_GUN, gunlukMaxMB: GUNLUK_MAX_BAYT / 1048576 };
  } catch { return { dizin: DIZIN, dosya: 0, mb: 0, yazilabilir: false, kalici: false, saklamaGun: SAKLAMA_GUN }; }
}

// --- Toplama ---------------------------------------------------------------

// Kendi test cihazlarımız. Bunlar hunide gerçek kullanıcı gibi görünüyordu:
// 12 cihazlık ilk ölçümün çoğu bizdik ve "açan → sorgu yapan" oranı olduğundan
// iyi çıkıyordu. Ürün kararını (kota, fiyat, paywall yeri) bu sayıya bakarak
// vermek yanlış yere götürür.
//
// SİLMİYORUZ, sadece özetin dışında tutuyoruz: ham JSONL diskte duruyor, gerekirse
// `testDahil=true` ile geri alınabilir. Silmek, sonradan "acaba neydi" dediğimizde
// geri dönülemez olurdu.
/** Panel ve /olcum için özet. Ham olay döndürmez; yalnız toplamlar. */
// Mağaza yayın tarihleri (App Store). Bir cihaz bir sürümü mağazaya çıkmadan ÖNCE
// çalıştırdıysa o cihaz TestFlight'tır = geliştirici/test cihazı. Yeni sürümde
// buraya bir satır ekle; eklenmezse yalnız "≥3 sürüm" kuralı çalışır.
const SURUM_YAYIN = { '1.6': '2026-09-03' };

// Geliştirici/test cihazı: (a) pencere içinde ≥3 farklı sürüm görmüş (her build'i
// deneyen sahip) ya da (b) bir sürümü mağaza yayın tarihinden önce çalıştırmış
// (TestFlight). Kimlik özetlenmiş olduğundan cihaz adı yerine davranıştan ayrılır.
function gelistiriciCihazlar(ev) {
  const prof = {};
  for (const e of ev) {
    if (e.a !== 'acilis' || !e.surum) continue;
    const p = prof[e.c] || (prof[e.c] = {});
    const g = (e.t || '').slice(0, 10);
    if (!p[e.surum] || g < p[e.surum]) p[e.surum] = g;
  }
  const set = new Set();
  for (const [c, surumler] of Object.entries(prof)) {
    const adlar = Object.keys(surumler);
    if (adlar.length >= 3) { set.add(c); continue; }
    if (adlar.some((s) => SURUM_YAYIN[s] && surumler[s] < SURUM_YAYIN[s])) set.add(c);
  }
  return set;
}

export function ozet(gun = 30, { testDahil = false, cihazDahil = false } = {}) {
  const hepsi = olayOku(gun);
  const gelistirici = testDahil ? new Set() : gelistiriciCihazlar(hepsi.filter((e) => !testMi(e.c)));
  const ev = testDahil ? hepsi : hepsi.filter((e) => !testMi(e.c) && !gelistirici.has(e.c));
  const elenenCihaz = new Set(hepsi.filter((e) => testMi(e.c)).map((e) => e.c)).size;
  const elenenOlay = hepsi.length - ev.length;
  // ?cihaz=1: cihaz başına profil (özetlenmiş kimlik, tz, sürümler, olay sayıları) —
  // "bu sayının içinde ben var mıyım" sorusunu cevaplamak için.
  let cihazlar;
  if (cihazDahil) {
    const pr = {};
    for (const e of hepsi) {
      const p = pr[e.c] || (pr[e.c] = { c: e.c, n: 0, tz: new Set(), surum: new Set(), dil: new Set(), paywall: 0, sorgu: 0, satinalma: 0, ilk: e.t, son: e.t, gelistirici: gelistirici.has(e.c), test: testMi(e.c) });
      p.n++; if (e.tz) p.tz.add(e.tz); if (e.surum) p.surum.add(e.surum); if (e.dil) p.dil.add(e.dil);
      if (e.a === 'paywall') p.paywall++; if (e.a === 'sorgu') p.sorgu++; if (e.a === 'satinalma') p.satinalma++;
      if (e.t < p.ilk) p.ilk = e.t; if (e.t > p.son) p.son = e.t;
    }
    cihazlar = Object.values(pr).sort((a, b) => b.n - a.n).map((p) => ({ ...p, tz: [...p.tz], surum: [...p.surum], dil: [...p.dil] }));
  }
  const say = (o, k, n = 1) => { if (k !== undefined) o[k] = (o[k] || 0) + n; };

  const gunluk = {};            // gün -> { cihaz:Set, olay, sorgu, paywall, satis }
  const cihazIlk = {};          // cihaz -> ilk görülme günü
  const cihazSon = {};          // cihaz -> son görülme günü
  const ekranSure = {};         // ekran -> { sn, kez }
  const dil = {}, tz = {}, surum = {};
  const sorguTur = {}, sonucTur = {};
  const paywallKaynak = {}, satinalma = {}, satinalmaSebep = {}, plan = {};
  const kalanDagilim = {};      // sorgu sonucundaki kalan hak → kaç kez
  let paywallUrunHazir = 0, paywallUrunYok = 0;
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
      case 'sonuc':
        say(sonucTur, `${e.tur}/${e.bulundu ? 'bulundu' : 'boş'}`);
        // Ücretsiz hakkın nerede tükendiğini gösterir: dağılım 5'e yığılıyorsa
        // kullanıcılar ürünü hiç denemiyor, 0'a yığılıyorsa paywall gerçekten
        // tetikleniyor demektir. (premium = -1)
        if (e.kalan !== undefined) say(kalanDagilim, String(e.kalan));
        break;
      case 'paywall': {
        // Eski istemciler (≤1.3) paywallGoster'ı doğrudan click dinleyicisi olarak
        // bağlıyordu → kaynak alanına MouseEvent (obje) geliyor ve panelde
        // "[object Object]" görünüyordu. Dizgi olmayanı tek kovaya topla; bu,
        // depodaki TARİHİ kayıtları da temizler (istemci 1.4'ten beri dizgi yollar).
        const pk = [e.kaynak, e.sebep].find(v => typeof v === 'string' && v)
          ?? ((e.kaynak !== undefined || e.sebep !== undefined) ? 'eski-surum' : undefined);
        say(paywallKaynak, pk); G.paywall++;
        if (e.urunHazir === true) paywallUrunHazir++;
        else if (e.urunHazir === false) paywallUrunYok++;
        break;
      }
      case 'satinalma':
        say(satinalma, e.durum); say(plan, e.plan);
        if (e.sebep) say(satinalmaSebep, e.sebep);
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
    // Ürünler yüklenmediği için satın ALAMAYAN cihaz. Bu sayı büyükse dönüşüm
    // düşüklüğü fiyat/mesaj sorunu değil, ARIZA demektir.
    urunYok: new Set(ev.filter(e => e.a === 'satinalma' && e.durum === 'urun-yok').map(e => e.c)).size,
    satinAlmaBaslatan: new Set(ev.filter(e => e.a === 'satinalma' && e.durum === 'basladi').map(e => e.c)).size,
    abone: new Set(ev.filter(e => e.a === 'satinalma' && e.durum === 'tamam').map(e => e.c)).size,
  };
  // Asıl hedef oran: paywall gören → abone olan.
  huni.oranPaywallAbone = huni.paywallGoren ? Math.round(huni.abone / huni.paywallGoren * 1000) / 10 : null;

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
    // Elenenler görünür kalsın: "sayı neden düştü" sorusu panelde cevaplansın.
    elenen: { cihaz: elenenCihaz, olay: elenenOlay, dahil: testDahil, gelistirici: gelistirici.size },
    ...(cihazlar ? { cihazlar } : {}),
    gunluk: gunListe,
    huni,
    eldeTutma: { d1: eldeTutma(1), d7: eldeTutma(7) },
    ekran: Object.fromEntries(Object.entries(ekranSure).map(([k, v]) =>
      [k, { kez: v.kez, ortSn: Math.round(v.sn / v.kez * 10) / 10, toplamDk: Math.round(v.sn / 60) }])),
    dil, tz, surum, sorguTur, sonucTur, paywallKaynak, satinalma, satinalmaSebep, plan,
    kalanDagilim, paywallUrun: { hazir: paywallUrunHazir, yok: paywallUrunYok },
    paylas, kariIndir, oynat, hata, geriYukle,
    bildirim: { acan: bildirimAc, kapatan: bildirimKapa },
    disk: diskDurumu(),
  };
}
