// hadis-api.mjs — Hadis doğrulama + konuya göre sahih hadis backend'i. Port 8788.
//
// ⚠️ TEMEL İLKE: LLM burada YALNIZCA anlamsal eşleştirme yapar (yapıştırılan metin
// korpustaki hangi hadise karşılık geliyor). Derece (sahih/hasen/zayıf/mevzu) ve kaynak
// HER ZAMAN veritabanından gelir — LLM asla hüküm vermez, hadis/derece üretmez.
//
// Endpoint'ler:
//   POST /api/dogrula {metin}  → eşleşen hadis + DB'den derece/kaynak, yoksa dürüst "bulamadım"
//   POST /api/konu    {konu}   → konuyla ilgili sahih/hasen hadis listesi (DB'den dereceli)
//   GET  /health

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Motor } from './motor.mjs';
import { embedOne, embedder, cos, DIM } from './embed.mjs';
import * as adhan from 'adhan';
import tzlookup from 'tz-lookup';
import Anthropic from '@anthropic-ai/sdk';
import { olayYaz, ozet as olayOzet } from './olay.mjs';
import { panelHtml } from './panel.mjs';

const PORT = process.env.PORT || 8788;
const APP_KEY = process.env.APP_KEY || 'hadis-dev';
const MODEL = process.env.MODEL || 'claude-haiku-4-5';
const SURUM = 1;

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
// RevenueCat sunucu doğrulaması (IAP sahteciliğini engeller). Yoksa uyarı verilir.
const RC_SECRET = process.env.RC_SECRET || '';
// Uç adresi test için değiştirilebilir olmalı (yerel sahte RC ile sunucu-yeniden-
// başlatma senaryosu denenebilsin). Tanımlanmazsa gerçek RevenueCat.
const RC_API = process.env.RC_API || 'https://api.revenuecat.com/v1';
// DÖNÜŞ: true = abone, false = KESİN abone değil, null = DOĞRULANAMADI.
// null ile false'u ayırmak şart: ağ/RC kesintisinde "false" dönmek ödeyen
// kullanıcıyı anında paywall'a düşürürdü.
async function rcPremiumMi(cihaz) {
  if (!RC_SECRET) return null;
  try {
    const r = await fetch(`${RC_API}/subscribers/${encodeURIComponent(cihaz)}`,
      { headers: { Authorization: `Bearer ${RC_SECRET}` }, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return false;               // RC'de böyle bir abone yok
    if (!r.ok) return null;                            // 401/429/5xx → bilinmiyor
    const j = await r.json();
    // refunded_at: Apple para iadesi verdiğinde RevenueCat bu alanı doldurur ama
    // abonelik kaydındaki expires_date GELECEKTE kalabiliyor. Sadece expires_date'e
    // bakmak, parası iade edilmiş kullanıcıya dönem sonuna kadar premium vermek demek.
    // (unsubscribe_detected_at / billing_issues_detected_at premium'u KAPATMAZ:
    //  iptal eden kullanıcı ödediği dönemin sonuna kadar hizmeti hak eder.)
    const gecerli = (o) => Object.values(o || {}).some(x =>
      !x.refunded_at && (!x.expires_date || new Date(x.expires_date) > new Date()));
    // ÖNCE entitlement (doğru yapılandırma). Ama RevenueCat'te ürün/entitlement
    // tanımlı değilse burası BOŞ gelir ve gerçekten ödeyen kullanıcı premium alamaz
    // — yani parayı alıp hizmeti vermemiş oluruz. Abonelik kaydına da bakarız.
    return gecerli(j?.subscriber?.entitlements) || gecerli(j?.subscriber?.subscriptions);
  } catch { return null; }
}
console.log('Korpus yükleniyor...');
const yol = (f) => new URL(`./${f}`, import.meta.url).pathname;
// Büyük veri dosyaları depoda gzip'li tutulur (corpus 134MB → 37MB; GitHub 100MB sınırı).
// .gz varsa onu aç, yoksa düz .json'a düş.
const jsonOku = (ad) => {
  const gz = yol(`${ad}.gz`);
  if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)));
  return JSON.parse(readFileSync(yol(ad), 'utf8'));
};
const corpus = jsonOku('corpus.json');
// Mevzuat (halk arasında yaygın, aslı zayıf/olmayan sözler) — küçük, atıflı, âlim incelemesi bekleyen tohum.
const mevzuat = JSON.parse(readFileSync(yol('mevzuat.json'), 'utf8')).map((m, i) => ({
  id: `m${i}`, kitap: 'mevzuat', kitapTr: 'Halk arasında yaygın söz', kisaTr: 'Yaygın söz',
  no: null, tr: m.metin, ar: '', derece: m.derece, dereceRaw: m.referans,
  alimler: [], kaynak: 'Halk arasında yaygın söz', referans: m.referans, aciklama: m.aciklama, mevzuat: true,
}));
// Hadis: dile göre ayrı lexical motor (tr metni / en metni indekslenir).
const hadisAll = [...corpus, ...mevzuat];
const motorTr = new Motor(hadisAll, 'tr');
const motorEn = new Motor(hadisAll, 'en');
const hadisMotor = (dil) => (dil === 'en' ? motorEn : motorTr);
// Kur'an: ayet korpusu (TR + EN meal + Arapça). Meal getirilir, üretilmez.
const ayat = JSON.parse(readFileSync(yol('ayat.json'), 'utf8'));
// Sûre adları: ayat.json'da yalnız TR ve Latin transliterasyon var. Arapça/Urduca
// arayüzde ayet kaynağı "Al-Baqara 255" diye Latin harflerle çıkıyordu (RTL bir
// ekranda okunmuyor). sure.json Arapça adı taşıyor → sûre no ile eşleyip kullan.
const SURE_AD_AR = (() => {
  const m = new Map();
  try {
    for (const s of JSON.parse(readFileSync(yol('sure.json'), 'utf8'))) {
      if (s && s.no && s.adAr) m.set(s.no, String(s.adAr).replace(/^سُوْرَةُ\s*/, '').trim());
    }
  } catch { /* sure.json yoksa Latin ada düşülür */ }
  return m;
})();
// Urduca yazı da Arap alfabesi tabanlı; sûre adı Urduca'da da Arapça yazımıyla
// bilinir. Latin transliterasyon yerine onu veririz.
const sureAdiDil = (a, dil) => (dil === 'tr' ? a.sureAd
  : ((dil === 'ar' || dil === 'ur') && SURE_AD_AR.get(a.sure)) || a.sureAdEn);
