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
import { readFileSync, existsSync, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { embedOne, embedder, cos, cosI8, DIM } from './embed.mjs';
import * as depo from './depo.mjs';
import { metinAl, metinDili, trNorm, arNorm, hadisMatn, hadisMetni, DILLER } from './metin.mjs';
import * as adhan from 'adhan';
import tzlookup from 'tz-lookup';
import Anthropic from '@anthropic-ai/sdk';
import { olayYaz, ozet as olayOzet, diskDurumu } from './olay.mjs';
import { panelHtml } from './panel.mjs';
import { toplamKota } from './kota.mjs';

const PORT = process.env.PORT || 8788;
const APP_KEY = process.env.APP_KEY || 'hadis-dev';
const MODEL = process.env.MODEL || 'claude-haiku-4-5';
const SURUM = '1.5';
const BUILD_SHA = process.env.RENDER_GIT_COMMIT || process.env.BUILD_SHA || 'yerel';
const PLUS_URUNLER = new Set(['mihenk_plus_aylik', 'mihenk_plus_yillik']);

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
// RevenueCat sunucu doğrulaması (IAP sahteciliğini engeller). Yoksa uyarı verilir.
const RC_SECRET = process.env.RC_SECRET || '';
// Uç adresi test için değiştirilebilir olmalı (yerel sahte RC ile sunucu-yeniden-
// başlatma senaryosu denenebilsin). Tanımlanmazsa gerçek RevenueCat.
const RC_API = process.env.RC_API || 'https://api.revenuecat.com/v1';
// DÖNÜŞ: true = abone, false = KESİN abone değil, null = DOĞRULANAMADI.
// null ile false'u ayırmak şart: ağ/RC kesintisinde "false" dönmek ödeyen
// kullanıcıyı anında paywall'a düşürürdü.
// RevenueCat'in GET /subscribers/{id} ucu, olmayan kimliği SESSİZCE OLUŞTURUR.
// Yani her sorgu RC'de bir "müşteri" doğuruyor. 16 Ağu 2026'da arama düzeltmelerini
// canlı API'ye karşı ölçerken ~950 ayrı test kimliği kullanıldı ve RC panelinde
// 837 sahte müşteri belirdi — bir günde patlayan kullanıcı grafiği tamamen buydu.
// Ölçüm kimlikleri RC'ye HİÇ sorulmaz (analitikteki elemeyle aynı desen).
const TEST_KIMLIK = /^(test-|degerlendirme-|ekran-goruntusu-|teshis-)/;

async function rcPremiumMi(cihaz) {
  if (!RC_SECRET || TEST_KIMLIK.test(String(cihaz || ''))) return null;
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
    const gecerli = (x) => x && !x.refunded_at
      && (!x.expires_date || new Date(x.expires_date) > new Date());
    // Başka bir RevenueCat entitlement/ürünü Mihenk Plus açamaz. Uygulama aynı
    // projeye ileride başka ürün eklerse "herhangi bir aktif abonelik" kontrolü
    // yanlışlıkla sınırsız arama verirdi.
    const ent = Object.values(j?.subscriber?.entitlements || {}).some(x =>
      PLUS_URUNLER.has(x?.product_identifier) && gecerli(x));
    const sub = Object.entries(j?.subscriber?.subscriptions || {}).some(([urun, x]) =>
      PLUS_URUNLER.has(urun) && gecerli(x));
    return ent || sub;
  } catch { return null; }
}
console.log('Depo açılıyor (SQLite)...');
const yol = (f) => new URL(`./${f}`, import.meta.url).pathname;
// Korpus artık RAM'de DEĞİL: metinler mihenk.db'de (depo.mjs), BM25 → FTS5,
// normalize kopyalar inşa anında yazıldı. 30k×6 dil JSON'u belleğe açmak ~1 GB
// tutuyor ve Standard (2 GB) plana mahkûm ediyordu; hedef 512 MB (Starter).
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
// Kur'an semantik indeksi — dile göre ayrı vektör (yerel embedding), f32 (18 MB).
const vekYukle = (f) => { const b = readFileSync(yol(f)); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const kuranVek = { tr: vekYukle('vektor-kuran-tr.f32'), en: vekYukle('vektor-kuran-en.f32') };
// Şerh ayıklama + isnad soyma + normalizasyon fonksiyonları metin.mjs'e taşındı
// (db-yap.mjs inşada aynılarını kullanır — çift kopya sapması olmasın diye).

// lexHadis: sorgu kelimesi, metindeki bir kelimenin ÖNEKİ ise eşleşir (Arapça’da
// substring — kökler eklerin içinde geçer). Tarama artık SQL LIKE ile C tarafında
// (depo.hadisEslesen: dil başına ayrı hnorm_* tablosu, ~20 MB okuma); JS’e yalnız
// eşleşen satır numaraları döner. Puanlama eski davranışla birebir:
// n = kelimenin (varyantlarından biriyle) geçtiği corpus kaydı sayısı, out[i] = Σ idf.
// DENENDİ VE ATILDI (8 Ağu 2026 ölçümü, degerlendirme-calistir.mjs): (a) "kapsam" çarpanı — kaydın sorgunun
// kaç farklı kelimesini içerdiği ayrı bir kanal olarak eklendi; kavram sözlüğü
// olmadan ilk5 132→133 getiriyordu ama sözlükle birlikte ilk5'i değiştirmeyip
// ilk10'u 271→268'e DÜŞÜRDÜ (gıybet 3/5→2/5). (b) Yaygın kelimeleri (df > %15)
// lexical kanaldan elemek — ilk5 hiç değişmedi, %5 eşiğinde ilk10 bir puan düştü.
// İkisi de kaldırıldı; kazanç kavram sözlüğünden (KAVRAM_HADIS) geldi.
function lexHadis(dil, qw) {
  const N = depo.nCorpus;
  const arMi2 = dil === 'ar';
  const out = new Float32Array(N);
  for (const w of qw) {
    const vars = arMi2 ? arVaryant(w) : kokVaryant(w);
    // الربا içindeki kök "ربا", Arapçada "Rabbimiz olarak" anlamındaki ربا ile
    // aynı yazılır. Harf-i tarifli faiz sorgusunda yalın biçimi kabul etmek
    // tamamen alakasız "رضينا بالله ربا" rivayetlerini öne çıkarıyordu.
    const arYalin = !(arMi2 && arKok(w) === 'ربا' && /^(وال|فال|بال|كال|لل|ال)/.test(w));
    const rows = depo.hadisEslesen(dil, vars, arYalin).filter(i => i <= N);   // mevzuat satırları puan dışı
    const idf = Math.log(1 + N / (1 + rows.length));
    for (const i of rows) out[i - 1] += idf;
  }
  return out;
}

// Kur'an konu aramasının ANA motoru: ÖNEK eşleşmeli, idf ağırlıklı lexical.
// BM25 tam kelime arıyordu ve Türkçe eklerde patlıyordu ("adalet" ↛ "adaleti").
// Önek eşleşmesi bu sorunu çözer; embedding ise anlam desteği verir.
// Dil başına Kur’an arama verisi: norm/metin dizileri + kelime kümeleri + df.
// 6236 ayet ≈ 3-5 MB/dil; LRU 3 dil. Eski kuranTok/kuranDF davranışının birebir
// karşılığı — yalnız kaynak artık RAM’deki ayat dizisi değil, depo (SQLite).
const kuranDilOnbellek = new Map();   // dil → { toks, df, metin, norm }
const KURAN_LRU = 3;
function kuranDil(dil) {
  let v = kuranDilOnbellek.get(dil);
  if (v) { kuranDilOnbellek.delete(dil); kuranDilOnbellek.set(dil, v); return v; }
  const { norm, metin } = depo.ayetDilYukle(dil);
  const toks = norm.map(n => new Set(n.split(' ').filter(w => w.length > 2)));
  const df = new Map();
  for (const t of toks) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  v = { toks, df, metin, norm };
  kuranDilOnbellek.set(dil, v);
  while (kuranDilOnbellek.size > KURAN_LRU) kuranDilOnbellek.delete(kuranDilOnbellek.keys().next().value);
  return v;
}
// sorgu kelimesi, ayet kelimesinin ÖNEKİ ise eşleşir (adalet→adaleti, namaz→namazı)
function lexPuan(dil, qw, kati = false) {
  const { toks, df } = kuranDil(dil);
  const arMi = dil === 'ar';
  const N = depo.nAyet;
  const idf = new Map();
  // Endonezce'de ek kelimenin BAŞINA gelir (tawakal→bertawakal, sedekah→bersedekah,
  // adil→keadilan): önek eşleşmesi bu dilde sorguyu tam ters yönden kaçırıyor ve
  // meâlde apaçık geçen konu "alakasız" dönüyordu. 4+ harfte içerme ara — kısa
  // kelimede içerme gürültü yapıyor.
  const icMi = dil === 'id';
  const esles = (k, v) => (arMi || (icMi && v.length >= 4)) ? k.includes(v) : k.startsWith(v);
  for (const w of qw) {
    let n = 0; const vs = arMi ? arVaryant(w) : kokVaryant(w, kati);
    for (const [k, c] of df) if (vs.some(v => esles(k, v))) n += c;
    idf.set(w, Math.log(1 + N / (1 + n)));
  }
  const out = new Float32Array(N);
  for (let i = 0; i < toks.length; i++) {
    let s = 0;
    for (const w of qw) { const vs = arMi ? arVaryant(w) : kokVaryant(w, kati); for (const k of toks[i]) if (vs.some(v => esles(k, v))) { s += idf.get(w); break; } }
    out[i] = s / Math.sqrt(toks[i].size || 1);
  }
  return out;
}
// Hadis semantik vektörleri (varsa) — konu araması semantik olsun. Yoksa lexical'e düşer.
let hadisVek = null;
// int8 (v·127): 90 MB f32 yerine 22 MB. cosI8 ile karşılaştırılır; sıralama etkisi
// ölçüldü (azami kosinüs sapması ~0.007).
const i8Yukle = (f) => { const b = readFileSync(yol(f)); return new Int8Array(b.buffer, b.byteOffset, b.length); };
try { hadisVek = { tr: i8Yukle('model/vektor-hadis-tr.i8'), en: i8Yukle('model/vektor-hadis-en.i8') }; console.log('Hadis semantik vektörleri yüklendi (int8).'); }
catch { console.log('Hadis vektörleri henüz yok — konu araması lexical modda.'); }
// Model ARKA PLANDA ısınır, boot'u BLOKLAMAZ: düşük CPU'lu instance'ta deploy sonrası
// uyanış hızlı kalsın — /health, statik sayfa, günün içeriği ve namaz model
// beklemeden yanıt verir; semantik uçlar hazır olana dek embedOne içinde bekler.
console.log('Embedding modeli arka planda yükleniyor...');
embedder().then(() => console.log('Embedding modeli hazır.'))
  .catch(e => console.error('Embedding modeli YÜKLENEMEDİ (semantik uçlar çalışmaz):', e.message));
console.log(`Hazır: ${depo.nCorpus} hadis + ${depo.nHadisAll - depo.nCorpus} mevzuat | Kur'an ${depo.nAyet} ayet (TR+EN semantik). Model: ${MODEL}. Anthropic: ${anthropic ? 'açık' : 'YOK (mock)'}`);

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
// (DILLER/metinAl/metinDili metin.mjs'ten gelir — inşa katmanıyla ortak.)
const dilAl = (d) => (DILLER.includes(d) ? d : 'tr');
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
    dereceAnlam: (h.mevzuat && dil !== 'tr')
      ? (b.anlam[dil] || b.anlam.en || b.anlam.tr)
      : (h.aciklama || (b.anlam[dil] || b.anlam.en || b.anlam.tr)),
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
    return { eslesenId: es, anlamFarki: false, yakinId: null, yakinGuven: 0, guven: en ? Math.min(1, en._skor / 40) : 0 };
  }
  // İsnad zinciri ("Bize A tahdis etti… O B'den…") 300 karakterin tamamını yiyip
  // asıl sözü listeden dışarıda bırakıyordu; model karşılaştıramadığı için hem
  // eşleşmeyi kaçırıyor hem anlam farkını göremiyordu. Matn'ı gönder.
  // Mevzuat kayıtları AÇIKÇA işaretlenir. İşaretsizken model bunları "Peygamber
  // sözü" saymayıp eşleştirmeyi reddedebiliyordu ("Temizlik imandandır" → aday
  // listede olduğu hâlde eşleşme yok). Oysa ürünün asıl işi tam da bu: kullanıcı
  // halk arasında dolaşan bir sözü yapıştırıyor ve karşılığını arıyor.
  const liste = adaylar.map((a) => `[${a.id}]${a.mevzuat ? ' (HALK ARASINDA HADİS DİYE DOLAŞAN SÖZ)' : ''} ${(hadisMatn(metinAl(a, dil)) || '').slice(0, 420)}`).join('\n\n');
  const r = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: 'Sen bir hadis METİN EŞLEŞTİRME aracısın. Görevin SADECE metin ilişkilendirmek — sahihlik/uydurma/hüküm KARARI VERME, bu senin işin değil.\n' +
      '- eslesenId: Yapıştırılan metinle AYNI sözü ifade eden adayın id\'si. Net karşılık yoksa null.\n' +
      '  Lafız/çeviri farkı normaldir. ANLAM farkı DEĞİLDİR.\n' +
      '  "(HALK ARASINDA HADİS DİYE DOLAŞAN SÖZ)" işaretli adaylar da tam olarak bu amaçla listededir:\n' +
      '  kullanıcı böyle bir sözü yapıştırdıysa ve aday aynı sözün bir varyantıysa ONU eşleştir\n' +
      '  ("Temizlik imandandır" ↔ "Temizlik imandan gelir" aynı sözdür). Sözün sahih olup olmadığına\n' +
      '  yine KARAR VERME; derece kayıttan gelir.\n' +
      '- anlamFarki: Kullanıcının metni, eşleşen adayın MANASINI değiştiriyorsa true. Bunlar anlam farkıdır:\n' +
      '  • olumsuzlama eklenmiş/kaldırılmış ("niyetlere göredir" ↔ "niyetlere göre DEĞİLDİR")\n' +
      '  • sayı/miktar değişmiş ("beş şey" ↔ "üç şey")\n' +
      '  • hükmü tersine çeviren kelime ("elinden dilinden EMİN olduğu" ↔ "ZARAR GÖRDÜĞÜ")\n' +
      '  • kaynakta olmayan bir cümle/şart EKLENMİŞ ("…hayır söylesin" ↔ "…dilediğini söylesin", "+kadınlar müstesnadır")\n' +
      '  Şüphedeysen true ver. Yanlış onay, onaysızlıktan çok daha zararlıdır.\n' +
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
          yakinId: { type: ['string', 'null'], description: 'Aynı değil ama GERÇEKTEN aynı konuda en yakın adayın id\'si, yoksa null' },
          yakinGuven: { type: 'number', description: '0-1, yakinId ne kadar aynı konuda' },
          guven: { type: 'number', description: '0-1 arası eşleşme güveni' },
        },
        required: ['eslesenId', 'anlamFarki', 'yakinId', 'yakinGuven', 'guven'],
      },
    }],
    tool_choice: { type: 'tool', name: 'eslesme' },
  });
  const tu = r.content.find(c => c.type === 'tool_use');
  return tu ? tu.input : { eslesenId: null, anlamFarki: false, yakinId: null, yakinGuven: 0, guven: 0 };
}

