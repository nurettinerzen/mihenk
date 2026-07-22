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
import { readFileSync } from 'node:fs';
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
const corpus = JSON.parse(readFileSync(yol('corpus.json'), 'utf8'));
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
// Hadis semantik vektörleri (varsa) — konu araması semantik olsun. Yoksa lexical'e düşer.
let hadisVek = null;
try { hadisVek = { tr: vekYukle('vektor-hadis-tr.f32'), en: vekYukle('vektor-hadis-en.f32') }; console.log('Hadis semantik vektörleri yüklendi.'); }
catch { console.log('Hadis vektörleri henüz yok — konu araması lexical modda.'); }
console.log('Embedding modeli yükleniyor (ilk sorgu gecikmesin diye)...');
await embedder();
console.log(`Hazır: ${corpus.length} hadis + ${mevzuat.length} mevzuat | Kur'an ${ayat.length} ayet (TR+EN semantik). Model: ${MODEL}. Anthropic: ${anthropic ? 'açık' : 'YOK (mock)'}`);

// Derece → dile göre etiket + anlam + renk (UI kullanır)
const DERECE_BILGI = {
  sahih:      { renk: 'yesil',   etiket: { tr: 'Sahih', en: 'Sahih (Authentic)' },
    anlam: { tr: 'Sened yönünden sağlam, güvenilir. Dinî bir delil olarak kullanılabilir.', en: 'Sound and reliable in its chain. Can be used as religious evidence.' } },
  hasen:      { renk: 'yesil',   etiket: { tr: 'Hasen', en: 'Hasan (Good)' },
    anlam: { tr: 'İyi derecede sağlam. Delil olarak kabul edilir; sahihe göre bir alt basamaktır.', en: 'Good and acceptable as evidence; one level below sahih.' } },
  zayif:      { renk: 'turuncu', etiket: { tr: 'Zayıf', en: 'Weak (Da\'if)' },
    anlam: { tr: 'Kaynakta geçiyor ama senedinde zayıflık var. Güçlü/kesin bir hadis sayılmaz; tek başına hüküm dayanağı olmaz. Faziletlerde ihtiyatla anılabilir.', en: 'Found in the source but weak in its chain. Not a strong/decisive report; cannot alone be a basis for a ruling.' } },
  mevzu:      { renk: 'kirmizi', etiket: { tr: 'Aslı sabit değil', en: 'Not authentically established' },
    anlam: { tr: 'Âlimler bu sözü Peygamber\'e ait güvenilir bir hadis olarak kabul etmiyor; sağlam bir dayanağı yok. Hadis diye aktarmamak daha doğru olur.', en: 'Scholars do not accept this as a reliable saying of the Prophet; it has no sound basis. Better not to relay it as a hadith.' } },
  bilinmiyor: { renk: 'gri',     etiket: { tr: 'Derece belirsiz', en: 'Grade unclear' },
    anlam: { tr: 'Bu nüsha için elimizde net bir derecelendirme kaydı yok; kesinliği hakkında hüküm vermek doğru olmaz.', en: 'We have no clear grading record for this narration; its reliability cannot be stated with certainty.' } },
};

function derecele(h, dil = 'tr') {
  const b = DERECE_BILGI[h.derece] || DERECE_BILGI.bilinmiyor;
  const metin = dil === 'en' ? (h.en || h.tr) : h.tr; // en yoksa tr'ye düş
  return {
    id: h.id, tr: metin, ar: h.ar, kaynak: h.kaynak, kitapTr: h.kitapTr, no: h.no,
    derece: h.derece, dereceEtiket: b.etiket[dil] || b.etiket.tr, dereceRenk: b.renk,
    // Mevzuat kaydıysa kendi (nüanslı, atıflı) açıklaması kullanılır (şimdilik TR).
    dereceAnlam: h.aciklama || (b.anlam[dil] || b.anlam.tr),
    dereceRaw: h.dereceRaw, alimler: h.alimler,
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
  const liste = adaylar.map((a) => `[${a.id}] ${((dil === 'en' ? a.en : a.tr) || a.tr || '').slice(0, 300)}`).join('\n\n');
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

async function dogrula(metin, dil = 'tr') {
  const adaylar = hadisMotor(dil).ara(metin, 8);
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
  if (!anthropic || dil === 'en') return konu; // EN'de kelime çeviride zaten geçer
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
  // Semantik (vektör varsa): kavramın adını değil anlamını yazınca da bulur.
  if (hadisVek) {
    const qv = await embedOne(sorgu);
    const vek = hadisVek[dil] || hadisVek.tr;
    const puan = [];
    for (let i = 0; i < corpus.length; i++) {
      const d = corpus[i].derece;
      if (d === 'sahih' || d === 'hasen') puan.push([i, cos(vek, i * DIM, qv)]);
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
async function kuranKonu(sorgu, dil = 'tr') {
  const qv = await embedOne(sorgu);
  const vek = kuranVek[dil] || kuranVek.tr;
  const puan = new Array(ayat.length);
  for (let i = 0; i < ayat.length; i++) puan[i] = [i, cos(vek, i * DIM, qv)];
  puan.sort((a, b) => b[1] - a[1]);
  return {
    konu: sorgu,
    sonuclar: puan.slice(0, 10).map(([i, s]) => {
      const a = ayat[i];
      const meal = dil === 'en' ? (a.en || a.tr) : a.tr;
      return { id: a.id, sure: a.sure, sureAd: dil === 'en' ? a.sureAdEn : a.sureAd, ayet: a.ayet,
        sayfa: a.sayfa, cuz: a.cuz, kaynak: dil === 'en' ? a.kaynakEn : a.kaynak,
        ar: a.ar, okunus: a.okunus, tr: meal, skor: +s.toFixed(3) };
    }),
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
    if (/^\/(hadis\.html|fonts\.css|fonts\/[\w.-]+\.woff2)$/.test(p)) {
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
    const POST_YOLLAR = ['/api/dogrula', '/api/konu', '/api/kuran-konu', '/api/namaz'];
    if (req.method === 'POST' && POST_YOLLAR.includes(url.pathname)) {
      if (req.headers['x-app-key'] !== APP_KEY) { res.writeHead(401); return res.end(JSON.stringify({ hata: 'yetkisiz' })); }
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
      if (limitAsildi(ip)) { res.writeHead(429); return res.end(JSON.stringify({ hata: 'çok fazla istek, biraz bekleyin' })); }
      const body = JSON.parse(await govde(req) || '{}');
      const dil = body.dil === 'en' ? 'en' : 'tr';
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
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500); return res.end(JSON.stringify({ hata: 'sunucu hatası' }));
  }
  res.writeHead(404); res.end(JSON.stringify({ hata: 'yok' }));
}).listen(PORT, () => console.log(`\n▶ http://localhost:${PORT}  (/health, /api/dogrula, /api/konu)`));