// Kur'an semantik indeksi — dile göre ayrı vektör (yerel embedding).
const vekYukle = (f) => { const b = readFileSync(yol(f)); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const kuranVek = { tr: vekYukle('vektor-kuran-tr.f32'), en: vekYukle('vektor-kuran-en.f32') };
// Korpustaki bazı kayıtlar hadis metninin ardına şerh/izah/tahric bloğu ekliyor
// (Fethu'l-Bari, "Diğer tahric", AÇIKLAMA…). Bunlar hadis DEĞİL; aramada
// "ilim adamları/tevazu yoluyla" gibi şerh cümleleri hadis sanılıp konuları
// çökertiyordu. Aramada ve gösterimde yalnızca rivayet metnini kullanırız.
const SERH_KALIP = /(Diğer tahric|Fethu'?l-?Bari|Fethul Bari|İZAH|IZAH|ŞERH|Şerh:|AÇIKLAMA|Açıklama:|Tahric|Not:|Tekrarı?\s*:)/;
// Hadis metni "Bize X rivayet etti… şöyle buyurdu:" diye başlar; asıl söz (matn)
// bundan sonrasıdır. Arama isnad'daki râvi adlarına takılıyordu.
// Korpusun %19'unda kart isnad zinciriyle açılıyordu ("Bize Leys, Ukayl'den; o da
// İbn Şihâb'dan; o da Âişe'den şöyle tahdîs etmiştir: …"). Zincirin halkaları ';' ve
// '.' ile bağlanır, ASIL SÖZ ise ':' (ya da "…etti ki,") ile açılır. Bu geçişin
// metnin ilk %70'indeki SON örneğinden sonrası matn'dır. Ölçüm: 5.926 isnadlı
// kayıttan 3.800'ü düzeliyor, aşırı kırpılan 0.
const MATN_KOK = '(?:tahd[îi]s|riv[âa]yet|haber\\s+ver|naklet|nakled|ded|dedi|demiş|buyur|anlat|söyle|bersabda|a dit|said)';
const MATN_KALIP = new RegExp(MATN_KOK + "[\\wçğıöşüÇĞİÖŞÜ]*(?:\\s+[\\wçğıöşüÇĞİÖŞÜ'’]+){0,2}\\s*(?::|ki\\s*,)", 'gi');
function latinMatn(x) {
  const re = new RegExp(MATN_KALIP.source, 'gi');
  let son = null, m;
  while ((m = re.exec(x))) { if (m.index < x.length * 0.7) son = m; else break; }
  if (!son) return x;
  const kalan = x.slice(son.index + son[0].length).replace(/^[\s:;.,"“«»)\]]+/, '').trim();
  // Kesme sağlıklı mı: cümle harfle başlamalı, bağlaç artığıyla açılmamalı.
  if (kalan.length < 40 || !/^[\p{L}"“]/u.test(kalan) || /^(ki|ve|de|da)\b/i.test(kalan)) return x;
  return kalan;
}

// --- Arapça / Urduca / Endonezce isnad ayıklama ---
// Bu üç dilde MATN_KALIP hiç eşleşmiyordu (kökleri TR/EN/FR) → kartlarda hadis
// yerine üç satır râvi zinciri görünüyordu.
// YÖNTEM: metnin ORTASINDAN kesmek yerine SOLDAN soyma. Ortadan kesme (ilk denenen
// "son rivayet fiili" yöntemi) ölçümde hadisin baş tarafını yiyip parça cümle
// bırakıyordu ("…رسول الله صلى الله عليه وسلم بمخضب" gibi) — dinî içerikte parça
// metin göstermek yanlış bilgidir. Soyma, baştaki halka isnad kalıbına uymadığı
// anda DURUR; en kötü ihtimalle metin olduğu gibi kalır (bugünkü davranış).
// Ölçüm (30.483 kayıt): AR 25.598 kayıt kırpıldı (%84,6), ortalama %72'si korundu,
// 60 harften kısa kalan 0. UR %34,6. ID %90,5.
const HRK = '[\\u064B-\\u0652\\u0670\\u0640\\u06D6-\\u06ED\\u200f]*';   // hareke/tatweel/RLM toleransı
const arEsnek = (w) => w.split('').map(ch => ch === ' ' ? '\\s+' : (/[اأإآ]/.test(ch) ? '[اأإآ]' : ch) + HRK).join('');
// isnad halkası: (قال/فقال…) + rivayet fiili + râvi adı + ',' ya da ':'
const AR_HALKA = ['حدثنا', 'حدثني', 'حدثنيه', 'حدثهم', 'اخبرنا', 'اخبرني', 'اخبرهم', 'انبانا', 'انباني', 'ثنا', 'سمعت', 'عن'].map(w => '(?:' + arEsnek('و') + ')?' + arEsnek(w)).join('|');
const AR_ONEK = ['قال', 'قالت', 'قالا', 'قالوا', 'وقال', 'فقال', 'يقول', 'ح'].map(arEsnek).join('|');
// Baştaki artıklar: (a) ortak râvi — "…، وَإِسْحَاقُ بْنُ إِبْرَاهِيمَ، قَالاَ حَدَّثَنَا"
// ikinci râvi adıyla açılıyor; (b) "- يَعْنِي ابْنَ بِلاَلٍ -" gibi araya sıkışmış
// kimlik notu. İkisi de halka değil ama halkadan ÖNCE geliyor, temizlenmezse
// soyma ilk adımda duruyordu.
const AR_ARTIK = '(?:' + arEsnek('و') + '[^،:]{0,90}[،:][\\s\\u200f]*)?(?:[-ـ][^-ـ]{0,60}[-ـ][\\s،\\u200f]*)?';
const AR_PEEL = new RegExp('^[\\s\\u200f]*' + AR_ARTIK + '(?:(?:' + AR_ONEK + ')' + HRK + '[\\s:،.]*)*(?:' + AR_HALKA + ')' + HRK + '(?![\\u0621-\\u064A])[^،:]{0,120}[،:]' + HRK + '\\s*');
// Urduca: halkalar '،' / '۔' ile ayrılır ve rivayet fiiliyle biter.
const UR_PEEL = /^\s*(?:\(.{0,50}?\)\s*)?(?:ہم\s+سے|ہم\s+کو|ہمیں|مجھ\s+سے|مجھ\s+کو|مجھے|ان\s+سے|ان\s+کو|انہیں|انہوں\s+نے|وہ|اور|پھر|کہا|کہ)?[^،۔]{0,110}?(?:بیان\s+کی(?:ا)?|خبر\s+دی|روایت\s+(?:کی|کرتے\s+ہیں)|نقل\s+ک(?:ی|رتے\s+ہیں)|حدیث\s+سنی|نے|سے)\s*[،۔]\s*/;
// Endonezce: râvi adları köşeli parantez içinde → halka sınırı net.
const ID_PEEL = /^\s*(?:[Tt]elah\s+)?(?:menceritakan|mengabarkan|memberitakan|mengkhabarkan|diceritakan|dikabarkan|meriwayatkan)\s+kepada\s*(?:kami|ku|nya|saya)?[^[]{0,40}\[[^\]]{0,140}\][\s,;]*(?:-[^-]{0,60}-[\s,;]*)?(?:(?:yang|dia|ia|beliau|dan)\s+)?(?:berkata|katanya|mengatakan)?[\s,;:]*|^\s*(?:dan\s+)?[Dd]ari\s+\[[^\]]{0,140}\][\s,;]*(?:-[^-]{0,60}-[\s,;]*)?(?:(?:yang|dia|ia|beliau)\s+)?(?:berkata|katanya|mengatakan)?[\s,;:]*|^\s*(?:aku|saya)\s+mendengar\s+\[[^\]]{0,140}\][\s,;]*(?:berkata|katanya)?[\s,;:]*/;
// Urduca'yı Arapça'dan ayıran harfler (Arapça metinde bulunmaz).
const URDU_HARF = /[ٹڈڑںھہےۃپچژگ]/;
function soyIsnad(x, re) {
  const bas = x;
  for (let i = 0; i < 14; i++) {
    const m = x.match(re);
    if (!m || !m[0]) break;
    const kalan = x.slice(m[0].length).trim();
    // Aşırı soyma koruması: kalan çok kısaysa ya da metnin dörtte birinden azına
    // indiyse soymayı bırak — eksik hadis göstermektense isnadlı tam metin daha iyi.
    if (kalan.length < 60 || kalan.length < bas.length * 0.25) break;
    x = kalan;
  }
  return x;
}
function hadisMatn(t) {
  const x = hadisMetni(t);
  // Dil parametresine değil METNİN KENDİSİNE bakarız: metinAl() istenen dil boşsa
  // en→tr'ye düşüyor, yani 'ar' istenen kayıt İngilizce metin taşıyabiliyor.
  if (/[؀-ۿ]/.test(x)) return soyIsnad(x, URDU_HARF.test(x) ? UR_PEEL : AR_PEEL);
  if (/\[[^\]]+\]|kepada kami|shallallahu/.test(x)) return latinMatn(soyIsnad(x, ID_PEEL));
  return latinMatn(x);
}
function hadisMetni(t) {
  let x = (t || '').trim();
  const m = x.match(SERH_KALIP);
  if (m && m.index > 80) x = x.slice(0, m.index).trim();       // şerhten önceki kısım
  if (x.length > 1400) {                                        // hâlâ çok uzunsa cümle sınırında kes
    const kes = x.lastIndexOf('. ', 1400);
    x = (kes > 300 ? x.slice(0, kes + 1) : x.slice(0, 1400)) + ' …';
  }
  return x;
}

// Hadis metinlerinin normalize kopyası (önek eşleşmeli lexical + alaka kapısı için).
// ÖNCEDEN tek slotluk önbellek vardı: `hadisNorm` yalnız SON dili tutuyordu, dil
// değişen her istek 30.483 kaydı yeniden normalize ediyordu (~700 ms tek çekirdeği
// bloke ederek). Node tek iş parçacıklı olduğu için sunucu çok dilli trafikte
// ~1,2 istek/sn'e düşüyordu. Artık dil BAŞINA kalıcı önbellek + açılışta ısıtma.
// Dizi hadisAll boyundadır (corpus + mevzuat); lexHadis yalnız ilk corpus.length
// öğesini kullanır, alaka kapısı tamamını.
const hadisNormOnbellek = new Map();      // dil → string[]
// Dil başına normalize kopya ~60 MB. Altısını birden tutmak RSS'i 2 GB sınırına
// dayayıp instance'ı öldürüyordu. En son kullanılan NORM_LIMIT dili tutarız;
// düşen dil bir sonraki sorgusunda (~700 ms) yeniden hesaplanır — sonuç aynı.
const NORM_LIMIT = Math.max(1, Number(process.env.NORM_LIMIT || 2));
function hadisNormAl(dil) {
  let arr = hadisNormOnbellek.get(dil);
  if (arr) {                                  // LRU: kullanılanı en sona al
    hadisNormOnbellek.delete(dil); hadisNormOnbellek.set(dil, arr);
    return arr;
  }
  const nf = dil === 'ar' ? arNorm : trNorm;
  arr = hadisAll.map(h => ' ' + nf(hadisMatn(metinAl(h, dil))));
  hadisNormOnbellek.set(dil, arr);
  while (hadisNormOnbellek.size > NORM_LIMIT) {
    const enEski = hadisNormOnbellek.keys().next().value;
    hadisNormOnbellek.delete(enEski);          // v8 sonraki GC'de toplar
  }
  return arr;
}
// sorgu kelimesi, metindeki bir kelimenin ÖNEKİ ise eşleşir (sabır→sabreden değil ama
// sabır→sabırla evet; kelime başına boşluk şartı kısmi/ortadan eşleşmeyi engeller)
function lexHadis(dil, qw) {
  const N = corpus.length, arr = hadisNormAl(dil);
  const arMi2 = dil === 'ar';
  const vars = qw.map(w => (arMi2 ? arVaryant(w) : kokVaryant(w)));
  const idf = vars.map(vs => {
    let n = 0; for (let i = 0; i < N; i++) if (vs.some(v => arr[i].includes(arMi2 ? v : ' ' + v))) n++;
    return Math.log(1 + N / (1 + n));
  });
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sc = 0;
    for (let k = 0; k < vars.length; k++) if (vars[k].some(v => arr[i].includes(arMi2 ? v : ' ' + v))) sc += idf[k];
    out[i] = sc;
  }
  return out;
}

// Kur'an konu aramasının ANA motoru: ÖNEK eşleşmeli, idf ağırlıklı lexical.
// BM25 tam kelime arıyordu ve Türkçe eklerde patlıyordu ("adalet" ↛ "adaleti").
// Önek eşleşmesi bu sorunu çözer; embedding ise anlam desteği verir.
const kuranTok = new Map();                      // dil → [Set(kelime)] (ayet başına)
const kuranDF = new Map();                       // dil → Map(kelime → doküman sayısı)
function kuranIndeks(dil) {
  if (kuranTok.has(dil)) return;
  const nf = dil === 'ar' ? arNorm : trNorm;   // Arapça: harekeleri yok say
  const toks = ayat.map(a => new Set(nf(metinAl(a, dil)).split(' ').filter(w => w.length > 2)));
  const df = new Map();
  for (const t of toks) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  kuranTok.set(dil, toks); kuranDF.set(dil, df);
}
// sorgu kelimesi, ayet kelimesinin ÖNEKİ ise eşleşir (adalet→adaleti, namaz→namazı)
function lexPuan(dil, qw, kati = false) {
  kuranIndeks(dil);
  const arMi = dil === 'ar';
  const toks = kuranTok.get(dil), df = kuranDF.get(dil), N = ayat.length;
  const idf = new Map();
  const esles = (k, v) => arMi ? k.includes(v) : k.startsWith(v);
  for (const w of qw) {
    let n = 0; const vs = arMi ? arVaryant(w) : kokVaryant(w, kati);
    for (const [k, c] of df) if (vs.some(v => esles(k, v))) n += c;
    idf.set(w, Math.log(1 + N / (1 + n)));
  }
  const out = new Float32Array(ayat.length);
  for (let i = 0; i < toks.length; i++) {
    let s = 0;
    for (const w of qw) { const vs = arMi ? arVaryant(w) : kokVaryant(w, kati); for (const k of toks[i]) if (vs.some(v => esles(k, v))) { s += idf.get(w); break; } }
    out[i] = s / Math.sqrt(toks[i].size || 1);
  }
  return out;
}
// Hadis semantik vektörleri (varsa) — konu araması semantik olsun. Yoksa lexical'e düşer.
let hadisVek = null;
try { hadisVek = { tr: vekYukle('vektor-hadis-tr.f32'), en: vekYukle('vektor-hadis-en.f32') }; console.log('Hadis semantik vektörleri yüklendi.'); }
catch { console.log('Hadis vektörleri henüz yok — konu araması lexical modda.'); }
console.log('Embedding modeli yükleniyor (ilk sorgu gecikmesin diye)...');
await embedder();
console.log(`Hazır: ${corpus.length} hadis + ${mevzuat.length} mevzuat | Kur'an ${ayat.length} ayet (TR+EN semantik). Model: ${MODEL}. Anthropic: ${anthropic ? 'açık' : 'YOK (mock)'}`);

// Derece → dile göre etiket + anlam + renk (UI kullanır)
const DERECE_BILGI = {
  sahih: { renk: 'yesil',
    etiket: { tr: 'Sahih', en: 'Sahih (Authentic)', fr: 'Sahih (authentique)', ar: 'صحيح', ur: 'صحیح', id: 'Sahih (Autentik)' },
    anlam: {
      tr: 'Sened yönünden sağlam, güvenilir. Dinî bir delil olarak kullanılabilir.',
      en: 'Sound and reliable in its chain. Can be used as religious evidence.',
      fr: 'Chaîne de transmission solide et fiable. Peut servir de preuve religieuse.',
      ar: 'سنده صحيح موثوق، ويصحّ الاستدلال به.',
      ur: 'سند کے اعتبار سے مضبوط اور قابلِ اعتماد؛ شرعی دلیل کے طور پر قابلِ استعمال۔',
      id: 'Sanadnya kuat dan terpercaya. Dapat dijadikan dalil agama.' } },
  hasen: { renk: 'yesil',
    etiket: { tr: 'Hasen', en: 'Hasan (Good)', fr: 'Hasan (bon)', ar: 'حسن', ur: 'حسن', id: 'Hasan (Baik)' },
    anlam: {
      tr: 'İyi derecede sağlam. Delil olarak kabul edilir; sahihe göre bir alt basamaktır.',
      en: 'Good and acceptable as evidence; one level below sahih.',
      fr: 'Bon et recevable comme preuve ; un niveau en dessous du sahih.',
      ar: 'حسن مقبول للاستدلال، وهو دون الصحيح بدرجة.',
      ur: 'اچھا اور قابلِ قبول؛ صحیح سے ایک درجہ کم۔',
      id: 'Baik dan diterima sebagai dalil; satu tingkat di bawah sahih.' } },
  zayif: { renk: 'turuncu',
    etiket: { tr: 'Zayıf', en: 'Weak (Da\'if)', fr: 'Faible (da\'îf)', ar: 'ضعيف', ur: 'ضعیف', id: 'Lemah (Da\'if)' },
    anlam: {
      tr: 'Kaynakta geçiyor ama senedinde zayıflık var. Güçlü/kesin bir hadis sayılmaz; tek başına hüküm dayanağı olmaz. Faziletlerde ihtiyatla anılabilir.',
      en: 'Found in the source but weak in its chain. Not a strong/decisive report; cannot alone be a basis for a ruling.',
      fr: 'Présent dans la source mais faible dans sa chaîne. Ne peut à lui seul fonder une règle.',
      ar: 'ورد في المصدر لكن في سنده ضعف، ولا يصحّ الاعتماد عليه وحده في الحكم.',
      ur: 'ماخذ میں موجود ہے مگر سند میں کمزوری ہے؛ تنہا حکم کی بنیاد نہیں بن سکتا۔',
      id: 'Terdapat dalam sumber tetapi lemah sanadnya; tidak bisa menjadi dasar hukum sendirian.' } },
  mevzu: { renk: 'kirmizi',
    etiket: { tr: 'Aslı sabit değil', en: 'Not authentically established', fr: 'Sans fondement établi', ar: 'لا أصل له ثابت', ur: 'کوئی ثابت اصل نہیں', id: 'Tidak ada dasar yang sahih' },
    anlam: {
      tr: 'Âlimler bu sözü Peygamber\'e ait güvenilir bir hadis olarak kabul etmiyor; sağlam bir dayanağı yok. Hadis diye aktarmamak daha doğru olur.',
      en: 'Scholars do not accept this as a reliable saying of the Prophet; it has no sound basis. Better not to relay it as a hadith.',
      fr: 'Les savants ne le retiennent pas comme parole fiable du Prophète ; il n\'a pas de fondement solide. Mieux vaut ne pas le rapporter comme hadith.',
      ar: 'لا يعدّه العلماء قولًا ثابتًا عن النبي ﷺ، ولا أصل صحيح له؛ والأولى ألّا يُنقل على أنه حديث.',
      ur: 'علماء اسے نبی ﷺ کا معتبر قول تسلیم نہیں کرتے؛ اس کی کوئی مضبوط بنیاد نہیں۔ بہتر ہے اسے حدیث کے طور پر نقل نہ کیا جائے۔',
      id: 'Para ulama tidak menerimanya sebagai sabda Nabi yang sahih; tidak ada dasar yang kuat. Sebaiknya tidak disampaikan sebagai hadis.' } },
  bilinmiyor: { renk: 'gri',
    etiket: { tr: 'Derece belirsiz', en: 'Grade unclear', fr: 'Degré indéterminé', ar: 'الدرجة غير محددة', ur: 'درجہ غیر واضح', id: 'Derajat tidak jelas' },
    anlam: {
      tr: 'Bu nüsha için elimizde net bir derecelendirme kaydı yok; kesinliği hakkında hüküm vermek doğru olmaz.',
      en: 'We have no clear grading record for this narration; its reliability cannot be stated with certainty.',
      fr: 'Nous n\'avons pas de évaluation claire pour cette version ; sa fiabilité ne peut être affirmée.',
      ar: 'لا يتوفر لدينا تقييم واضح لهذه الرواية، فلا يمكن الجزم بدرجتها.',
      ur: 'اس روایت کے لیے ہمارے پاس واضح درجہ بندی موجود نہیں؛ اس کی صحت پر قطعی حکم نہیں لگایا جا سکتا۔',
      id: 'Kami tidak memiliki catatan penilaian yang jelas untuk riwayat ini; keabsahannya tidak dapat dipastikan.' } },
};

// Desteklenen diller. fr/id/ur/ar: metin yerleşik veriden gelir; semantik eşleştirme
// çok dilli embedding ile EN vektörü üzerinden yapılır (yeni vektör gerekmez).
const DILLER = ['tr', 'en', 'fr', 'id', 'ur', 'ar'];
const dilAl = (d) => (DILLER.includes(d) ? d : 'tr');
// Dil kodu → veri alanı. Endonezce alanı 'idn' (kaydın 'id' alanını ezmemesi için).
const ALAN = { id: 'idn' };
const metinAl = (o, dil) => o[ALAN[dil] || dil] || o.en || o.tr;   // görünen metin, fallback zinciri
// Metnin HANGİ dilden geldiği: kaynak edisyonlarda boşluk var (ind-muslim'in %35'i,
// fr'nin %14'ü boş) ve sessizce İngilizce'ye düşmek kullanıcıya hata gibi görünüyordu.
// Elimizde olmayanı uydurmuyoruz; olmadığını söylüyoruz.
const metinDili = (o, dil) => {
  const k = ALAN[dil] || dil;
  if (o[k] && String(o[k]).trim()) return dil;
  if (o.en && String(o.en).trim()) return 'en';
  return 'tr';
};
const vekAl = (V, dil) => V[dil] || V.en || V.tr;     // fr/id/ur/ar → EN pivot vektör

// Korpustaki âlim/kaynak etiketleri Türkçe üretilmiş ("Buhârî ittifakı",
// "… — Nevevî derlemesi", "Kaynak: …"). Veriyi bozmadan, sunum katmanında çevir.
const ET = {
  ittifak:  { tr: 'ittifakı',   en: 'consensus',        fr: 'consensus',        ar: 'باتفاق',        ur: 'اتفاق',        id: 'kesepakatan' },
  derleme:  { tr: 'derlemesi',  en: 'collection',       fr: 'recueil',          ar: 'مجموعة',        ur: 'مجموعہ',       id: 'kumpulan' },
  kaynak:   { tr: 'Kaynak',     en: 'Source',           fr: 'Source',           ar: 'المصدر',        ur: 'ماخذ',         id: 'Sumber' },
  ve:       { tr: 've',         en: 'and',              fr: 'et',               ar: 'و',             ur: 'اور',          id: 'dan' },
};
const cev = (k, dil) => ET[k][dil] || ET[k].en;
function alimAdi(ad, dil) {
  if (dil === 'tr') return ad;
  return ad
    .replace(/^Kaynak:/, cev('kaynak', dil) + ':')
    .replace(/\s+ve\s+/g, ` ${cev('ve', dil)} `)
    .replace(/\s*ittifakı\s*$/, ` — ${cev('ittifak', dil)}`)
    .replace(/\s*derlemesi\s*$/, ` ${cev('derleme', dil)}`);
}
const alimlerDil = (alimler, dil) => (alimler || []).map(a => ({ ...a, alim: alimAdi(a.alim, dil) }));

// Kaynak etiketi ("Ebû Dâvûd 2201") korpusta TÜRKÇE üretilmişti ve her dilde
// aynen gösteriliyordu: Arapça arayüzde sağdan sola bir kartın altında Türkçe
// şapkalı harflerle "Ebû Dâvûd" yazıyordu (Urduca'da da öyle). Kaynak adı
// veri değil sunum bilgisi → dile göre çevrilir. Numara aynı kalır.
const KITAP_AD = {
  bukhari:  { tr: 'Buhârî',     en: 'Bukhari',     fr: 'Bukhari',      ar: 'البخاري',            ur: 'بخاری',            id: 'Bukhari' },
  muslim:   { tr: 'Müslim',     en: 'Muslim',      fr: 'Muslim',       ar: 'مسلم',               ur: 'مسلم',             id: 'Muslim' },
  tirmidhi: { tr: 'Tirmizî',    en: 'Tirmidhi',    fr: 'Tirmidhi',     ar: 'الترمذي',            ur: 'ترمذی',            id: 'Tirmidzi' },
  abudawud: { tr: 'Ebû Dâvûd',  en: 'Abu Dawud',   fr: 'Abou Dawoud',  ar: 'أبو داود',           ur: 'ابو داؤد',         id: 'Abu Dawud' },
  nasai:    { tr: 'Nesâî',      en: "Nasa'i",      fr: "Nasa'i",       ar: 'النسائي',            ur: 'نسائی',            id: "Nasa'i" },
  ibnmajah: { tr: 'İbn Mâce',   en: 'Ibn Majah',   fr: 'Ibn Majah',    ar: 'ابن ماجه',           ur: 'ابن ماجہ',         id: 'Ibnu Majah' },
  malik:    { tr: 'Muvatta',    en: 'Muwatta',     fr: 'Muwatta',      ar: 'الموطأ',             ur: 'مؤطا',             id: 'Muwatha' },
  nawawi:   { tr: 'Nevevî 40',  en: 'Nawawi 40',   fr: 'Nawawi 40',    ar: 'الأربعون النووية',   ur: 'اربعین نووی',      id: 'Arbain Nawawi' },
};
const KITAP_TAM = {
  bukhari:  { tr: 'Sahîh-i Buhârî',        en: 'Sahih al-Bukhari',   fr: 'Sahih al-Bukhari',  ar: 'صحيح البخاري',       ur: 'صحیح بخاری',        id: 'Shahih Bukhari' },
  muslim:   { tr: 'Sahîh-i Müslim',        en: 'Sahih Muslim',       fr: 'Sahih Muslim',      ar: 'صحيح مسلم',          ur: 'صحیح مسلم',         id: 'Shahih Muslim' },
  tirmidhi: { tr: 'Sünen-i Tirmizî',       en: 'Jami at-Tirmidhi',   fr: 'Jami at-Tirmidhi',  ar: 'سنن الترمذي',        ur: 'سنن ترمذی',         id: 'Sunan Tirmidzi' },
  abudawud: { tr: 'Sünen-i Ebû Dâvûd',     en: 'Sunan Abu Dawud',    fr: 'Sunan Abou Dawoud', ar: 'سنن أبي داود',       ur: 'سنن ابو داؤد',      id: 'Sunan Abu Dawud' },
  nasai:    { tr: 'Sünen-i Nesâî',         en: "Sunan an-Nasa'i",    fr: "Sunan an-Nasa'i",   ar: 'سنن النسائي',        ur: 'سنن نسائی',         id: "Sunan Nasa'i" },
  ibnmajah: { tr: 'Sünen-i İbn Mâce',      en: 'Sunan Ibn Majah',    fr: 'Sunan Ibn Majah',   ar: 'سنن ابن ماجه',       ur: 'سنن ابن ماجہ',      id: 'Sunan Ibnu Majah' },
  malik:    { tr: "Muvatta' (İmam Mâlik)", en: 'Muwatta Malik',      fr: 'Muwatta Malik',     ar: 'موطأ مالك',          ur: 'مؤطا امام مالک',    id: 'Muwatha Malik' },
  nawawi:   { tr: 'Nevevî Kırk Hadis',     en: 'Nawawi Forty Hadith', fr: 'Les Quarante Hadiths de Nawawi', ar: 'الأربعون النووية', ur: 'اربعین نووی', id: 'Arbain Nawawi' },
};
const MEVZUAT_AD = { tr: 'Halk arasında yaygın söz', en: 'Commonly circulated saying', fr: 'Parole largement répandue',
  ar: 'قول شائع بين الناس', ur: 'عوام میں مشہور قول', id: 'Ucapan yang beredar luas' };
function kaynakDil(h, dil) {
  if (h.mevzuat || !KITAP_AD[h.kitap]) return MEVZUAT_AD[dil] || MEVZUAT_AD.en;
  const ad = KITAP_AD[h.kitap][dil] || KITAP_AD[h.kitap].en;
  return h.no == null ? ad : `${ad} ${h.no}`;
}
const kitapAdiDil = (h, dil) => (h.mevzuat || !KITAP_TAM[h.kitap])
  ? (MEVZUAT_AD[dil] || MEVZUAT_AD.en)
  : (KITAP_TAM[h.kitap][dil] || KITAP_TAM[h.kitap].en);

function derecele(h, dil = 'tr') {
  const b = DERECE_BILGI[h.derece] || DERECE_BILGI.bilinmiyor;
  const metin = hadisMatn(metinAl(h, dil)); // şerh + isnad zinciri ayıklanmış; yoksa en→tr
  return {
    id: h.id, tr: metin, ar: h.ar, kaynak: kaynakDil(h, dil), kitapTr: kitapAdiDil(h, dil), no: h.no,
    metinDili: metinDili(h, dil),   // istenen dilden farklıysa istemci uyarı gösterir
    derece: h.derece, dereceEtiket: b.etiket[dil] || b.etiket.en || b.etiket.tr, dereceRenk: b.renk,
    // Grade açıklaması artık 6 dilde; eksikse en→tr'ye düşer.
    dereceAnlam: h.aciklama || (b.anlam[dil] || b.anlam.en || b.anlam.tr),
    dereceRaw: h.dereceRaw, alimler: alimlerDil(h.alimler, dil),
    mevzuat: !!h.mevzuat, referans: h.referans || null,
  };
}

// LLM: yapıştırılan metin hangi adaya karşılık geliyor? (SADECE eşleştirme, hüküm YOK)
async function eslestir(metin, adaylar, dil = 'tr') {
  if (!anthropic) {
    // mock: en yüksek skorlu adayı, skoru belirginse eşleşmiş say. Yakınlığı mock yargılayamaz → null.
    const en = adaylar[0];
    const es = en && en._skor > 12 ? en.id : null;
    return { eslesenId: es, anlamFarki: false, farkNotu: '', yakinId: null, yakinGuven: 0, guven: en ? Math.min(1, en._skor / 40) : 0 };
  }
  // İsnad zinciri ("Bize A tahdis etti… O B'den…") 300 karakterin tamamını yiyip
  // asıl sözü listeden dışarıda bırakıyordu; model karşılaştıramadığı için hem
  // eşleşmeyi kaçırıyor hem anlam farkını göremiyordu. Matn'ı gönder.
  const liste = adaylar.map((a) => `[${a.id}] ${(hadisMatn(metinAl(a, dil)) || '').slice(0, 420)}`).join('\n\n');
  const r = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: 'Sen bir hadis METİN EŞLEŞTİRME aracısın. Görevin SADECE metin ilişkilendirmek — sahihlik/uydurma/hüküm KARARI VERME, bu senin işin değil.\n' +
      '- eslesenId: Yapıştırılan metinle AYNI hadis (aynı Peygamber sözü) olan adayın id\'si. Net karşılık yoksa null.\n' +
      '  Lafız/çeviri farkı normaldir. ANLAM farkı DEĞİLDİR.\n' +
      '- anlamFarki: Kullanıcının metni, eşleşen adayın MANASINI değiştiriyorsa true. Bunlar anlam farkıdır:\n' +
      '  • olumsuzlama eklenmiş/kaldırılmış ("niyetlere göredir" ↔ "niyetlere göre DEĞİLDİR")\n' +
      '  • sayı/miktar değişmiş ("beş şey" ↔ "üç şey")\n' +
      '  • hükmü tersine çeviren kelime ("elinden dilinden EMİN olduğu" ↔ "ZARAR GÖRDÜĞÜ")\n' +
      '  • kaynakta olmayan bir cümle/şart EKLENMİŞ ("…hayır söylesin" ↔ "…dilediğini söylesin", "+kadınlar müstesnadır")\n' +
      '  Şüphedeysen true ver. Yanlış onay, onaysızlıktan çok daha zararlıdır.\n' +
      '- farkNotu: anlamFarki true ise farkı TEK cümleyle, kullanıcının dilinde yaz (ör. "Kaynakta \'beş\' geçiyor, senin metninde \'üç\' yazıyor."). Değilse boş string.\n' +
      '- yakinId: eslesenId null ise VE adaylardan biri kullanıcının metniyle GERÇEKTEN AYNI KONU/MANA taşıyorsa onun id\'si.\n' +
      '  ⚠️ ÇOK ÖNEMLİ: Sırf ortak bir kelime paylaşmak (ör. "imandandır", "iman", "Allah", "cennet", "namaz") YAKINLIK DEĞİLDİR. Konu/mesaj gerçekten örtüşmüyorsa null döndür. Zorlama eşleştirme yanlış bilgidir. Şüphedeysen null.\n' +
      '- yakinGuven: yakinId adayının kullanıcının kastıyla ne kadar aynı konuda olduğunu 0-1 ver (alakasızsa 0).\n' +
      '- guven: 0-1, eslesenId için güvenin.',
    messages: [{ role: 'user', content: `YAPIŞTIRILAN METİN:\n"""${metin.slice(0, 1500)}"""\n\nADAYLAR:\n${liste}\n\nDeğerlendir ve JSON döndür.` }],
    tools: [{
      name: 'eslesme',
      description: 'Eşleşme sonucunu döndür',
      input_schema: {
        type: 'object',
        properties: {
          eslesenId: { type: ['string', 'null'], description: 'Aynı hadis olan adayın id\'si (örn "h123"), yoksa null' },
          anlamFarki: { type: 'boolean', description: 'Kullanıcının metni kaynağın manasını değiştiriyorsa true' },
          farkNotu: { type: 'string', description: 'anlamFarki true ise farkı tek cümleyle anlat, değilse boş' },
          yakinId: { type: ['string', 'null'], description: 'Aynı değil ama GERÇEKTEN aynı konuda en yakın adayın id\'si, yoksa null' },
          yakinGuven: { type: 'number', description: '0-1, yakinId ne kadar aynı konuda' },
          guven: { type: 'number', description: '0-1 arası eşleşme güveni' },
        },
        required: ['eslesenId', 'anlamFarki', 'farkNotu', 'yakinId', 'yakinGuven', 'guven'],
      },
    }],
    tool_choice: { type: 'tool', name: 'eslesme' },
  });
  const tu = r.content.find(c => c.type === 'tool_use');
  return tu ? tu.input : { eslesenId: null, anlamFarki: false, farkNotu: '', yakinId: null, yakinGuven: 0, guven: 0 };
}