// --- Arapça lexical arama (korpustaki asıl Arapça metin üzerinde) ---
// Harekeleri/tatweel'i atar, elif-hemze ve tâ marbûta varyantlarını sadeleştirir,
// sonra nadir kelimelerin örtüşmesine göre puanlar. Üretmez; yalnızca aday getirir.
// (arNorm metin.mjs'ten gelir; inşada aynı fonksiyonla yazılmış harnorm/ar_df tabloları kullanılır.)
const AR_STOP = new Set(['من','في','على','عن','الى','ان','ما','لا','هو','هي','قال','عليه','وسلم','صلى','الله','رسول','عن','بن','حدثنا','اخبرنا','كان','الي','هذا','التي','الذي']);
function arapcaAra(sorgu, k = 10) {
  const N = depo.nCorpus;
  const qw = [...new Set(arNorm(sorgu).split(' '))].filter(w => w.length > 2 && !AR_STOP.has(w));
  if (!qw.length) return [];
  const skor = new Map();                       // i → idf toplamı
  for (const w of qw) {
    const idf = Math.log(N / (1 + depo.arDf(w)));
    for (const i of depo.arTamKelime(w)) skor.set(i, (skor.get(i) || 0) + idf);
  }
  const puan = [...skor].map(([i, s]) => [s / Math.sqrt(depo.arKelime[i] || 1), i]);  // uzunluk normalizasyonu
  puan.sort((a, b) => b[0] - a[0]);
  return puan.slice(0, k).map(([, i]) => depo.hadisAl(i));
}

