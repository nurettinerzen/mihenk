// metin.mjs — Hadis/ayet metin işleme: şerh ayıklama, isnad soyma, normalizasyon.
// hadis-api.mjs'ten çıkarıldı; hem çalışma anında (API) hem inşa anında (db-yap.mjs,
// SQLite'a normalize kopyaları önceden yazmak için) aynı fonksiyonlar kullanılır —
// iki kopya sapması dinî içerikte yanlış eşleşme demek olurdu.
//
// NOT: Karakter ARALIKLARI bilerek \uXXXX kaçışlı yazıldı — literal yazımda araya
// Arapça rakam/noktalama blokları karışabiliyor ve fark gözle görülmüyor.

// Dil kodu → veri alanı. Endonezce alanı 'idn' (kaydın 'id' alanını ezmemesi için).
export const DILLER = ['tr', 'en', 'fr', 'id', 'ur', 'ar'];
export const ALAN = { id: 'idn' };
export const metinAl = (o, dil) => o[ALAN[dil] || dil] || o.en || o.tr;   // görünen metin, fallback zinciri
// Metnin HANGİ dilden geldiği: kaynak edisyonlarda boşluk var (ind-muslim'in %35'i,
// fr'nin %14'ü boş) ve sessizce İngilizce'ye düşmek kullanıcıya hata gibi görünüyordu.
export const metinDili = (o, dil) => {
  const k = ALAN[dil] || dil;
  if (o[k] && String(o[k]).trim()) return dil;
  if (o.en && String(o.en).trim()) return 'en';
  return 'tr';
};

export const trNorm = (s) => (s || '').toLocaleLowerCase('tr').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^\p{L}\p{N} ]/gu, ' ');

// Arapça normalizasyon: hareke/tatweel/tecvid işaretlerini at, elif-hemze ve
// tâ marbûta varyantlarını sadeleştir.
export const arNorm = (s) => (s || '')
  .replace(/[ً-ٰٟۖ-ۭـ]/g, '')
  .replace(/ٱ/g, 'ا')     // vasl elifi → elif
  .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^ء-ي\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Korpustaki bazı kayıtlar hadis metninin ardına şerh/izah/tahric bloğu ekliyor