// --- Arapça lexical arama (korpustaki asıl Arapça metin üzerinde) ---
// Harekeleri/tatweel'i atar, elif-hemze ve tâ marbûta varyantlarını sadeleştirir,
// sonra nadir kelimelerin örtüşmesine göre puanlar. Üretmez; yalnızca aday getirir.
const arNorm = (s) => (s || '')
  // Osmanî mushafta hareke dışında hançer elif (U+0670) ve durak/tecvid işaretleri
  // (U+06D6–U+06ED) var; bunlar "harf değil" sayılıp BOŞLUĞA çevrilince kelimeler
  // parçalanıyordu (ٱلۡخَمۡرُ → "ل خم ر") ve Arapça arama büyük ölçüde ölüydü.
  .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
  .replace(/\u0671/g, 'ا')     // vasl elifi → elif
  .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^ء-ي\s]/g, ' ').replace(/\s+/g, ' ').trim();
const AR_STOP = new Set(['من','في','على','عن','الى','ان','ما','لا','هو','هي','قال','عليه','وسلم','صلى','الله','رسول','عن','بن','حدثنا','اخبرنا','كان','الي','هذا','التي','الذي']);
let arDF = null; // kelime → kaç kayıtta geçtiği (nadir kelime daha değerli)
function arIndeks() {
  if (arDF) return arDF;
  arDF = new Map();
  for (const h of corpus) {
    if (!h.ar) continue;
    for (const w of new Set(arNorm(h.ar).split(' '))) if (w.length > 2) arDF.set(w, (arDF.get(w) || 0) + 1);
  }
  return arDF;
}
function arapcaAra(sorgu, k = 10) {
  const df = arIndeks(), N = corpus.length;
  const qw = [...new Set(arNorm(sorgu).split(' '))].filter(w => w.length > 2 && !AR_STOP.has(w));
  if (!qw.length) return [];
  const puan = [];
  for (const h of corpus) {
    if (!h.ar) continue;
    const hs = new Set(arNorm(h.ar).split(' '));
    let s = 0;
    for (const w of qw) if (hs.has(w)) s += Math.log(N / (1 + (df.get(w) || 0)));   // idf ağırlığı
    if (s > 0) puan.push([s / Math.sqrt(hs.size || 1), h]);                          // uzunluk normalizasyonu
  }
  puan.sort((a, b) => b[0] - a[0]);
  return puan.slice(0, k).map(([, h]) => h);
}