// --- Mevzuat (halk arasında hadis sanılan sözler) adayları -----------------
// ÜRÜNÜN ANA VAADİ BURASI: "bu söz gerçekten hadis mi?". Adaylar yalnız BM25'ten
// geliyordu ve mevzuat kayıtları 30.483 hadisin arasında ilk 8'e giremiyordu:
// "temizlik imandan gelir" ve "ashabım yıldızlar gibidir" korpusta KAYITLI OLDUĞU
// HÂLDE bulunamıyordu (ölçüldü). Liste 44 satır — hepsini doğrudan puanlayıp
// en iyilerini adayların BAŞINA koymak hem ucuz hem kesin.
// Not: karar yine LLM'in; burada yalnız aday havuzuna giriyoruz.
const MEVZUAT_KAYIT = (() => {
  const out = [];
  for (let i = depo.nCorpus + 1; i <= depo.nHadisAll; i++) {
    const h = depo.hadisAl(i);
    if (!h) continue;
    const tok = new Set(trNorm(h.tr || '').split(' ').filter(w => w.length > 2));
    if (tok.size) out.push({ h, tok });
  }
  return out;
})();
// Türkçe eklerini kaçırmamak için önek eşleşmesi (kodun geri kalanıyla aynı
// mantık): "imandandır" ↔ "imandan", "öğrenin" ↔ "öğreniniz".
const mvEsles = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
// Dice katsayısı: mevzuat metinleri 3-12 kelime; kesişim oranı uzunluk farkından
// bağımsız çalışır. EŞİK 0,45 ÖLÇÜMLE seçildi: 38 gerçekçi kullanıcı lafzında
// recall 38/38, 8 SAHİH hadis metninde yanlış pozitif 0. (0,30'da iki sahih metin
// yanlışlıkla mevzuat adayı çekiyordu: "Temizlik imanın yarısıdır" → "Temizlik
// imandan gelir".) Eşiği düşürmeden önce bu iki sayıyı yeniden ölç.
function mevzuatAdaylar(metin, esik = 0.45, k = 2) {
  const qt = [...new Set(trNorm(metin).split(' ').filter(w => w.length > 2))];
  if (!qt.length) return [];
  const puan = [];
  for (const { h, tok } of MEVZUAT_KAYIT) {
    let kesisim = 0;
    for (const w of tok) { for (const q of qt) if (mvEsles(w, q)) { kesisim++; break; } }
    const dice = (2 * kesisim) / (tok.size + qt.length);
    if (dice >= esik) puan.push([dice, h]);
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
    for (let i = 0; i < depo.nCorpus; i++) p.push([i, cosI8(vek, i * DIM, qv)]);
    p.sort((a, b) => b[1] - a[1]);
    const sem = p.slice(0, 20).map(([i]) => depo.hadisAl(i + 1));
    // Arapça sorguda semantik pivot zayıf (sorgu dili ≠ vektör dili). Asıl Arapça metin
    // korpusta mevcut → kelime örtüşmesiyle doğrudan ara ve adayların başına ekle.
    if (dil === 'ar') adaylar = [...arapcaAra(metin, 10), ...sem].filter((h, i, a) => a.findIndex(x => x.id === h.id) === i).slice(0, 24);
    else adaylar = sem;
  } else {
    adaylar = depo.hadisAra(dil, metin, 8);
  }
  // Mevzuat kayıtlarını havuzun BAŞINA ekle (tekrarları at). BM25 sıralamasında
  // 30k hadisin arasında kaybolduklarından ürünün asıl sorusu ("bu söz hadis mi?")
  // cevapsız kalıyordu.
  const mv = mevzuatAdaylar(metin);
  if (mv.length) adaylar = [...mv, ...adaylar].filter((h, i, a) => a.findIndex(x => x.id === h.id) === i);
  if (!adaylar.length) return { bulundu: false, yakin: null, benzerler: [] };
  const { eslesenId, anlamFarki, yakinId, yakinGuven, guven } = await eslestir(metin, adaylar, dil);
  const es = eslesenId && guven >= 0.45 ? adaylar.find(a => a.id === eslesenId) : null;
  if (es) {
    // Kaynak sahih olsa bile kullanıcının metni manayı değiştiriyorsa "sahih" demek
    // yanlış bilgidir; kaydı gösterir ama farkı açıkça bildiririz.
    return {
      bulundu: true, guven, anlamFarki: !!anlamFarki,
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
// --- Sorgu dinî bir konu mu? ---
// Alakasızlık kapısı OR çalışıyor ve puan eşiği de tek başına yetmiyor: "computer
// game" sorgusunda "game" hadiste GERÇEKTEN geçiyor (av hayvanı), o yüzden hem
// kapıyı hem tabanı aşıyor. Ayırt edici soru puan değil, sorgunun kendisi:
// bu, kaynaklarda ele alınan bir konu mu?
//
// Bu sınıflandırıcı DİNÎ İÇERİK ÜRETMEZ — yalnızca "arama yapılsın mı" kararını
// verir. Gösterilen hadis, ayet, derece ve kaynak her zaman veriden gelir.
//
// Üç emniyet: (1) yalnız puan bandın ALTINDAysa sorulur, net alakalı sorgu
// gecikme görmez; (2) hata/anahtar yoksa CEVAP EVET sayılır, yani ürün asla
// sınıflandırıcıya bağlı kalmaz; (3) istem "emin değilsen KONU de" diyor —
// yanlış eleme, yanlış gösterimden daha pahalı.
const ACIK_ESIK = 0.45;                  // bu puanın üstü zaten net alakalı
const konuMuOnbellek = new Map();        // `dil|sorgu` → bool
const KONU_ONBELLEK_SINIR = 3000;
async function konuMu(sorgu, dil) {
  if (!anthropic) return true;
  const k = `${dil}|${String(sorgu || '').toLowerCase().trim().slice(0, 80)}`;
  if (konuMuOnbellek.has(k)) return konuMuOnbellek.get(k);
  let sonuc = true;
  try {
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 5,
      system: 'Bir İslamî kaynak uygulamasında kullanıcı konu araması yapıyor. Tek görevin şunu ayırmak: bu sorgu Kur\'an ve hadislerde ele alınan bir konu mu (inanç, ibadet, ahlak, aile, akrabalık, komşuluk, duygular, ticaret ve geçim, hukuk, sağlık, hayat ve ölüm, insan ilişkileri…), yoksa kaynaklarda karşılığı olmayan modern bir nesne, marka, teknoloji ürünü ya da spor müsabakası mı (yazılım, bilgisayar oyunu, futbol maçı, araba tamiri…)? Gündelik hayata dair konular DİNÎ KONUDUR. Bir konunun modern bir kelimeyle ifade edilmesi onu dışarıda bırakmaz: "spor" → yarışma, güç, bedenin hakkı; "misafir" → misafirperverlik; "kedi" → hayvana merhamet; "iş görüşmesi" → dürüstlük ve kazanç. DEGIL yalnızca somut bir ürün, marka, cihaz, yazılım ya da belirli bir müsabaka/fiyat sorgusu içindir. EMİN DEĞİLSEN "KONU" de. Sorgu hangi dilde olursa olsun tek kelimeyle cevap ver: KONU veya DEGIL.',
      messages: [{ role: 'user', content: String(sorgu || '').slice(0, 120) }],
    });
    const t = (r.content.find(c => c.type === 'text')?.text || '').trim().toUpperCase();
    if (t.startsWith('DEGIL') || t.startsWith('DE\u011eIL')) sonuc = false;
  } catch { sonuc = true; }              // sınıflandırıcı düşerse ürün eski gibi çalışır
  if (konuMuOnbellek.size >= KONU_ONBELLEK_SINIR) konuMuOnbellek.clear();
  konuMuOnbellek.set(k, sonuc);
  return sonuc;
}

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

// HADİSE ÖZGÜ kavram sözlüğü. Türkçe hadis çevirileri Arapça terimi değil sade
// karşılığını kullanıyor: "tevazu" kelimesi 30.483 kaydın yalnız 14'ünde geçerken
// "kibir" 42, "büyüklen" 24 kayıtta geçiyor. Terim genişletilmezse tek-terim
// kapısı (o kelime metinde geçmeli) sorguyu bu 14 kayda hapsediyor ve konu
// tamamen kaçıyordu (ölçüm: tevazu ilk5 = 0/5).
// Buradaki karşılıklar SADECE arama metnidir — gösterilen hadis, derece ve
// kaynak her zaman veriden gelir, üretilmez.
// Yalnızca terimin KENDİSİ korpusta nadir olan kavramlar buraya girer (ölçülen
// kayıt sayısı yanlarında). Zaten iyi çalışan sorgulara (sabır 5/5, öfke 5/5)
// DOKUNULMADI: ölçülmeden yapılan genişletme sessiz regresyon üretir.
const KAVRAM_HADIS = {
  tevazu: 'alçakgönüllülük, kibirlenmemek, büyüklenmemek, mütevazı olmak',   // "tevazu" 14 kayıt
  komsuluk: 'komşuya iyilik, komşuya ikram, komşuya eziyet etmemek, komşuluk hakkı',
  anne_baba: 'anne babaya iyilik, ana babaya itaat, anne baba rızası',
  ticaret: 'dürüst tüccar, alışverişte doğruluk, satarken aldatmamak',
  borc: 'borcu ödemek, borçluya mühlet, borçtan sakınmak',
  selam_vermek: 'selamı yaymak, selamlaşmak, selam vermek',
  giybet: 'gıybet, çekiştirmek, arkasından konuşmak',                        // "gıybet" 9 kayıt
  dedikodu: 'gıybet, çekiştirmek, arkasından konuşmak, koğuculuk',           // "dedikodu" 13 kayıt
  hased: 'haset, kıskançlık, çekememek',                                     // "haset" 9 kayıt
  haset: 'haset, kıskançlık, çekememek',
};
// Konu sonucu için asgari alaka. Alakasızlık kapısı OR çalışıyor: çok kelimeli
// bir sorguda TEK bir kelimenin korpusta geçmesi tüm ifadeyi içeri alıyor
// ("futbol maçı" → "maçı" râvi adı Mâcişûn'a takılıyor) ve arama, konuyla ilgisi
// olmayan bir sorguya sıralamanın en iyisini döndürüyor.
// Taban 0,20: ölçüldü — 60 gerçek konu sorgusunun en düşük tepe puanı 0,26
// (ar الوالدان), 17 çöp sorgunun 8'i tamamen eleniyor, kalanların listesi kısalıyor.
// DAHA YUKARI ÇEKİLMEZ: gerçek Arapça/Urduca konular çöple aynı bantta duruyor,
// eşiği 0,26'nın üstüne almak onları sessizce boşa düşürür.
const ALAKA_TABANI = 0.20;
const ALAKASIZ_ACIK = {
  tr: /(futbol maçı|video oyunu|bilgisayar oyunu|araba tamiri|borsa fiyatı)/i,
  en: /(football match|soccer match|video game|computer game|car repair|stock price)/i,
  fr: /(match de football|jeu vidéo|jeu video|réparation de voiture|cours de bourse)/i,
  id: /(pertandingan sepak bola|gim video|permainan video|perbaikan mobil|harga saham)/i,
  ar: /(مباراة كرة القدم|لعبة فيديو|إصلاح السيارة|سعر السهم)/,
  ur: /(فٹ بال میچ|ویڈیو گیم|گاڑی کی مرمت|شیئر کی قیمت)/,
};
function konuKaydiUygun(h, sorgu, dil) {
  // Türkçedeki "sabır" aynı zamanda aloe kökenli eski bir göz ilacı adıdır.
  // Konu sabır erdemiyken ilaç rivayeti lexical eşleşmeyle ilk üçe çıkamaz.
  if (dil === 'tr' && kavramAnahtar(sorgu) === 'sabir'
    && /(sabır çek|gözlerinden? rahatsız|göz tedavisi)/i.test(h.tr || '')) return false;
  return true;
}

async function konu(sorgu, dil = 'tr') {
  if (ALAKASIZ_ACIK[dil]?.test(String(sorgu || '')))
    return { konu: sorgu, sonuclar: [], alakasiz: true };
  // Kur'an'daki gibi: metinlerde karşılığı olmayan terimi aç ("alkol" hadis
  // metinlerinde hiç geçmez, "içki/şarap" geçer).
  // KAVRAM_HADIS önceliklidir: hadis çevirilerindeki kelime dağarcığı meâlden
  // farklı; aynı sözlüğü iki tarafa da dayatmak birini bozuyordu.
  let aramaK = sorgu;
  if (dil === 'tr') {
    const a = kavramAnahtar(sorgu);
    const k = KAVRAM_HADIS[a] || KAVRAM[a];
    if (k) aramaK = `${sorgu} — ${k}`;
  }
  // Alaka kapısı: konu hadis metinlerinde hiç geçmiyorsa dürüstçe boş dön.
  // (Saf semantik "bilgisayar"a da 10 hadis buluyordu.)
  // Arapça'da harekeleri yok sayan normalizasyon gerekir: harekesiz sorgu (الصبر)
  // harekeli metinde (الصَّبْرُ) hiçbir zaman eşleşmiyordu → ar konu araması ölüydü.
  const norm = dil === 'ar' ? arNorm : trNorm;
  const qwK = [...new Set(norm(aramaK).split(' '))].filter(w => w.length > 2);
  // Kapı, PUANLAYICIYLA aynı varyantları görmeli. Arapça'da harf-i tarifli kelime
  // korpusta geçmez, kökü geçer (الزواج yok — زواج var). Kapı ham kelimeye baktığı
  // için NORMAL yazılmış her Arapça isim "alakasız" dönüyordu; oysa kapıyı geçse
  // lexHadis arVaryant ile onu zaten buluyordu. Kendi önerdiğimiz iki Arapça çip
  // (الزواج, الوالدان) bu yüzden boş dönüyordu.
  const qwKapi = dil === 'ar' ? [...new Set(qwK.flatMap(arVaryant))] : qwK;
  if (qwKapi.length) {
    // Kapı SQL'de koşar (LIKE '%kelime%' + LIMIT 1): substring semantiği eski
    // norms[i].includes(w) davranışıyla birebir, ama C tarafında erken çıkışlı.
    if (!depo.hadisKapiVar(dil, qwKapi)) return { konu: sorgu, sonuclar: [], alakasiz: true };
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
    for (let i = 0; i < depo.nCorpus; i++) {
      const dk = depo.dereceArr[i];
      if (dk !== 1 && dk !== 2) continue;                  // sahih(1) / hasen(2) filtresi
      const lx = lexMax ? lexArrH[i] / lexMax : 0;
      if (tekTerimK && lx === 0) continue;                 // tek terim → o kelime geçmeli
      const sem = cosI8(vek, i * DIM, qv);
      puan.push([i, (0.35 + 0.65 * lx) * Math.max(0, sem)]);
    }
    puan.sort((a, b) => b[1] - a[1]);
    // korpusta 577 mükerrer kayıt var; aynı metin listede iki kez çıkmasın.
    // Kayıtlar teker teker depodan çekilir (yalnız aday olanlar — tipik 10-40 kayıt).
    const gor = new Set(), sec = [], kayit = new Map();
    for (const [i, sk] of puan) {
      if (sec.length >= 10 || sk < ALAKA_TABANI) break;
      const h = kayit.get(i) || depo.hadisAl(i + 1); kayit.set(i, h);
      if (!konuKaydiUygun(h, sorgu, dil)) continue;
      const imza = trNorm(hadisMetni(metinAl(h, dil))).slice(0, 90);
      if (gor.has(imza)) continue;
      gor.add(imza); sec.push(i);
    }
    // Puan bandın altındaysa: sorgu gerçekten dinî bir konu mu?
    if (sec.length && (puan[0]?.[1] ?? 0) < ACIK_ESIK && !(await konuMu(sorgu, dil)))
      return { konu: sorgu, sonuclar: [], alakasiz: true };
    return { konu: sorgu, sonuclar: sec.map(i => derecele(kayit.get(i), dil)) };
  }
  // Fallback: lexical + sorgu genişletme
  const q = await genislet(sorgu, dil);
  const sonuc = depo.hadisAra(dil, q, 10, true);
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
  const n = depo.nAyet, h = new Float32Array(n);
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
// (trNorm metin.mjs'ten gelir — inşadaki normalize kopyalarla aynı fonksiyon.)

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
  const { metin: metinArr, norm: normArr } = kuranDil(dil);
  const puan = new Array(depo.nAyet);
  for (let i = 0; i < depo.nAyet; i++) {
    const metin = metinArr[i] || '';
    // merkezîlik cezası: 'her şeye benzeyen' ayetleri düşür. (Bölme denendi ama
    // nadir/tuhaf ayetleri aşırı yükseltiyordu; çıkarma daha dengeli.)
    const sem = cos(vek, i * DIM, qv) - 0.45 * hubSkor[i];        // merkezîlik düzeltmeli semantik
    const lx = lexMax ? lexArr[i] / lexMax : 0;                      // 0..1 normalize lexical
    // ÇARPIM + taban (0.35): gerekçeler için git geçmişine bak — davranış birebir korundu.
    if (tekTerim && !kavramVar && lx === 0) { puan[i] = [i, -1]; continue; }
    let s = (0.35 + 0.65 * lx) * Math.max(0, sem);
    if (qw.length) {                                        // lexical katkı
      const mn = normArr[i];        // = nfQ(metinAl(a, dil)) — inşada aynı fonksiyonla yazıldı
      let hit = 0; for (const w of qw) if (mn.includes(w)) hit++;
      if (hit) s += 0.10 * (hit / qw.length);   // tam kelime geçişi ek destek
    }
    // bağlamsız kalan çok kısa meâller konu sonucu olarak anlamsız (ör. 'Cennetime gir')
    if (metin.length < 45) s -= 0.05 * (1 - metin.length / 45);   // bağlamsız kısa meâl
    puan[i] = [i, s];
  }
  puan.sort((a, b) => b[1] - a[1]);
  // Kur'an yolunda puan eşiği kullanılamıyor (gerçek konular çöple aynı bantta),
  // ayırt etmeyi tamamen sınıflandırıcı yapıyor.
  if ((puan[0]?.[1] ?? 0) > 0 && puan[0][1] < ACIK_ESIK && !(await konuMu(sorgu, dil)))
    return { konu: sorgu, sonuclar: [], alakasiz: true };
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
        const imza = normArr[i].slice(0, 55);
        if (gorulenMetin.has(imza)) continue;
        gorulenMetin.add(imza); alinan.add(i); secili.push([i, sk]);
      }
      return secili;
    })().map(([i, s]) => {
      const a = depo.ayetAl(i + 1);
      // "Faiz yiyenler", "Şükrederseniz…" gibi tek başına anlam vermeyen kısa
      // meâlleri komşu ayetle tamamla (aynı sûre içinde). Metin yine VERİDEN gelir,
      // sadece bitişik ayet eklenir — üretim yok.
      let metin = metinAl(a, dil), arapca = a.ar || '', ayetEt = String(a.ayet), okunusEt = a.okunus || '';
      if (metin.length < 90) {
        const nx = depo.ayetAl(i + 2), pv = i > 0 ? depo.ayetAl(i) : null;
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
// Günün hadisi havuzu inşada süzülür (db-yap.mjs, aynı filtre) → depo.gununHavuz.
function gunSeed() { const d = new Date(); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5); }
function gunun(dil = 'tr') {
  const gi = gunSeed();
  const [s, a] = GUNUN_AYETLER[gi % GUNUN_AYETLER.length];
  const ay = depo.ayetBul(s, a);
  // (gi*7) havuzun sonunu hiç görmüyordu (366*7 < havuz) → bir yıl boyunca hep aynı
  // bölümden, ardışık kayıtlar geliyordu. Büyük asal ile havuzun tamamına dağıt.
  const hv = depo.gununHavuz;
  const hd = hv.length ? depo.hadisAl(hv[(gi * 7919) % hv.length]) : null;
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
  if (rss > 440) console.warn(`[BELLEK] RSS ${rss} MB — 512 MB sınırına yaklaşılıyor`);
}, 300_000).unref();
// Sayaçlar bellekte tutulduğu için her deploy sıfırlıyordu. Yarım saatte bir
// özeti log'a bas: Render logları kalıcı, böylece deploy sonrası da geçmiş kalır.
setInterval(() => {
  const toplam = Object.values(olcum.istek).reduce((a, b) => a + b, 0);
  if (!toplam) return;
  console.log('[OLCUM]', JSON.stringify({
    istek: olcum.istek, dil: olcum.dil, hata: olcum.hata,
    bulunamadi: olcum.bulunamadi, anlamFarki: olcum.anlamFarki,
    kotaCihaz: toplamKota.cihazSayisi(), kota: toplamKota.durum(),
    bosSorgu: olcum.bosSorgu.slice(-25),
  }));
}, 1800_000).unref();
const bosKaydet = (yol, dil, sorgu) => {
  const s = String(sorgu || '').trim();
  // Kullanıcının dinî arama metni loga açık biçimde düşmez. Aynı boş sorgunun
  // tekrarını görebilmek için geri döndürülemez kısa özet + uzunluk yeterli.
  const ozet = createHash('sha256').update(`${dil}|${s}`).digest('hex').slice(0, 16);
  olcum.bosSorgu.push({ yol, dil, ozet, uzunluk: s.length, t: new Date().toISOString() });
  if (olcum.bosSorgu.length > 300) olcum.bosSorgu.shift();
};

// --- Hız sınırı: asıl fren CİHAZ, IP yalnızca kaba emniyet supabı ---
// IP başına 120/saat vardı ve bu MEŞRU kullanıcıyı kilitliyordu: TR ve Endonezya'da
// mobil operatörler CGNAT kullanıyor, yüzlerce abone tek genel IP'nin arkasından
// çıkıyor. Aynı kovaya düşen kullanıcılar birbirini 429'a itiyordu — üstelik
// Render'ın kenar proxy'si arkasında kova zaten kaba.
//
// Yeni eşikler ve gerekçesi:
// • IP: 3000/saat. Tek bir cihaz zaten toplam 5 ücretsiz AI sorgusuyla (premiumsa
//   da ekran
//   başına birkaç istekle) sınırlı; asıl akış /api/durum + /api/gunun + /api/namaz
//   gibi ucuz uçlar. Ağır bir CGNAT havuzunda 300-500 aktif kullanıcı × saatte
//   ~6 istek ≈ 3000. Eşik bunu geçirir, gerçek bir kötüye kullanımı (saniyede
//   birden fazla istek süren tek IP) hâlâ keser.
// • Cihaz: 300/saat. Tek kullanıcının insani üst sınırının çok üstünde; tek bir
//   cihaz kimliğiyle döngüye giren istemci burada durur. Maliyeti asıl kesen
//   FREE_LIMIT (toplam 5 AI sorgusu) zaten yerinde.
const LIMIT = Number(process.env.RATE_LIMIT || 3000);          // IP / saat
const CIHAZ_LIMIT = Number(process.env.CIHAZ_RATE_LIMIT || 300); // cihaz / saat
const cihazSayac = new Map();
const OLAY_IP_LIMIT = Number(process.env.OLAY_IP_RATE_LIMIT || 6000);
const OLAY_CIHAZ_LIMIT = Number(process.env.OLAY_CIHAZ_RATE_LIMIT || 600);
const olayIpSayac = new Map(), olayCihazSayac = new Map();
// Map'ler istemciden gelen anahtarlarla (IP, cihaz) büyüyor ve hiç temizlenmiyordu.
// Saatte bir süresi geçmiş kayıtları at; premium kayıtları korunur.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of istekSayac) if (now > v.reset) istekSayac.delete(k);
  for (const [k, v] of cihazSayac) if (now > v.reset) cihazSayac.delete(k);
  for (const [k, v] of olayIpSayac) if (now > v.reset) olayIpSayac.delete(k);
  for (const [k, v] of olayCihazSayac) if (now > v.reset) olayCihazSayac.delete(k);
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
const olayLimitAsildi = (ip, c) => sayacAstiMi(olayIpSayac, ip, OLAY_IP_LIMIT)
  || sayacAstiMi(olayCihazSayac, c || 'anon', OLAY_CIHAZ_LIMIT);

// --- Freemium: cihaz başına TOPLAM ücretsiz AI sorgusu; premium = sınırsız ---
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 5);
const CHECKOUT_URL = process.env.CHECKOUT_URL || ''; // LemonSqueezy/Stripe ödeme linki (kurulunca)
const AI_YOLLAR = ['/api/dogrula', '/api/konu', '/api/kuran-konu']; // limite tabi (namaz serbest)

