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

const PORT = process.env.PORT || 8788;
const APP_KEY = process.env.APP_KEY || 'hadis-dev';
const MODEL = process.env.MODEL || 'claude-haiku-4-5';
const SURUM = 1;

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
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
// Kur'an semantik indeksi — dile göre ayrı vektör (yerel embedding).
const vekYukle = (f) => { const b = readFileSync(yol(f)); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const kuranVek = { tr: vekYukle('vektor-kuran-tr.f32'), en: vekYukle('vektor-kuran-en.f32') };
// Hadis metinlerinin normalize kopyası (önek eşleşmeli lexical için, tek sefer).
let hadisNorm = null;
function hadisNormAl(dil) {
  if (hadisNorm && hadisNorm.dil === dil) return hadisNorm.arr;
  hadisNorm = { dil, arr: corpus.map(h => ' ' + trNorm(metinAl(h, dil) || '')) };
  return hadisNorm.arr;
}
// sorgu kelimesi, metindeki bir kelimenin ÖNEKİ ise eşleşir (sabır→sabreden değil ama
// sabır→sabırla evet; kelime başına boşluk şartı kısmi/ortadan eşleşmeyi engeller)
function lexHadis(dil, qw) {
  const N = corpus.length, arr = hadisNormAl(dil);
  const vars = qw.map(kokVaryant);
  const idf = vars.map(vs => {
    let n = 0; for (let i = 0; i < N; i++) if (vs.some(v => arr[i].includes(' ' + v))) n++;
    return Math.log(1 + N / (1 + n));
  });
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sc = 0;
    for (let k = 0; k < vars.length; k++) if (vars[k].some(v => arr[i].includes(' ' + v))) sc += idf[k];
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
  const toks = ayat.map(a => new Set(trNorm(metinAl(a, dil)).split(' ').filter(w => w.length > 2)));
  const df = new Map();
  for (const t of toks) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  kuranTok.set(dil, toks); kuranDF.set(dil, df);
}
// sorgu kelimesi, ayet kelimesinin ÖNEKİ ise eşleşir (adalet→adaleti, namaz→namazı)
function lexPuan(dil, qw) {
  kuranIndeks(dil);
  const toks = kuranTok.get(dil), df = kuranDF.get(dil), N = ayat.length;
  const idf = new Map();
  for (const w of qw) {
    let n = 0; const vs = kokVaryant(w);
    for (const [k, c] of df) if (vs.some(v => k.startsWith(v))) n += c;
    idf.set(w, Math.log(1 + N / (1 + n)));
  }
  const out = new Float32Array(ayat.length);
  for (let i = 0; i < toks.length; i++) {
    let s = 0;
    for (const w of qw) { const vs = kokVaryant(w); for (const k of toks[i]) if (vs.some(v => k.startsWith(v))) { s += idf.get(w); break; } }
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

function derecele(h, dil = 'tr') {
  const b = DERECE_BILGI[h.derece] || DERECE_BILGI.bilinmiyor;
  const metin = metinAl(h, dil); // o dildeki metin yoksa en→tr
  return {
    id: h.id, tr: metin, ar: h.ar, kaynak: h.kaynak, kitapTr: h.kitapTr, no: h.no,
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
    return { eslesenId: es, yakinId: null, yakinGuven: 0, guven: en ? Math.min(1, en._skor / 40) : 0 };
  }
  const liste = adaylar.map((a) => `[${a.id}] ${(metinAl(a, dil) || '').slice(0, 300)}`).join('\n\n');
  const r = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: 'Sen bir hadis METİN EŞLEŞTİRME aracısın. Görevin SADECE metin ilişkilendirmek — sahihlik/uydurma/hüküm KARARI VERME, bu senin işin değil.\n' +
      '- eslesenId: Yapıştırılan metinle AYNI hadis (aynı Peygamber sözü, lafız farklı olabilir) olan adayın id\'si. Net karşılık yoksa null.\n' +
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
          yakinId: { type: ['string', 'null'], description: 'Aynı değil ama GERÇEKTEN aynı konuda en yakın adayın id\'si, yoksa null' },
          yakinGuven: { type: 'number', description: '0-1, yakinId ne kadar aynı konuda' },
          guven: { type: 'number', description: '0-1 arası eşleşme güveni' },
        },
        required: ['eslesenId', 'yakinId', 'yakinGuven', 'guven'],
      },
    }],
    tool_choice: { type: 'tool', name: 'eslesme' },
  });
  const tu = r.content.find(c => c.type === 'tool_use');
  return tu ? tu.input : { eslesenId: null, yakinId: null, yakinGuven: 0, guven: 0 };
}