async function dogrula(metin, dil = 'tr') {
  let adaylar;
  if (dil !== 'tr' && dil !== 'en' && hadisVek) {
    // fr/id/ur/ar: o dilde BM25 indeksi yok → semantik (EN pivot vektör) aday getir.
    // Havuz 8 değil 20: pivot çeviri kaybı yüzünden doğru kayıt ilk 8'in dışında kalabiliyor.
    const qv = await embedOne(metin);
    const vek = vekAl(hadisVek, dil);
    const p = [];
    for (let i = 0; i < corpus.length; i++) p.push([i, cos(vek, i * DIM, qv)]);
    p.sort((a, b) => b[1] - a[1]);
    const sem = p.slice(0, 20).map(([i]) => corpus[i]);
    // Arapça sorguda semantik pivot zayıf (sorgu dili ≠ vektör dili). Asıl Arapça metin
    // korpusta mevcut → kelime örtüşmesiyle doğrudan ara ve adayların başına ekle.
    if (dil === 'ar') adaylar = [...arapcaAra(metin, 10), ...sem].filter((h, i, a) => a.findIndex(x => x.id === h.id) === i).slice(0, 24);
    else adaylar = sem;
  } else {
    adaylar = hadisMotor(dil).ara(metin, 8);
  }
  if (!adaylar.length) return { bulundu: false, yakin: null, benzerler: [] };
  const { eslesenId, anlamFarki, farkNotu, yakinId, yakinGuven, guven } = await eslestir(metin, adaylar, dil);
  const es = eslesenId && guven >= 0.45 ? adaylar.find(a => a.id === eslesenId) : null;
  if (es) {
    // Kaynak sahih olsa bile kullanıcının metni manayı değiştiriyorsa "sahih" demek
    // yanlış bilgidir; kaydı gösterir ama farkı açıkça bildiririz.
    return {
      bulundu: true, guven, anlamFarki: !!anlamFarki, farkNotu: anlamFarki ? (farkNotu || '') : '',
      hadis: derecele(es, dil),
      benzerler: adaylar.filter(a => a.id !== es.id).slice(0, 3).map(a => derecele(a, dil)),
    };
  }
  // Birebir yok. "En yakın rivayet" köprüsü DENENDİ ve KALDIRILDI: hadisler ortak retorik
  // kalıplar ("...bizden değildir", "...imandandır") paylaştığı için LLM sahte konu-yakınlığına
  // kanıyordu (alakasız hadisi "en yakın" diye sunuyordu) = yanlış bilgi. Temiz hüküm veriyoruz.
  return { bulundu: false };
}