// --- Premium durumu: TEK DOĞRULUK KAYNAĞI RevenueCat ---
// ESKİDEN premium kaydı sunucunun belleğinde bir Map'ti. Render her deploy/restart/
// uyanmada süreci sıfırlıyor → o an uygulamada olan ABONE bir sonraki sorgusunda
// 402 yiyip paywall görüyordu. Parası alınmış, hizmeti kesilmiş oluyordu.
// Render'da kalıcı disk olsa da aboneliğin doğruluk kaynağı olarak yerel kayıt
// tutmuyoruz: her cihazın
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
// Kota artık Supabase'de (kota.mjs) — ağ çağrısı içerir, bu yüzden async.
async function kalanHak(c, prem) {
  if (prem) return Infinity;
  return toplamKota.kalan(c);
}
async function hakKullan(c) {
  return toplamKota.kullan(c);
}

// --- Basit HTTP sunucu (CORS + app-key + rate limit + gövde sınırı) ---
function govde(req) {
  return new Promise((res, rej) => {
    let d = ''; let n = 0;
    req.on('data', c => { n += c.length; if (n > 200_000) { rej(new Error('gövde büyük')); req.destroy(); } d += c; });
    req.on('end', () => res(d));
  });
}
function istemciIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (process.env.PROXY_GUVENILIR === '1' && xff) || req.socket.remoteAddress || 'x';
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
      kotaCihaz: toplamKota.cihazSayisi(),
      // Kotanın gerçekten kalıcı olup olmadığı buradan görülür (kalici:false ise
      // her uyanışta ücretsiz hak sıfırlanıyor demektir).
      kota: toplamKota.durum(),
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
    // test=1 ile kendi test cihazlarımız da dahil edilir (varsayılan: elenir).
    const o = olayOzet(gun, { testDahil: url.searchParams.get('test') === '1' });
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
    // diskKalici: kalıcı disk gerçekten bağlı mı. Blueprint'teki disk tanımı
    // Render'da mevcut bir servise her zaman kendiliğinden uygulanmıyor; bağlı
    // değilse analitik ve kota her deploy'da siliniyor ve bu SESSİZCE oluyor.
    // Anahtar istemeyen bir uçta durmalı ki her deploy sonrası tek istekle
    // bakılabilsin — panele girmek için gizli anahtar gerekiyor.
    let diskBosMB = null;
    try { const s = statfsSync(process.env.VERI_DIZIN || (existsSync('/veri') ? '/veri' : '.')); diskBosMB = Math.round(s.bavail * s.bsize / 1048576); } catch {}
    return res.end(JSON.stringify({ ok: true, surum: SURUM, sha: BUILD_SHA, hadis: depo.nCorpus, ayet: depo.nAyet,
      model: MODEL, llm: !!anthropic, diskKalici: existsSync('/veri'), diskBosMB, analitik: diskDurumu() }));
  }

  // /app-ads.txt KALDIRILDI: uygulamada hiç reklam yok (AdMob SDK'sı da yok).
  // AdMob envanteri beyan eden bir dosya yayınlamak yanlış beyandı; paywall'daki
  // "reklamsız" vaadiyle de çelişiyordu.

  // Statik sunum: uygulama HTML'i + fontlar (tek servis olsun diye).
  if (req.method === 'GET') {
    const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
    let p = url.pathname === '/' ? '/hadis.html' : url.pathname;
    if (p === '/gizlilik') p = '/gizlilik.html';
    if (p === '/kullanim') p = '/kullanim.html';
    const STATIK = {
      '/adhan.min.js': 'node_modules/adhan/lib/bundles/adhan.umd.min.js',
      '/tz.js': 'node_modules/tz-lookup/tz.js',
      '/ayat.json': 'ayat.json',
      '/sure.json': 'sure.json',
    };
    if (STATIK[p] || /^\/(hadis\.html|gizlilik\.html|kullanim\.html|fonts\.css|fonts\/[\w.-]+\.woff2)$/.test(p)) {
      try {
        const dosya = readFileSync(yol(STATIK[p] || p.replace(/^\//, '')));
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
        if (olayLimitAsildi(istemciIp(req), String(b.cihaz || 'anon').slice(0, 64))) {
          res.writeHead(429); return res.end();
        }
        olayYaz(b.cihaz, b.olaylar);
      } catch { /* bozuk yığın sessizce düşer */ }
      res.writeHead(204); return res.end();
    }

    const POST_YOLLAR = ['/api/dogrula', '/api/konu', '/api/kuran-konu', '/api/namaz', '/api/durum', '/api/gunun', '/api/iap-onay'];
    if (req.method === 'POST' && POST_YOLLAR.includes(url.pathname)) {
      if (req.headers['x-app-key'] !== APP_KEY) { res.writeHead(401); return res.end(JSON.stringify({ hata: 'yetkisiz' })); }
      // X-Forwarded-For istemciden gelir ve taklit edilebilir; SADECE güvenilir proxy
      // arkasındayken (Render) kullan. Aksi halde soket adresi esas alınır.
      const ip = istemciIp(req);
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
        return res.end(JSON.stringify({ premium: prem, kalan: prem ? -1 : await kalanHak(cihaz, prem), limit: FREE_LIMIT, checkout: CHECKOUT_URL }));
      }
      // AI-sorgu limiti (namaz hariç, sadece native)
      if (AI_YOLLAR.includes(url.pathname) && !prem && await kalanHak(cihaz, prem) <= 0) {
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
      // AI sorgusu başarılı → hak düş + kalan bilgisini ekle.
      // BOŞ SONUÇ HAK YEMEZ. Konu aramasında hiçbir şey dönmediyse kullanıcı
      // beş ücretsiz hakkından birini hiçbir şey karşılığında kaybediyordu —
      // ilk kullanıcı şikâyeti tam olarak buydu ("hakkım gitti, bir şey
      // getirmedi"). Doğrulamada "bulunamadı" bir cevaptır (aradığı bilgi:
      // bu metin kaynaklarda yok), o yüzden orada hak düşmeye devam eder.
      const bosDondu = url.pathname !== '/api/dogrula' && !(out.sonuclar || []).length;
      if (AI_YOLLAR.includes(url.pathname)) {
        if (!prem && !bosDondu) await hakKullan(cihaz);
        out.kalan = prem ? -1 : await kalanHak(cihaz, prem);
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

// Port doluysa (eski süreç hâlâ ayakta, yanlış PORT) 'error' dinleyicisi olmadan
// EADDRINUSE yakalanmamış istisna olarak süreci öldürüyordu — Render'da sebebi
// belirsiz bir çökme olarak görünüyordu. Sebebi açıkça yaz, temiz çık.
sunucu.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') console.error(`HATA: ${PORT} portu kullanımda. Eski süreci kapat ya da PORT değiştir.`);
  else console.error('Sunucu hatası:', e);
  process.exit(1);
});
sunucu.listen(PORT, () => console.log(`\n▶ http://localhost:${PORT}  (/health, /api/dogrula, /api/konu)`));