// --- Arapça lexical arama (korpustaki asıl Arapça metin üzerinde) ---
// Harekeleri/tatweel'i atar, elif-hemze ve tâ marbûta varyantlarını sadeleştirir,
// sonra nadir kelimelerin örtüşmesine göre puanlar. Üretmez; yalnızca aday getirir.
const arNorm = (s) => (s || '')
  .replace(/[ً-ْـٰ]/g, '')      // hareke + tatweel
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
  const { eslesenId, yakinId, yakinGuven, guven } = await eslestir(metin, adaylar, dil);
  const es = eslesenId && guven >= 0.45 ? adaylar.find(a => a.id === eslesenId) : null;
  if (es) {
    return {
      bulundu: true, guven,
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
  const qwK = [...new Set(trNorm(aramaK).split(' '))].filter(w => w.length > 2);
  if (qwK.length) {
    let sinyal = false;
    for (const h of hadisAll) {
      const m = trNorm(metinAl(h, dil) || '');
      if (qwK.some(w => m.includes(w))) { sinyal = true; break; }
    }
    if (!sinyal) return { konu: sorgu, sonuclar: [], alakasiz: true };
  }
  // Semantik + lexical harman (Kur'an tarafındaki ile aynı mantık): saf semantik
  // "içki" sorgusunda alakasız hadisleri öne çıkarıyordu.
  if (hadisVek) {
    const qv = await embedOne(aramaK);
    const vek = vekAl(hadisVek, dil);
    // lexical: önek eşleşmeli (BM25 tam kelime arıyor, Türkçe eklerde kaçırıyor)
    const qwH = [...new Set(trNorm(aramaK).split(' '))].filter(w => w.length > 2);
    const lexArrH = qwH.length ? lexHadis(dil, qwH) : null;
    let lexMax = 0; if (lexArrH) for (const v of lexArrH) if (v > lexMax) lexMax = v;
    const tekTerimK = [...new Set(trNorm(sorgu).split(' '))].filter(w => w.length > 2).length === 1;
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
    return { konu: sorgu, sonuclar: puan.slice(0, 10).map(([i]) => derecele(corpus[i], dil)) };
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
let hubSkor = null;                       // dil → Float32Array(ayat)
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
const kokVaryant = (w) => {
  const v = [w];
  if (w.length >= 5) {
    const sonUnlu = /[aeiıoöuü]/.test(w[w.length - 2]);
    const sonUnsuz = !/[aeiıoöuü]/.test(w[w.length - 1]);
    if (sonUnlu && sonUnsuz) v.push(w.slice(0, -2) + w[w.length - 1]);
  }
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
  gibet: 'arkadan çekiştirmek, birinin arkasından kötü konuşmak',
  sila: 'akrabayı ziyaret, akrabalık bağını gözetmek',
  helal: 'temiz ve helal kazanç, haramdan sakınmak',
  kul_hakki: 'başkasının hakkını yemek, haksızlık, zulüm',
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
  const qwLex = [...new Set(trNorm(aramaMetni).split(' '))].filter(w => w.length > 2);
  const lexArr = qwLex.length ? lexPuan(dil, qwLex) : null;
  let lexMax = 0; if (lexArr) for (const v of lexArr) if (v > lexMax) lexMax = v;
  // Konu Kur'an'da geçmiyorsa DÜRÜSTÇE boş dön. Saf semantik her sorguya bir şey
  // buluyordu: "sigara"→duman ayetleri, "bilgisayar"/"abla"→alakasız. Sorgunun
  // hiçbir kelimesi (kavram karşılığı dahil) meâlde geçmiyorsa konu yok demektir.
  if (qwLex.length && lexMax === 0) return { konu: sorgu, sonuclar: [], alakasiz: true };
  const tekTerim = qwLex.length === 1;   // tek terim → lexical, cümle → anlam ağırlıklı
  // DESTEK: semantik — kelime geçmese de anlamca yakın ayetleri yakalar
  const qv = await embedOne(aramaMetni);
  const vek = vekAl(kuranVek, dil);
  if (!hubSkor) hubSkor = hubHesapla(vek);
  // sorgu kelimeleri (lexical destek)
  const qw = [...new Set(trNorm(aramaMetni).split(' '))].filter(w => w.length > 2);
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
    if (tekTerim && lx === 0) { puan[i] = [i, -1]; continue; }
    let s = (0.35 + 0.65 * lx) * Math.max(0, sem);
    if (qw.length) {                                        // lexical katkı
      const mn = trNorm(metin);
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
        // bağlam birleştirmesi komşu ayetleri de kapsıyor → örtüşen sonuçları atla
        if (alinan.has(i) || alinan.has(i - 1) || alinan.has(i + 1)) continue;
        // bazı meâllerde ardışık ayetler aynı cümleyi tekrar eder (ör. Abese 34-37)
        const imza = trNorm(metinAl(ayat[i], dil)).slice(0, 55);
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
      const ad = dil === 'tr' ? a.sureAd : a.sureAdEn;
      return { id: a.id, sure: a.sure, sureAd: ad, ayet: a.ayet, ayetEt,
        sayfa: a.sayfa, cuz: a.cuz, kaynak: `${ad} ${ayetEt}`,
        ar: arapca, okunus: dil === 'tr' ? okunusEt : '', tr: metin, skor: +s.toFixed(3) };
    }),
  };
}

// Günün ayeti + hadisi — tarihe göre deterministik (herkes aynısını görür, her gün değişir).
// Ayet seçimi bilinen/manevî ayetlerden; metin yine yerleşik veriden gelir.
const GUNUN_AYETLER = [[2,286],[94,5],[13,28],[2,152],[65,3],[39,53],[2,153],[16,128],[14,7],[29,69],[3,139],[10,57],[2,45],[3,159],[93,4],[2,255],[8,46],[64,11],[3,173],[57,4]];
const gununHadisHavuz = corpus.filter(h => h.derece === 'sahih' && h.tr && h.tr.length > 40 && h.tr.length < 340);
function gunSeed() { const d = new Date(); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5); }
function gunun(dil = 'tr') {
  const gi = gunSeed();
  const [s, a] = GUNUN_AYETLER[gi % GUNUN_AYETLER.length];
  const ay = ayat.find(x => x.sure === s && x.ayet === a);
  const hd = gununHadisHavuz.length ? gununHadisHavuz[(gi * 7) % gununHadisHavuz.length] : null;
  return {
    ayet: ay ? { kaynak: dil === 'tr' ? ay.kaynak : ay.kaynakEn, ar: ay.ar, okunus: dil === 'tr' ? ay.okunus : '', tr: metinAl(ay, dil) } : null,
    hadis: hd ? { kaynak: hd.kaynak, tr: metinAl(hd, dil), ar: hd.ar, dereceEtiket: dil === 'en' ? 'Sahih (Authentic)' : 'Sahih' } : null,
  };
}