// Sorgu genişletme: kavram terimini (tevekkül, infak...) sade Türkçe çeviride
// geçebilecek eş anlamlılara açar. SADECE arama terimi — dinî içerik/hüküm üretmez.
// Sorgu genişletme (sadece TR lexical hadis konu araması için): kavram terimini
// sade Türkçe çeviride geçebilecek eş anlamlılara açar. SADECE arama terimi.
async function genislet(konu, dil) {
  if (!anthropic || dil !== 'tr') return konu; // genişletme sadece TR lexical fallback için
  try {
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 80,
      system: 'Sana verilen dinî konu için, sade Türkçe bir Kur\'an/hadis çevirisinde geçebilecek AYIRT EDİCI kelimeleri ver. Kurallar: (1) kavram çeviride Arapça terimle değil sade Türkçeyle geçebilir (ör. "tevekkül" → "güvenip dayanan, Allah yeter, dayanıp güvensinler"); (2) çok yaygın/jenerik fiil ve kelimelerden KAÇIN ("bırak, ver, yap, gel, de" gibi — bunlar alakasız ayet getirir); (3) konuya ÖZGÜ, ayırt edici isim ve kalıpları tercih et. SADECE virgülle ayrılmış 4-8 kelime/kısa kalıp döndür, açıklama yazma.',
      messages: [{ role: 'user', content: konu }],
    });
    const ek = r.content.find(c => c.type === 'text')?.text || '';
    return `${konu} ${ek}`.slice(0, 300);
  } catch { return konu; }
}

async function konu(sorgu, dil = 'tr') {
  // Kur'an'daki gibi: metinlerde karşılığı olmayan terimi aç ("alkol" hadis
  // metinlerinde hiç geçmez, "içki/şarap" geçer).
  let aramaK = sorgu;
  if (dil === 'tr') { const k = KAVRAM[kavramAnahtar(sorgu)]; if (k) aramaK = `${sorgu} — ${k}`; }
  // Alaka kapısı: konu hadis metinlerinde hiç geçmiyorsa dürüstçe boş dön.
  // (Saf semantik "bilgisayar"a da 10 hadis buluyordu.)
  // Arapça'da harekeleri yok sayan normalizasyon gerekir: harekesiz sorgu (الصبر)
  // harekeli metinde (الصَّبْرُ) hiçbir zaman eşleşmiyordu → ar konu araması ölüydü.
  const norm = dil === 'ar' ? arNorm : trNorm;
  const qwK = [...new Set(norm(aramaK).split(' '))].filter(w => w.length > 2);
  if (qwK.length) {
    // Kapı her istekte 30.483 kaydı YENİDEN normalize ediyordu (sorgu konusu
    // metinlerde geçmiyorsa erken çıkış da olmuyor). Aynı önbelleği kullanır.
    const norms = hadisNormAl(dil);
    let sinyal = false;
    for (let i = 0; i < norms.length; i++) {
      if (qwK.some(w => norms[i].includes(w))) { sinyal = true; break; }
    }
    if (!sinyal) return { konu: sorgu, sonuclar: [], alakasiz: true };
  }
  // Semantik + lexical harman (Kur'an tarafındaki ile aynı mantık): saf semantik
  // "içki" sorgusunda alakasız hadisleri öne çıkarıyordu.
  if (hadisVek) {
    const qv = await embedOne(aramaK);
    const vek = vekAl(hadisVek, dil);
    // lexical: önek eşleşmeli (BM25 tam kelime arıyor, Türkçe eklerde kaçırıyor)
    const qwH = [...new Set((dil === 'ar' ? arNorm : trNorm)(aramaK).split(' '))].filter(w => w.length > 2);
    const lexArrH = qwH.length ? lexHadis(dil, qwH) : null;
    let lexMax = 0; if (lexArrH) for (const v of lexArrH) if (v > lexMax) lexMax = v;
    const tekTerimK = [...new Set(trNorm(sorgu).split(' '))].filter(w => w.length > 2).length <= 2;
    const puan = [];
    for (let i = 0; i < corpus.length; i++) {
      const h = corpus[i];
      if (h.derece !== 'sahih' && h.derece !== 'hasen') continue;
      const lx = lexMax ? lexArrH[i] / lexMax : 0;
      if (tekTerimK && lx === 0) continue;                 // tek terim → o kelime geçmeli
      const sem = cos(vek, i * DIM, qv);
      puan.push([i, (0.35 + 0.65 * lx) * Math.max(0, sem)]);
    }
    puan.sort((a, b) => b[1] - a[1]);
    // korpusta 577 mükerrer kayıt var; aynı metin listede iki kez çıkmasın
    const gor = new Set(), sec = [];
    for (const [i, sk] of puan) {
      if (sec.length >= 10 || sk <= 0) break;
      const imza = trNorm(hadisMetni(metinAl(corpus[i], dil))).slice(0, 90);
      if (gor.has(imza)) continue;
      gor.add(imza); sec.push(i);
    }
    return { konu: sorgu, sonuclar: sec.map(i => derecele(corpus[i], dil)) };
  }
  // Fallback: lexical + sorgu genişletme
  const q = await genislet(sorgu, dil);
  const sonuc = hadisMotor(dil).ara(q, 10, h => h.derece === 'sahih' || h.derece === 'hasen');
  return { konu: sorgu, sonuclar: sonuc.map(a => derecele(a, dil)) };
}

// Kur'an: konuya göre ayet getir — SEMANTİK (anlamsal) arama, dile göre vektör.
// Kullanıcı kavramın adını bilmese de anlamını/tarifini yazınca doğru ayeti bulur.
// Meal + Arapça + okunuş yerleşik veriden GETİRİLİR, LLM üretmez.
// Ayet "hub" düzeltmesi: çok kısa ayetlerin vektörü anlamsal uzayda merkeze yakın
// düşer ve HER sorguya yüksek benzerlik verir (ör. "Cennetime gir" hem "sabır" hem
// "namaz" sorgusunda 1. çıkıyordu). Bunu iki şekilde kırıyoruz:
//   1) her ayetin ortalama benzerliğini (hub skoru) çıkar  → merkezîlik cezası
//   2) semantiği lexical eşleşmeyle harmanla (kelime geçiyorsa öne çıksın)
// Yorumu "dil → Float32Array" diyordu ama TEK bir dizi tutuluyordu: hangi dil
// sunucu açıldıktan sonra ilk sorguyu yaparsa hub cezası O DİLİN vektöründen
// hesaplanıp diğer dillerin skorlarından da çıkarılıyordu. TR ilk sorulursa
// EN/AR sıralaması (ve tersi) yanlış cezayla bozuluyordu. Vektör başına önbellek.
const hubOnbellek = new Map();            // vektör → Float32Array(ayat)
const hubAl = (vek) => {
  let h = hubOnbellek.get(vek);
  if (!h) { h = hubHesapla(vek); hubOnbellek.set(vek, h); }
  return h;
};
function hubHesapla(vek) {
  const n = ayat.length, h = new Float32Array(n);
  const ORNEK = 160, adim = Math.max(1, Math.floor(n / ORNEK));
  const ornekler = [];
  for (let i = 0; i < n; i += adim) ornekler.push(i);
  for (let i = 0; i < n; i++) {
    let t = 0;
    for (const j of ornekler) t += cos(vek, i * DIM, vek.subarray(j * DIM, j * DIM + DIM));
    h[i] = t / ornekler.length;           // bu ayet "genel olarak" ne kadar her şeye benziyor
  }
  return h;
}
// Türkçe ünlü düşmesi: sabır→sabr(eden), şükür→şükr(etmek), akıl→akl(ı).
// Önek eşleşmesi bunları kaçırıyordu; kelimeyi kök varyantıyla birlikte ararız.
// Ünlü düşmesi SADECE bilinen kelimelerde olur. Genel kural uygulayınca
// "yetim"→"yetm" gibi yanlış kökler üretiliyordu ("yetmiş" ile eşleşiyordu).
const UNLU_DUSMESI = {
  sabir: 'sabr', sukur: 'sukr', akil: 'akl', hukum: 'hukm', ilim: 'ilm',
  isim: 'ism', nesil: 'nesl', omur: 'omr', fikir: 'fikr', zulum: 'zulm',
  hayir: 'hayr', sehir: 'sehr', nakil: 'nakl', kisim: 'kism', resim: 'resm',
};
// Arapça kök: harf-i tarif ve tek harfli ön ekleri at (الصبر→صبر, فاصبر→صبر)
// SADECE harf-i tarif atılır. Baştaki tek harfi (و/ف/ب/ك/ل) koşulsuz atmak kökü
// yiyordu: الكبر→"بر", الفقر→"قر", الوالدين→"الدين" (= din!) ve arama saçmalıyordu.
const arKok = (w) => w.replace(/^(وال|فال|بال|كال|لل|ال)/, '');
// Osmanî imlada uzun elif ya hiç yazılmaz ya vav ile yazılır
// (وَٰلِدَيۡنِ = "ولدين", صَلَوٰة = "صلوه"); üç varyantı da ara.
// TÜRETİLEN varyant en az 3 harf olmalı. Elif düşünce 2 harfe inen parça
// on binlerce yerde geçip aramayı ele geçiriyordu: "الربا" → "رب" (= Rab)
// 1062 ayet kelimesiyle eşleşiyor ve "الربا" sorgusu faiz yerine
// "رَبُّ ٱلۡمَشۡرِقَيۡنِ" döndürüyordu (ölçüm: 1062 → 67). "المال" → "مل" 854 → 127.
// KÖK kendisi kısa olsa da korunur, yoksa "الحج" → "حج" tamamen kaybolurdu.
const arVaryant = (w) => {
  const k = arKok(w), v = [k];
  if (k.includes('ا')) for (const t of [k.replace(/ا/g, ''), k.replace(/ا/g, 'و')]) if (t.length >= 3) v.push(t);
  return [...new Set(v)].filter(x => x.length >= 2);
};
const kokVaryant = (w, kati = false) => {
  const v = [w];
  if (UNLU_DUSMESI[w]) v.push(UNLU_DUSMESI[w]);
  // Türev ekleri: "sabretmek"/"yalancılık"/"evlilik" gibi uzun türevlerde
  // kelimenin ilk 5 harfi önek olarak da denenir (sabretmek→sabre, yalancılık→yalan).
  // `kati`: alakasızlık kapısı bu kısayolu KULLANMAZ — "bilgisayar"→"bilgi" diye
  // Kur'an dışı sorgular kapıdan geçiyordu.
  if (!kati && w.length >= 7) v.push(w.slice(0, 5));
  return v;
};
const trNorm = (s) => (s || '').toLocaleLowerCase('tr').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^\p{L}\p{N} ]/gu, ' ');

// Kavram → meâlde geçen karşılık. Diyanet meâli terimi değil ANLAMINI yazar:
// "tevekkül" meâlde hiç geçmez ("Allah'a güven" der), "infak"/"ihlas" da öyle.
// Terimi genişletmezsek arama boşa düşer. (Sadece ARAMA metnini genişletir —
// gösterilen meâl her zaman veriden gelir, üretilmez.)
const KAVRAM = {
  alkol: 'içki, şarap, sarhoş edici içecek, hamr',
  icki: 'içki, şarap, sarhoşluk, hamr',
  kumar: 'kumar, şans oyunu, bahis',
  zina: 'zina, iffetsizlik, namusa aykırı ilişki',
  hirsizlik: 'hırsızlık, çalmak',
  yalan: 'yalan söylemek, doğru olmayan söz',
  komsu: 'komşu, komşuluk hakkı',
  tevekkul: "Allah'a güvenmek, dayanmak, işini Allah'a bırakmak, vekil",
  infak: 'Allah yolunda mal harcamak, sadaka vermek, yoksula vermek',
  ihlas: 'içten, samimi, yalnız Allah için, dini Allah\'a has kılmak',
  takva: 'Allah\'tan sakınmak, korkmak, günahtan kaçınmak',
  sukur: 'şükretmek, Allah\'a şükür, nimetin karşılığını bilmek, nankörlük etmemek',
  tovbe: 'tövbe etmek, günahtan dönmek, bağışlanma dilemek, pişmanlık',
  zikir: 'Allah\'ı anmak, hatırlamak',
  kanaat: 'yetinmek, aza razı olmak, hırs etmemek',
  giybet: 'arkadan çekiştirmek, birinin arkasından kötü konuşmak',
  sila: 'akrabayı ziyaret, akrabalık bağını gözetmek',
  helal: 'temiz ve helal kazanç, haramdan sakınmak',
  kul_hakki: 'başkasının hakkını yemek, haksızlık, zulüm',
};
// Kavramın meâlde BİREBİR geçen ayırt edici karşılığı — lexical kanalına eklenir.
// (Genel kelimeler burada YOK; onlar aramayı ele geçiriyordu.)
const KAVRAM_LEX = {
  alkol: ['sarap'], icki: ['sarap'], kumar: ['kumar'], faiz: ['faiz'],
  giybet: ['cekistir'], tevekkul: ['guven'], infak: ['harca'], zina: ['zina'],
};
const kavramAnahtar = (s) => (s || '').toLocaleLowerCase('tr')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i')
  .replace(/[^a-z ]/g, '').trim().replace(/ +/g, '_');