// (Fethu'l-Bari, "Diğer tahric", AÇIKLAMA…). Bunlar hadis DEĞİL.
const SERH_KALIP = /(Diğer tahric|Fethu'?l-?Bari|Fethul Bari|İZAH|IZAH|ŞERH|Şerh:|AÇIKLAMA|Açıklama:|Tahric|Not:|Tekrarı?\s*:)/;
// Hadis metni "Bize X rivayet etti… şöyle buyurdu:" diye başlar; asıl söz (matn)
// bundan sonrasıdır. Ayrıntılı gerekçeler için git geçmişindeki hadis-api.mjs'e bak.
const MATN_KOK = '(?:tahd[îi]s|riv[âa]yet|haber\\s+ver|naklet|nakled|ded|dedi|demiş|buyur|anlat|söyle|bersabda|a dit|said)';
const MATN_KALIP = new RegExp(MATN_KOK + "[\\wçğıöşüÇĞİÖŞÜ]*(?:\\s+[\\wçğıöşüÇĞİÖŞÜ'’]+){0,2}\\s*(?::|ki\\s*,)", 'gi');
function latinMatn(x) {
  const re = new RegExp(MATN_KALIP.source, 'gi');
  let son = null, m;
  while ((m = re.exec(x))) { if (m.index < x.length * 0.7) son = m; else break; }
  if (!son) return x;
  const kalan = x.slice(son.index + son[0].length).replace(/^[\s:;.,"“«»)\]]+/, '').trim();
  if (kalan.length < 40 || !/^[\p{L}"“]/u.test(kalan) || /^(ki|ve|de|da)\b/i.test(kalan)) return x;
  return kalan;
}

// --- Arapça / Urduca / Endonezce isnad ayıklama (SOLDAN soyma) ---
const HRK = '[\\u064B-\\u0652\\u0670\\u0640\\u06D6-\\u06ED\\u200f]*';   // hareke/tatweel/RLM toleransı
const arEsnek = (w) => w.split('').map(ch => ch === ' ' ? '\\s+' : (/[اأإآ]/.test(ch) ? '[اأإآ]' : ch) + HRK).join('');
const AR_HALKA = ['حدثنا', 'حدثني', 'حدثنيه', 'حدثهم', 'اخبرنا', 'اخبرني', 'اخبرهم', 'انبانا', 'انباني', 'ثنا', 'سمعت', 'عن'].map(w => '(?:' + arEsnek('و') + ')?' + arEsnek(w)).join('|');
const AR_ONEK = ['قال', 'قالت', 'قالا', 'قالوا', 'وقال', 'فقال', 'يقول', 'ح'].map(arEsnek).join('|');
const AR_ARTIK = '(?:' + arEsnek('و') + '[^،:]{0,90}[،:][\\s\\u200f]*)?(?:[-ـ][^-ـ]{0,60}[-ـ][\\s،\\u200f]*)?';
const AR_PEEL = new RegExp('^[\\s\\u200f]*' + AR_ARTIK + '(?:(?:' + AR_ONEK + ')' + HRK + '[\\s:،.]*)*(?:' + AR_HALKA + ')' + HRK + '(?![\\u0621-\\u064A])[^،:]{0,120}[،:]' + HRK + '\\s*');
const UR_PEEL = /^\s*(?:\(.{0,50}?\)\s*)?(?:ہم\s+سے|ہم\s+کو|ہمیں|مجھ\s+سے|مجھ\s+کو|مجھے|ان\s+سے|ان\s+کو|انہیں|انہوں\s+نے|وہ|اور|پھر|کہا|کہ)?[^،۔]{0,110}?(?:بیان\s+کی(?:ا)?|خبر\s+دی|روایت\s+(?:کی|کرتے\s+ہیں)|نقل\s+ک(?:ی|رتے\s+ہیں)|حدیث\s+سنی|نے|سے)\s*[،۔]\s*/;
const ID_PEEL = /^\s*(?:[Tt]elah\s+)?(?:menceritakan|mengabarkan|memberitakan|mengkhabarkan|diceritakan|dikabarkan|meriwayatkan)\s+kepada\s*(?:kami|ku|nya|saya)?[^[]{0,40}\[[^\]]{0,140}\][\s,;]*(?:-[^-]{0,60}-[\s,;]*)?(?:(?:yang|dia|ia|beliau|dan)\s+)?(?:berkata|katanya|mengatakan)?[\s,;:]*|^\s*(?:dan\s+)?[Dd]ari\s+\[[^\]]{0,140}\][\s,;]*(?:-[^-]{0,60}-[\s,;]*)?(?:(?:yang|dia|ia|beliau)\s+)?(?:berkata|katanya|mengatakan)?[\s,;:]*|^\s*(?:aku|saya)\s+mendengar\s+\[[^\]]{0,140}\][\s,;]*(?:berkata|katanya)?[\s,;:]*/;
const URDU_HARF = /[ٹڈڑںھہےۃپچژگ]/;
function soyIsnad(x, re) {
  const bas = x;
  for (let i = 0; i < 14; i++) {
    const m = x.match(re);
    if (!m || !m[0]) break;
    const kalan = x.slice(m[0].length).trim();
    if (kalan.length < 60 || kalan.length < bas.length * 0.25) break;
    x = kalan;
  }
  return x;
}
export function hadisMatn(t) {
  const x = hadisMetni(t);
  // Dil parametresine değil METNİN KENDİSİNE bakarız: metinAl() istenen dil boşsa
  // en→tr'ye düşüyor, yani 'ar' istenen kayıt İngilizce metin taşıyabiliyor.
  if (/[؀-ۿ]/.test(x)) return soyIsnad(x, URDU_HARF.test(x) ? UR_PEEL : AR_PEEL);
  if (/\[[^\]]+\]|kepada kami|shallallahu/.test(x)) return latinMatn(soyIsnad(x, ID_PEEL));
  return latinMatn(x);
}
export function hadisMetni(t) {
  let x = (t || '').trim();
  const m = x.match(SERH_KALIP);
  if (m && m.index > 80) x = x.slice(0, m.index).trim();       // şerhten önceki kısım
  if (x.length > 1400) {                                        // hâlâ çok uzunsa cümle sınırında kes
    const kes = x.lastIndexOf('. ', 1400);
    x = (kes > 300 ? x.slice(0, kes + 1) : x.slice(0, 1400)) + ' …';
  }
  return x;
}