// Namaz vakitleri + kıble — konuma göre (Diyanet/Türkiye yöntemi).
// Sunucu epoch-ms döndürür; istemci kendi saat diliminde biçimler (kullanıcı konumdadır).
function namaz(lat, lng) {
  const coords = new adhan.Coordinates(lat, lng);
  const params = adhan.CalculationMethod.Turkey();
  const pt = new adhan.PrayerTimes(coords, new Date(), params);
  const ptYarin = new adhan.PrayerTimes(coords, new Date(Date.now() + 86400000), params);
  const ms = t => t.getTime();
  return {
    vakitler: { imsak: ms(pt.fajr), gunes: ms(pt.sunrise), ogle: ms(pt.dhuhr), ikindi: ms(pt.asr), aksam: ms(pt.maghrib), yatsi: ms(pt.isha) },
    yarinImsak: ms(ptYarin.fajr), // bugünün hepsi geçtiyse sonraki = yarın imsak
    tz: (() => { try { return tzlookup(lat, lng); } catch { return 'UTC'; } })(), // konumun saat dilimi
    kible: +adhan.Qibla(coords).toFixed(1),
  };
}

// Basit IP başına rate limit (saatte LIMIT istek) — LLM/embedding maliyetini korur.
const istekSayac = new Map();
const LIMIT = Number(process.env.RATE_LIMIT || 120);
function limitAsildi(ip) {
  const now = Date.now(), pencere = 3600_000;
  let r = istekSayac.get(ip);
  if (!r || now > r.reset) { r = { count: 0, reset: now + pencere }; istekSayac.set(ip, r); }
  r.count++;
  return r.count > LIMIT;
}