async function kuranKonu(sorgu, dil = 'tr') {
  // arama metnini zenginleştir: terim + meâldeki karşılığı
  let aramaMetni = sorgu;
  if (dil === 'tr') {
    // Yalnızca meâlde KARŞILIĞI OLMAYAN terimleri aç. Meâlde zaten geçen
    // kelimeler (sabır, namaz, adalet…) olduğu gibi daha iyi sonuç veriyor;
    // serbest LLM genişletmesi bunları bozuyordu, o yüzden kullanılmıyor.
    const k = KAVRAM[kavramAnahtar(sorgu)];
    if (k) aramaMetni = `${sorgu} — ${k}`;
  }
  // ANA: önek eşleşmeli lexical — meâlde geçen kelimeyi eklerine rağmen bulur
  // Lexical KANALI orijinal sorguyla çalışır: kavram genişletmesindeki genel
  // kelimeler ("hak", "mal", "yardım") aramayı ele geçiriyordu. Genişletme
  // yalnızca anlam (embedding) kanalına gider.
  const nfQ = dil === 'ar' ? arNorm : trNorm;
  // Eşik 2 idi: "af", "su", "hac" gibi 2 harfli sorgular lexical listeyi BOŞ bırakıyor,
  // boş liste hem alakasızlık kapısını hem tek-terim korumasını atlatıp saf çöp döndürüyordu.
  const qwLex = [...new Set(nfQ(sorgu).split(' '))].filter(w => w.length >= 2);
  if (dil === 'tr') for (const t of (KAVRAM_LEX[kavramAnahtar(sorgu)] || [])) if (!qwLex.includes(t)) qwLex.push(t);
  const lexArr = qwLex.length ? lexPuan(dil, qwLex) : null;
  let lexMax = 0; if (lexArr) for (const v of lexArr) if (v > lexMax) lexMax = v;
  // Konu Kur'an'da geçmiyorsa DÜRÜSTÇE boş dön. Saf semantik her sorguya bir şey
  // buluyordu: "sigara"→duman ayetleri, "bilgisayar"/"abla"→alakasız. Sorgunun
  // hiçbir kelimesi (kavram karşılığı dahil) meâlde geçmiyorsa konu yok demektir.
  // Kavram sözlüğünde karşılığı olan terim (gıybet→çekiştirmek) meâlde kelime
  // olarak geçmez ama konu Kur'an'da VARDIR → kapıya takılmamalı.
  const kavramVar = dil === 'tr' && !!KAVRAM[kavramAnahtar(sorgu)];
  // Kapı, gevşek varyantlarla (7+ harfin ilk 5'i) değil TAM kelimeyle karar verir:
  // "bilgisayar"→"bilgi", "hastane"→"hasta", "yazılım"→"yazıl" diye Kur'an dışı
  // sorgular ayet döndürüyordu. Sıralama gevşek kalsın, kapı katı olsun.
  const lexKati = qwLex.length ? lexPuan(dil, qwLex, true) : null;
  let katiMax = 0; if (lexKati) for (const v of lexKati) if (v > katiMax) katiMax = v;
  if (qwLex.length && katiMax === 0 && !kavramVar) return { konu: sorgu, sonuclar: [], alakasiz: true };
  const tekTerim = qwLex.length === 1;   // tek terim → lexical, cümle → anlam ağırlıklı
  // DESTEK: semantik — kelime geçmese de anlamca yakın ayetleri yakalar
  const qv = await embedOne(aramaMetni);
  const vek = vekAl(kuranVek, dil);
  const hubSkor = hubAl(vek);
  // sorgu kelimeleri (+0.10 lexical katkı kanalı). trNorm sabitti: Arapça'da
  // harekeler ve tecvid işaretleri "harf değil" sayılıp boşluğa çevriliyor,
  // "الصَّبْرُ" → "ال ص ب ر" gibi parçalara bölünüyordu. Bu yüzden Arapça'da bu
  // kanal ya hiç çalışmıyor ya da tek harflik parçalarla rastgele puan veriyordu.
  const qw = [...new Set(nfQ(aramaMetni).split(' '))].filter(w => w.length > 2);
  const puan = new Array(ayat.length);
  for (let i = 0; i < ayat.length; i++) {
    const a = ayat[i];
    const metin = metinAl(a, dil) || '';
    // merkezîlik cezası: 'her şeye benzeyen' ayetleri düşür. (Bölme denendi ama
    // nadir/tuhaf ayetleri aşırı yükseltiyordu; çıkarma daha dengeli.)
    const sem = cos(vek, i * DIM, qv) - 0.45 * hubSkor[i];        // merkezîlik düzeltmeli semantik
    const lx = lexMax ? lexArr[i] / lexMax : 0;                      // 0..1 normalize lexical
    // ÇARPIM: ikisinin de yüksek olmasını ister. Toplamada tek başına güçlü
    // lexical yetiyordu ve çokanlamlılık sızıyordu ("huzur bulmak" ↔ "huzurumuza
    // getirilecekler"); anlam düşükse artık lexical tek başına yukarı taşımıyor.
    // Taban (0.35) sayesinde kelimesi geçmeyen ama anlamca doğru ayet de kalabiliyor.
    // Tek kelimelik sorgu belirli bir terimdir ("abla", "namaz") → o kelimenin
    // geçtiği ayetler dışına çıkma. Cümlede ise taban katsayı, kelimesi geçmeyen
    // ama anlamca doğru ayetin de listede kalmasını sağlar.
    if (tekTerim && !kavramVar && lx === 0) { puan[i] = [i, -1]; continue; }
    let s = (0.35 + 0.65 * lx) * Math.max(0, sem);
    if (qw.length) {                                        // lexical katkı
      const mn = nfQ(metin);
      let hit = 0; for (const w of qw) if (mn.includes(w)) hit++;
      if (hit) s += 0.10 * (hit / qw.length);   // tam kelime geçişi ek destek
    }
    // bağlamsız kalan çok kısa meâller konu sonucu olarak anlamsız (ör. 'Cennetime gir')
    if (metin.length < 45) s -= 0.05 * (1 - metin.length / 45);   // bağlamsız kısa meâl
    puan[i] = [i, s];
  }
  puan.sort((a, b) => b[1] - a[1]);
  return {
    konu: sorgu,
    sonuclar: (() => {
      const secili = [], alinan = new Set(), gorulenMetin = new Set();
      for (const [i, sk] of puan) {
        if (secili.length >= 10) break;
        if (sk <= 0) break;               // elenenler listeyi doldurmasın (Fâtiha dolgusu)
        // bağlam birleştirmesi komşu ayetleri de kapsıyor → örtüşen sonuçları atla
        if (alinan.has(i) || alinan.has(i - 1) || alinan.has(i + 1)) continue;
        // bazı meâllerde ardışık ayetler aynı cümleyi tekrar eder (ör. Abese 34-37)
        const imza = nfQ(metinAl(ayat[i], dil)).slice(0, 55);
        if (gorulenMetin.has(imza)) continue;
        gorulenMetin.add(imza); alinan.add(i); secili.push([i, sk]);
      }
      return secili;
    })().map(([i, s]) => {
      const a = ayat[i];
      // "Faiz yiyenler", "Şükrederseniz…" gibi tek başına anlam vermeyen kısa
      // meâlleri komşu ayetle tamamla (aynı sûre içinde). Metin yine VERİDEN gelir,
      // sadece bitişik ayet eklenir — üretim yok.
      let metin = metinAl(a, dil), arapca = a.ar || '', ayetEt = String(a.ayet), okunusEt = a.okunus || '';
      if (metin.length < 90) {
        const nx = ayat[i + 1], pv = ayat[i - 1];
        if (nx && nx.sure === a.sure) {
          metin = metin.replace(/[\s.;,]+$/, '') + '. ' + metinAl(nx, dil); arapca += ' ' + (nx.ar || '');
          okunusEt += ' ' + (nx.okunus || ''); ayetEt = `${a.ayet}-${nx.ayet}`;
        } else if (pv && pv.sure === a.sure) {
          metin = metinAl(pv, dil).replace(/[\s.;,]+$/, '') + '. ' + metin; arapca = (pv.ar || '') + ' ' + arapca;
          okunusEt = (pv.okunus || '') + ' ' + okunusEt; ayetEt = `${pv.ayet}-${a.ayet}`;
        }
      }
      const ad = sureAdiDil(a, dil);
      return { id: a.id, sure: a.sure, sureAd: ad, ayet: a.ayet, ayetEt,
        sayfa: a.sayfa, cuz: a.cuz, kaynak: `${ad} ${ayetEt}`,
        ar: arapca, okunus: dil === 'tr' ? okunusEt : '', tr: metin, skor: +s.toFixed(3) };
    }),
  };
}

// Günün ayeti + hadisi — tarihe göre deterministik (herkes aynısını görür, her gün değişir).
// Ayet seçimi bilinen/manevî ayetlerden; metin yine yerleşik veriden gelir.
const GUNUN_AYETLER = [[2,286],[94,5],[13,28],[2,152],[65,3],[39,53],[2,153],[16,128],[14,7],[29,69],[3,139],[10,57],[2,45],[3,159],[93,4],[2,255],[8,46],[64,11],[3,173],[57,4]];
// Ana ekranda bağlamsız gösterilecek içerik: had/ceza, savaş, kıyamet alameti, ırk
// tasviri gibi bağlam isteyen rivayetler günlük ilham kartına uygun değil.
const GUNUN_ELE = /(kıyamet|cehennem|azâb|azap|recm|celde|kırbaç|öldür|katl|savaş|gazve|deccal|zina|cariye|köle|kesil|lânet|lanet|helâk|helak|burnu|yüzlü)/i;
const gununHadisHavuz = corpus.filter(h => h.derece === 'sahih' && h.tr
  && h.tr.length > 60 && h.tr.length < 340
  && !GUNUN_ELE.test(h.tr)
  && !/^\s*(Bize|Bana)\b/.test(h.tr));   // isnad'la açılan kayıt kartta kötü duruyor
function gunSeed() { const d = new Date(); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5); }
function gunun(dil = 'tr') {
  const gi = gunSeed();
  const [s, a] = GUNUN_AYETLER[gi % GUNUN_AYETLER.length];
  const ay = ayat.find(x => x.sure === s && x.ayet === a);
  // (gi*7) havuzun sonunu hiç görmüyordu (366*7 < havuz) → bir yıl boyunca hep aynı
  // bölümden, ardışık kayıtlar geliyordu. Büyük asal ile havuzun tamamına dağıt.
  const hd = gununHadisHavuz.length ? gununHadisHavuz[(gi * 7919) % gununHadisHavuz.length] : null;
  return {
    ayet: ay ? { kaynak: `${sureAdiDil(ay, dil)} ${ay.ayet}`, ar: ay.ar, okunus: dil === 'tr' ? ay.okunus : '', tr: metinAl(ay, dil) } : null,
    hadis: hd ? { kaynak: kaynakDil(hd, dil), tr: hadisMatn(metinAl(hd, dil)), ar: hd.ar, dereceEtiket: (DERECE_BILGI.sahih.etiket[dil] || DERECE_BILGI.sahih.etiket.en) } : null,
  };
}