// --- Freemium: cihaz başına GÜNLÜK ücretsiz AI-sorgu; premium (lisanslı) = sınırsız ---
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 5);
const CHECKOUT_URL = process.env.CHECKOUT_URL || ''; // LemonSqueezy/Stripe ödeme linki (kurulunca)
const AI_YOLLAR = ['/api/dogrula', '/api/konu', '/api/kuran-konu']; // limite tabi (namaz serbest)
const kullanim = new Map();      // cihaz -> {gun, sayi}
const premiumCihaz = new Map();  // cihaz -> {anahtar}
const bugun = () => new Date().toISOString().slice(0, 10);
const premiumMi = (c) => premiumCihaz.has(c);
function kalanHak(c) {
  if (premiumMi(c)) return Infinity;
  const r = kullanim.get(c);
  if (!r || r.gun !== bugun()) return FREE_LIMIT;
  return Math.max(0, FREE_LIMIT - r.sayi);
}
function hakKullan(c) {
  let r = kullanim.get(c);
  if (!r || r.gun !== bugun()) { r = { gun: bugun(), sayi: 0 }; kullanim.set(c, r); }
  r.sayi++;
}
// Lisans doğrulama — ŞİMDİLİK stub (test anahtarı). LemonSqueezy bağlanınca gerçek API ile değişecek.
async function lisansGecerli(anahtar) {
  if (!anahtar) return false;
  if (anahtar.trim() === (process.env.TEST_LISANS || 'MIHENK-TEST-2026')) return true;
  // TODO(LemonSqueezy): POST https://api.lemonsqueezy.com/v1/licenses/validate {license_key} → .valid
  return false;
}