// Namaz vakitleri + kıble — konuma göre (Diyanet/Türkiye yöntemi).
// Sunucu epoch-ms döndürür; istemci kendi saat diliminde biçimler (kullanıcı konumdadır).
function namaz(lat, lng) {
  const coords = new adhan.Coordinates(lat, lng);
  const params = adhan.CalculationMethod.Turkey();
  const tzAd = (() => { try { return tzlookup(lat, lng); } catch { return 'UTC'; } })();
  // KRİTİK: adhan takvim gününü Date'in YEREL saat diliminden alır. Sunucu TZ'si
  // (Render'da UTC) kullanılırsa Türkiye'de gece 00:00-03:00 arası bir GÜN ESKİ
  // tablo dönüyordu. Takvim gününü kullanıcının kendi saat diliminden kurarız.
  const yerelGun = () => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tzAd, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
    return new Date(+p.year, +p.month - 1, +p.day, 12, 0, 0); // öğle: DST kaymalarına dayanıklı
  };
  const bugun = yerelGun();
  const yarin = new Date(bugun.getTime() + 86400000);
  const pt = new adhan.PrayerTimes(coords, bugun, params);
  const ptYarin = new adhan.PrayerTimes(coords, yarin, params);
  const ms = t => t.getTime();
  return {
    vakitler: { imsak: ms(pt.fajr), gunes: ms(pt.sunrise), ogle: ms(pt.dhuhr), ikindi: ms(pt.asr), aksam: ms(pt.maghrib), yatsi: ms(pt.isha) },
    yarinImsak: ms(ptYarin.fajr), // bugünün hepsi geçtiyse sonraki = yarın imsak
    tz: tzAd, // konumun saat dilimi
    // Kâbe'nin ~2 km yakınında kıble açısı matematiksel olarak tekil (birkaç metrede
    // 100+ derece değişiyor) — kendinden emin bir sayı göstermek yanıltıcı olur.
    kible: +adhan.Qibla(coords).toFixed(1),
    kibleBelirsiz: (Math.abs(lat - 21.4225) < 0.02 && Math.abs(lng - 39.8262) < 0.02) || undefined,
  };
}

// Basit IP başına rate limit (saatte LIMIT istek) — LLM/embedding maliyetini korur.
const istekSayac = new Map();
// --- Anonim kullanım sayacı (kişi/cihaz eşleşmesi YOK, yalnız toplam) ---
// Amaç: hangi aramaların BOŞ döndüğünü görüp korpus/algoritma eksiğini kapatmak.
const olcum = {
  baslangic: new Date().toISOString(),
  istek: {},        // endpoint -> sayı
  dil: {},          // dil -> sayı
  hata: {},         // durum kodu -> sayı
  bosSorgu: [],     // { yol, dil, sorgu } — son 300, cihaz bilgisi yok
  bulunamadi: 0,    // hadis doğrulamada eşleşme yok
  anlamFarki: 0,    // metin kaynaktan farklı uyarısı
};
const say = (o, k) => { o[k] = (o[k] || 0) + 1; };
// Bellek nöbeti: instance sessizce öldürülüyordu; sınıra yaklaşmayı görelim.
setInterval(() => {
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  if (rss > 1500) console.warn(`[BELLEK] RSS ${rss} MB — normalize önbellek: ${hadisNormOnbellek.size} dil`);
}, 300_000).unref();
// Sayaçlar bellekte tutulduğu için her deploy sıfırlıyordu. Yarım saatte bir
// özeti log'a bas: Render logları kalıcı, böylece deploy sonrası da geçmiş kalır.
setInterval(() => {
  const toplam = Object.values(olcum.istek).reduce((a, b) => a + b, 0);
  if (!toplam) return;
  console.log('[OLCUM]', JSON.stringify({
    istek: olcum.istek, dil: olcum.dil, hata: olcum.hata,
    bulunamadi: olcum.bulunamadi, anlamFarki: olcum.anlamFarki,
    aktifCihaz: kullanim.size,
    bosSorgu: olcum.bosSorgu.slice(-25).map(x => `${x.yol}/${x.dil}: ${x.sorgu}`),
  }));
}, 1800_000).unref();
const bosKaydet = (yol, dil, sorgu) => {
  olcum.bosSorgu.push({ yol, dil, sorgu: String(sorgu || '').slice(0, 80), t: new Date().toISOString() });
  if (olcum.bosSorgu.length > 300) olcum.bosSorgu.shift();
};

// --- Hız sınırı: asıl fren CİHAZ, IP yalnızca kaba emniyet supabı ---
// IP başına 120/saat vardı ve bu MEŞRU kullanıcıyı kilitliyordu: TR ve Endonezya'da
// mobil operatörler CGNAT kullanıyor, yüzlerce abone tek genel IP'nin arkasından
// çıkıyor. Aynı kovaya düşen kullanıcılar birbirini 429'a itiyordu — üstelik
// Render'ın kenar proxy'si arkasında kova zaten kaba.
//
// Yeni eşikler ve gerekçesi:
// • IP: 3000/saat. Tek bir cihaz zaten günde 5 AI sorgusuyla (premiumsa da ekran
//   başına birkaç istekle) sınırlı; asıl akış /api/durum + /api/gunun + /api/namaz
//   gibi ucuz uçlar. Ağır bir CGNAT havuzunda 300-500 aktif kullanıcı × saatte
//   ~6 istek ≈ 3000. Eşik bunu geçirir, gerçek bir kötüye kullanımı (saniyede
//   birden fazla istek süren tek IP) hâlâ keser.
// • Cihaz: 300/saat. Tek kullanıcının insani üst sınırının çok üstünde; tek bir
//   cihaz kimliğiyle döngüye giren istemci burada durur. Maliyeti asıl kesen
//   FREE_LIMIT (günde 5 AI sorgusu) zaten yerinde.
const LIMIT = Number(process.env.RATE_LIMIT || 3000);          // IP / saat
const CIHAZ_LIMIT = Number(process.env.CIHAZ_RATE_LIMIT || 300); // cihaz / saat
const cihazSayac = new Map();
// Map'ler istemciden gelen anahtarlarla (IP, cihaz) büyüyor ve hiç temizlenmiyordu.
// Saatte bir süresi geçmiş kayıtları at; premium kayıtları korunur.
setInterval(() => {
  const now = Date.now(), g = bugun();
  for (const [k, v] of istekSayac) if (now > v.reset) istekSayac.delete(k);
  for (const [k, v] of cihazSayac) if (now > v.reset) cihazSayac.delete(k);
  for (const [k, v] of kullanim) if (v.gun !== g) kullanim.delete(k);
  // Premium önbelleği de sınırsız büyümesin. 7 gündür dokunulmamış kaydı at:
  // silinse bile kayıp yok, cihaz döndüğünde RevenueCat'ten yeniden öğrenilir.
  for (const [k, v] of premiumCihaz) if (now - v.guncel > 7 * 86400_000) premiumCihaz.delete(k);
}, 3600_000).unref();
function sayacAstiMi(harita, anahtar, limit) {
  const now = Date.now(), pencere = 3600_000;
  let r = harita.get(anahtar);
  if (!r || now > r.reset) { r = { count: 0, reset: now + pencere }; harita.set(anahtar, r); }
  r.count++;
  return r.count > limit;
}
const limitAsildi = (ip) => sayacAstiMi(istekSayac, ip, LIMIT);
const cihazLimitAsildi = (c) => sayacAstiMi(cihazSayac, c, CIHAZ_LIMIT);

// --- Freemium: cihaz başına GÜNLÜK ücretsiz AI-sorgu; premium (abone) = sınırsız ---
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 5);
const CHECKOUT_URL = process.env.CHECKOUT_URL || ''; // LemonSqueezy/Stripe ödeme linki (kurulunca)
const AI_YOLLAR = ['/api/dogrula', '/api/konu', '/api/kuran-konu']; // limite tabi (namaz serbest)
const kullanim = new Map();      // cihaz -> {gun, sayi}
const bugun = () => new Date().toISOString().slice(0, 10);

// --- Premium durumu: TEK DOĞRULUK KAYNAĞI RevenueCat ---
// ESKİDEN premium kaydı sunucunun belleğinde bir Map'ti. Render her deploy/restart/
// uyanmada süreci sıfırlıyor → o an uygulamada olan ABONE bir sonraki sorgusunda
// 402 yiyip paywall görüyordu. Parası alınmış, hizmeti kesilmiş oluyordu.
// Render'da kalıcı disk YOK (render.yaml'da disk tanımı yok, plan: standard) ve
// disk eklemek tek örneğe bağlar. Bu yüzden kalıcılığı biz TUTMUYORUZ: her cihazın
// premium'u RevenueCat'ten (zaten mağaza makbuzunun tek doğruluk kaynağı) sorulur,
// yanıt kısa süreli bellek önbelleğine yazılır. Süreç ölse de kayıp yok — önbellek
// boşalır, ilk istekte RevenueCat'ten yeniden öğrenilir.
const PREMIUM_TTL = Number(process.env.PREMIUM_TTL_MS || 6 * 3600_000);   // "abone" yanıtı
const PREMIUM_YOK_TTL = Number(process.env.PREMIUM_YOK_TTL_MS || 10 * 60_000); // "abone değil"
const PREMIUM_HATA_TTL = 15 * 60_000;   // RC'ye ulaşılamadı → son bilinen durumu koru
const premiumCihaz = new Map();  // cihaz -> { premium, gecerli, guncel }
async function premiumMi(cihaz) {
  if (!cihaz || cihaz === 'anon') return false;
  const now = Date.now();
  const kayit = premiumCihaz.get(cihaz);
  if (kayit && now < kayit.gecerli) return kayit.premium;
  const sonuc = await rcPremiumMi(cihaz);
  if (sonuc === null) {
    // Doğrulanamadı (RC kesintisi, ağ hatası ya da RC_SECRET yok). Ödeyen
    // kullanıcıyı bu yüzden ücretsize düşürmeyiz: son BİLİNEN durumu koruruz.
    if (kayit) { kayit.gecerli = now + PREMIUM_HATA_TTL; return kayit.premium; }
    return false;   // hiç kaydımız yok → premium veremeyiz (bedava premium açığı olmasın)
  }
  premiumCihaz.set(cihaz, { premium: sonuc, guncel: now,
    gecerli: now + (sonuc ? PREMIUM_TTL : PREMIUM_YOK_TTL) });
  return sonuc;
}
function kalanHak(c, prem) {
  if (prem) return Infinity;
  const r = kullanim.get(c);
  if (!r || r.gun !== bugun()) return FREE_LIMIT;
  return Math.max(0, FREE_LIMIT - r.sayi);
}
function hakKullan(c) {
  let r = kullanim.get(c);
  if (!r || r.gun !== bugun()) { r = { gun: bugun(), sayi: 0 }; kullanim.set(c, r); }
  r.sayi++;
}

// --- Basit HTTP sunucu (CORS + app-key + rate limit + gövde sınırı) ---
function govde(req) {
  return new Promise((res, rej) => {
    let d = ''; let n = 0;
    req.on('data', c => { n += c.length; if (n > 200_000) { rej(new Error('gövde büyük')); req.destroy(); } d += c; });
    req.on('end', () => res(d));
  });
}