// --- Basit HTTP sunucu (CORS + app-key + rate limit + gövde sınırı) ---
function govde(req) {
  return new Promise((res, rej) => {
    let d = ''; let n = 0;
    req.on('data', c => { n += c.length; if (n > 200_000) { rej(new Error('gövde büyük')); req.destroy(); } d += c; });
    req.on('end', () => res(d));
  });
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-app-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, surum: SURUM, hadis: corpus.length, ayet: ayat.length, model: MODEL, llm: !!anthropic }));
  }

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
    const POST_YOLLAR = ['/api/dogrula', '/api/konu', '/api/kuran-konu', '/api/namaz', '/api/lisans', '/api/durum', '/api/gunun', '/api/iap-onay'];
    if (req.method === 'POST' && POST_YOLLAR.includes(url.pathname)) {
      if (req.headers['x-app-key'] !== APP_KEY) { res.writeHead(401); return res.end(JSON.stringify({ hata: 'yetkisiz' })); }
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
      if (limitAsildi(ip)) { res.writeHead(429); return res.end(JSON.stringify({ hata: 'çok fazla istek, biraz bekleyin' })); }
      const body = JSON.parse(await govde(req) || '{}');
      const dil = dilAl(body.dil);
      const cihaz = (body.cihaz || '').toString().slice(0, 64) || 'anon';
      const yerli = !!body.yerli; // limit sadece native (iOS) isteklerde; web ücretsiz demo
      // Lisans body'de geldiyse premium'u aktive et
      if (body.lisans && await lisansGecerli(body.lisans)) premiumCihaz.set(cihaz, { anahtar: body.lisans });

      // Lisans etkinleştirme
      if (url.pathname === '/api/lisans') {
        const ok = await lisansGecerli(body.anahtar);
        if (ok) premiumCihaz.set(cihaz, { anahtar: body.anahtar });
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ premium: ok }));
      }
      // IAP onayı — RevenueCat satın almayı doğruladıktan sonra app bildirir; cihazı premium işaretle.
      // ⚠️ MVP: güven-tabanlı (spoof edilebilir). İleride RevenueCat webhook ile sunucu-taraflı doğrulama.
      if (url.pathname === '/api/iap-onay') {
        premiumCihaz.set(cihaz, { kaynak: 'iap' });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ premium: true }));
      }
      // Günün ayeti + hadisi (limitsiz)
      if (url.pathname === '/api/gunun') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(gunun(dil)));
      }
      // Durum: premium mi + kalan hak
      if (url.pathname === '/api/durum') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ premium: premiumMi(cihaz), kalan: (premiumMi(cihaz) || !yerli) ? -1 : kalanHak(cihaz), limit: FREE_LIMIT, checkout: CHECKOUT_URL }));
      }
      // AI-sorgu limiti (namaz hariç, sadece native)
      if (AI_YOLLAR.includes(url.pathname) && yerli && !premiumMi(cihaz) && kalanHak(cihaz) <= 0) {
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ hata: 'limit', premium: false, limit: FREE_LIMIT, checkout: CHECKOUT_URL }));
      }

      let out;
      if (url.pathname === '/api/namaz') {
        const lat = Number(body.lat), lng = Number(body.lng);
        if (!isFinite(lat) || !isFinite(lng)) { res.writeHead(400); return res.end(JSON.stringify({ hata: 'konum geçersiz' })); }
        out = namaz(lat, lng);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out));
      }
      if (url.pathname === '/api/dogrula') {
        const metin = (body.metin || '').trim();
        if (metin.length < 8) { res.writeHead(400); return res.end(JSON.stringify({ hata: 'metin çok kısa' })); }
        out = await dogrula(metin, dil);
      } else if (url.pathname === '/api/kuran-konu') {
        const k = (body.konu || '').trim();
        if (k.length < 2) { res.writeHead(400); return res.end(JSON.stringify({ hata: 'konu boş' })); }
        out = await kuranKonu(k, dil);
      } else {
        const k = (body.konu || '').trim();
        if (k.length < 2) { res.writeHead(400); return res.end(JSON.stringify({ hata: 'konu boş' })); }
        out = await konu(k, dil);
      }
      // AI sorgusu başarılı → hak düş + kalan bilgisini ekle
      if (AI_YOLLAR.includes(url.pathname)) {
        if (yerli && !premiumMi(cihaz)) hakKullan(cihaz);
        out.kalan = (premiumMi(cihaz) || !yerli) ? -1 : kalanHak(cihaz);
        out.premium = premiumMi(cihaz);
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
}).listen(PORT, () => console.log(`\n▶ http://localhost:${PORT}  (/health, /api/dogrula, /api/konu)`));