const sunucu = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-app-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');
  // Anonim kullanım özeti — yalnızca OLCUM_ANAHTAR tanımlıysa ve doğru anahtarla.
  if (url.pathname === '/olcum') {
    const anahtar = process.env.OLCUM_ANAHTAR || '';
    if (!anahtar || url.searchParams.get('k') !== anahtar) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ...olcum,
      toplamIstek: Object.values(olcum.istek).reduce((a, b) => a + b, 0),
      aktifCihaz: kullanim.size,
      // Kalıcı bir premium kaydı yok; bu yalnızca RevenueCat yanıtlarının önbelleği.
      premiumOnbellek: premiumCihaz.size,
      premiumOnbellekAbone: [...premiumCihaz.values()].filter(v => v.premium).length,
    }, null, 1));
  }

  // Ürün analitiği paneli — aynı anahtarla korunur. Anahtar yoksa uç yok.
  if (url.pathname === '/panel' || url.pathname === '/panel.json') {
    const anahtar = process.env.OLCUM_ANAHTAR || '';
    if (!anahtar || url.searchParams.get('k') !== anahtar) { res.writeHead(404); return res.end(); }
    const gun = Math.min(365, Math.max(1, Number(url.searchParams.get('gun')) || 30));
    const o = olayOzet(gun);
    if (url.pathname === '/panel.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(o, null, 1));
    }
    // Panel URL'i anahtar taşıyor: arama motorlarına ve yönlendirenlere sızmasın.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
    return res.end(panelHtml(o));
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, surum: SURUM, hadis: corpus.length, ayet: ayat.length, model: MODEL, llm: !!anthropic }));
  }

  // /app-ads.txt KALDIRILDI: uygulamada hiç reklam yok (AdMob SDK'sı da yok).
  // AdMob envanteri beyan eden bir dosya yayınlamak yanlış beyandı; paywall'daki
  // "reklamsız" vaadiyle de çelişiyordu.

  // Statik sunum: uygulama HTML'i + fontlar (tek servis olsun diye).
  if (req.method === 'GET') {
    const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
    let p = url.pathname === '/' ? '/hadis.html' : url.pathname;
    if (p === '/gizlilik') p = '/gizlilik.html';
    if (p === '/kullanim') p = '/kullanim.html';
    if (/^\/(hadis\.html|gizlilik\.html|kullanim\.html|fonts\.css|fonts\/[\w.-]+\.woff2)$/.test(p)) {
      try {
        const dosya = readFileSync(yol(p.replace(/^\//, '')));
        const ext = p.slice(p.lastIndexOf('.'));
        // HTML/CSS taze kalsın (redeploy'da anında güncellensin); fontlar uzun cache.
        const cache = ext === '.woff2' ? 'public, max-age=604800' : 'no-cache';
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
        return res.end(dosya);
      } catch { /* aşağıda 404 */ }
    }
  }

  try {
    // /api/lisans KALDIRILDI: IAP dışı kilit açma App Store 3.1.1 ihlali. Uç kapalı
    // durumdaydı ama TEST_LISANS bir gün Render panelinden girilirse yeniden açılırdı.
    // Analitik yığını. Kotadan ve LLM yolundan tamamen ayrı: ölçüm yüzünden
    // kullanıcının ücretsiz sorgusu eksilmesin, ölçüm kesintisi de sorguyu bozmasın.
    // Yanıt her hâlükârda 204 — istemci hata görürse olayları biriktirip tekrar
    // dener, bu da diski aynı veriyle iki kez doldurur.
    if (req.method === 'POST' && url.pathname === '/api/olay') {
      if (req.headers['x-app-key'] !== APP_KEY) { res.writeHead(401); return res.end(); }
      try {
        const b = JSON.parse((await govde(req)) || '{}');
        olayYaz(b.cihaz, b.olaylar);
      } catch { /* bozuk yığın sessizce düşer */ }
      res.writeHead(204); return res.end();
    }

    const POST_YOLLAR = ['/api/dogrula', '/api/konu', '/api/kuran-konu', '/api/namaz', '/api/durum', '/api/gunun', '/api/iap-onay'];
    if (req.method === 'POST' && POST_YOLLAR.includes(url.pathname)) {
      if (req.headers['x-app-key'] !== APP_KEY) { res.writeHead(401); return res.end(JSON.stringify({ hata: 'yetkisiz' })); }
      // X-Forwarded-For istemciden gelir ve taklit edilebilir; SADECE güvenilir proxy
      // arkasındayken (Render) kullan. Aksi halde soket adresi esas alınır.
      const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ip = (process.env.PROXY_GUVENILIR === '1' && xff) || req.socket.remoteAddress || 'x';
      if (limitAsildi(ip)) { say(olcum.hata, '429'); res.writeHead(429); return res.end(JSON.stringify({ hata: 'çok fazla istek, biraz bekleyin' })); }
      // Bozuk gövde istemci hatasıdır; 500 dönmek hem yanıltıcı hem de log'u
      // gerçek sunucu hatalarıyla dolduruyordu.
      const ham = await govde(req);
      let body;
      try { body = JSON.parse(ham || '{}'); }
      catch { say(olcum.hata, '400'); res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ hata: 'gecersiz-govde' })); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
      const dil = dilAl(body.dil);
      say(olcum.istek, url.pathname); say(olcum.dil, dil);
      const cihaz = (body.cihaz || '').toString().slice(0, 64) || 'anon';
      // Asıl fren burada: cihaz başına saatlik tavan. IP kovası CGNAT yüzünden
      // meşru kullanıcıyı komşusuyla birlikte cezalandırıyordu.
      if (cihaz !== 'anon' && cihazLimitAsildi(cihaz)) {
        say(olcum.hata, '429'); res.writeHead(429);
        return res.end(JSON.stringify({ hata: 'çok fazla istek, biraz bekleyin' }));
      }
      // `yerli` istemciden geliyordu: gövdeye yerli:false yazan herkes kotayı tamamen
      // atlatıyordu (sınırsız ücretsiz AI çağrısı). Kota artık herkese uygulanır.

      // IAP onayı — satın alma SUNUCUDA RevenueCat'e sorulur; istemcinin sözüne güvenilmez.
      if (url.pathname === '/api/iap-onay') {
        // Doğrulama anahtarı yoksa premium VERİLMEZ. Önceden bu durumda kontrol
        // tamamen atlanıyordu: tek curl ile kalıcı premium alınabiliyordu.
        if (!RC_SECRET) {
          res.writeHead(503, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ premium: false, hata: 'dogrulama-yapilandirilmadi' }));
        }
        const ok = await rcPremiumMi(cihaz);   // true / false / null(doğrulanamadı)
        if (ok !== true) {
          res.writeHead(ok === null ? 503 : 402, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ premium: false, hata: ok === null ? 'dogrulanamadi-gecici' : 'dogrulanamadi' }));
        }
        premiumCihaz.set(cihaz, { premium: true, guncel: Date.now(), gecerli: Date.now() + PREMIUM_TTL });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ premium: true }));
      }
      // Günün ayeti + hadisi (limitsiz)
      if (url.pathname === '/api/gunun') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(gunun(dil)));
      }
      // Premium durumu RevenueCat'ten (kısa ömürlü önbellekle) gelir — sunucunun
      // belleğinde kalıcı bir kayıt YOK, restart premium'u uçurmaz.
      const prem = (url.pathname === '/api/durum' || AI_YOLLAR.includes(url.pathname))
        ? await premiumMi(cihaz) : false;
      // Durum: premium mi + kalan hak
      if (url.pathname === '/api/durum') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ premium: prem, kalan: prem ? -1 : kalanHak(cihaz, prem), limit: FREE_LIMIT, checkout: CHECKOUT_URL }));
      }
      // AI-sorgu limiti (namaz hariç, sadece native)
      if (AI_YOLLAR.includes(url.pathname) && !prem && kalanHak(cihaz, prem) <= 0) {
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ hata: 'limit', premium: false, limit: FREE_LIMIT, checkout: CHECKOUT_URL }));
      }

      let out;
      if (url.pathname === '/api/namaz') {
        const lat = Number(body.lat), lng = Number(body.lng ?? body.lon);
        if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ hata: 'konum geçersiz' }));
        }
        out = namaz(lat, lng);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out));
      }
      if (url.pathname === '/api/dogrula') {
        const metin = (body.metin || '').trim();
        if (metin.length < 8) { res.writeHead(400); return res.end(JSON.stringify({ hata: 'metin çok kısa' })); }
        out = await dogrula(metin, dil);
        if (!out.bulundu) { olcum.bulunamadi++; bosKaydet('dogrula', dil, metin); }
        if (out.anlamFarki) olcum.anlamFarki++;
      } else if (url.pathname === '/api/kuran-konu') {
        const k = (body.konu || '').trim();
        if (k.length < 2) { res.writeHead(400); return res.end(JSON.stringify({ hata: 'konu boş' })); }
        out = await kuranKonu(k, dil);
        if (!(out.sonuclar || []).length) bosKaydet('kuran-konu', dil, k);
      } else {
        const k = (body.konu || '').trim();
        if (k.length < 2) { res.writeHead(400); return res.end(JSON.stringify({ hata: 'konu boş' })); }
        out = await konu(k, dil);
        if (!(out.sonuclar || []).length) bosKaydet('konu', dil, k);
      }
      // AI sorgusu başarılı → hak düş + kalan bilgisini ekle
      if (AI_YOLLAR.includes(url.pathname)) {
        if (!prem) hakKullan(cihaz);
        out.kalan = prem ? -1 : kalanHak(cihaz, prem);
        out.premium = prem;
        out.limit = FREE_LIMIT;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500); return res.end(JSON.stringify({ hata: 'sunucu hatası' }));
  }
  res.writeHead(404); res.end(JSON.stringify({ hata: 'yok' }));
});

// Normalize edilmiş hadis metinlerini AÇILIŞTA hesapla (dinlemeye başlamadan önce):
// dil değiştiren her istek 30.483 kaydı yeniden normalize edip tek çekirdeği
// ~700 ms bloke ediyordu. Bellek maliyeti log'a yazılır, sürpriz olmasın.
// BELLEK: 6 dilin tamamı ~370 MB tutuyor (ölçüldü; toplam RSS ~1,2 GB, Render
// standard planında 2 GB var). Bellek sıkışırsa NORM_DILLER ile ısıtılan dil
// listesi kısaltılabilir; listede olmayan dil ilk sorgusunda (bir kereye mahsus
// ~700 ms) hesaplanıp yine önbelleğe alınır — sonuç değişmez, yalnız ilk istek yavaşlar.
{
  // Varsayılan artık TÜM diller değil: 6 dil ısıtmak +360 MB demekti ve bellek
  // sınırını aşıyordu. tr+en ısınır, diğerleri ilk sorgularında hesaplanır.
  const istenen = (process.env.NORM_DILLER || '').split(',').map(s => s.trim()).filter(d => DILLER.includes(d));
  const isit = istenen.length ? istenen : ['tr', 'en'];
  const t0 = Date.now(), m0 = process.memoryUsage().heapUsed;
  for (const d of isit) hadisNormAl(d);
  console.log(`Normalize hadis indeksi: ${isit.length} dil (${isit.join(',')}), ${Date.now() - t0} ms, ` +
    `+${Math.round((process.memoryUsage().heapUsed - m0) / 1048576)} MB | RSS ` +
    `${Math.round(process.memoryUsage().rss / 1048576)} MB`);
}

// Port doluysa (eski süreç hâlâ ayakta, yanlış PORT) 'error' dinleyicisi olmadan
// EADDRINUSE yakalanmamış istisna olarak süreci öldürüyordu — Render'da sebebi
// belirsiz bir çökme olarak görünüyordu. Sebebi açıkça yaz, temiz çık.
sunucu.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') console.error(`HATA: ${PORT} portu kullanımda. Eski süreci kapat ya da PORT değiştir.`);
  else console.error('Sunucu hatası:', e);
  process.exit(1);
});
sunucu.listen(PORT, () => console.log(`\n▶ http://localhost:${PORT}  (/health, /api/dogrula, /api/konu)`));
