// RevenueCat'teki ÖLÇÜM kaynaklı sahte müşterileri siler.
//
// Neden var: RC'nin GET /subscribers/{id} ucu olmayan kimliği sessizce OLUŞTURUYOR.
// 16 Ağu 2026'da arama kalitesi canlı API'ye karşı ölçülünce ~950 test kimliği
// RC'de müşteri olarak belirdi ve kullanıcı grafiğini kullanılamaz hâle getirdi.
// (Sunucu artık bu önekleri RC'ye hiç sormuyor — bu betik geçmişi temizler.)
//
// İKİ KİP, anahtara göre kendi seçiliyor:
//   sk_… (v2 anahtarı) → müşterileri LİSTELER, desene uyanları siler (kesin)
//   diğer (v1/eski)    → v2 listeleme yok; ölçüm kimlikleri ÜRETİLİR ve tek tek
//                        silinir. Kimlikler `önek-sayı` biçiminde olduğu için
//                        aralık taramak yeterli; olmayan kimlik 404 döner, zararsız.
//
// Kullanım:
//   node rc-temizle.mjs            → yalnız SAYAR/gösterir, hiçbir şey silmez
//   node rc-temizle.mjs --sil      → gerçekten siler
//
// Anahtar .env'den okunur (RC_V2_SECRET ya da RC_SECRET); ekrana asla basılmaz.
import { readFileSync } from 'node:fs';

const PROJE = '505344ff';                                   // Mihenk
// Yalnızca ölçüm/otomasyon kimlikleri. GERÇEK kullanıcı kimliği RevenueCat'in
// anonim biçimi ($RCAnonymousID:…) ya da bir UUID — hiçbiri bu desene uymaz.
const SILINECEK = /^(test-|teshis-|ekran-goruntusu-|kurulum-testi$)/;

// v1 kipinde taranacak önekler ve üst sınır. Ölçüm betiklerinin ürettiği
// kimlikler `önek-1`, `önek-2`, … diye gidiyordu; sınır bolca yukarıdan alındı.
const ONEKLER = ['test-cip', 'test-alt', 'test-t2', 'test-kel', 'test-tam',
                 'test-skor', 'test-sn', 'test-k', 'test-kl', 'test-sr',
                 'test-hakdog', 'teshis-test'];
const UST_SINIR = 400;
const TEKIL = ['test-warm', 'test-warm2', 'test-tekil-1', 'kurulum-testi'];

const SIL = process.argv.includes('--sil');

const anahtar = (() => {
  for (const ad of ['RC_V2_SECRET', 'RC_SECRET']) {
    if (process.env[ad]) return process.env[ad];
  }
  try {
    const satirlar = readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n');
    for (const ad of ['RC_V2_SECRET', 'RC_SECRET']) {
      const s = satirlar.find((x) => x.startsWith(ad + '='));
      const v = (s || '').slice(ad.length + 1).trim();
      if (v) return v;
    }
  } catch { /* .env yok */ }
  return '';
})();

if (!anahtar) {
  console.error('Anahtar boş. .env içine RC_V2_SECRET=… (ya da RC_SECRET=…) yaz.');
  process.exit(1);
}

// Kipi anahtarın ÖNEKİNDEN anlamaya çalışmak yanlış: eski (legacy) anahtarlar da
// `sk_` ile başlıyor. Kip, v2 listeleme ucunu DENEYEREK belirlenir.
let v2Mi = false;
const bas = { Authorization: `Bearer ${anahtar}` };

async function iste(url, secenek = {}) {
  const r = await fetch(url, { ...secenek, headers: { ...bas, ...(secenek.headers || {}) } });
  if (r.status === 429) {                    // RC hız sınırı → bekle, tekrar dene
    await new Promise((c) => setTimeout(c, 2000));
    return iste(url, secenek);
  }
  return r;
}

async function jsonIste(url, secenek) {
  const r = await iste(url, secenek);
  if (!r.ok) throw new Error(`${secenek?.method || 'GET'} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

let hedef = [], toplam = 0;

// Kip tespiti: v2 listeleme bir kez denenir. 401/403 → eski anahtar, v1 kipine düş.
{
  const r = await iste(`https://api.revenuecat.com/v2/projects/${PROJE}/customers?limit=1`);
  v2Mi = r.ok;
  if (!v2Mi && r.status !== 401 && r.status !== 403)
    console.warn(`v2 listeleme beklenmedik yanıt verdi (${r.status}); v1 kipiyle devam ediliyor.`);
}

if (v2Mi) {
  // --- v2: gerçek listeleme ---
  const API = 'https://api.revenuecat.com/v2';
  let imlec = null;
  do {
    const s = new URLSearchParams({ limit: '100', ...(imlec ? { starting_after: imlec } : {}) });
    const sayfa = await jsonIste(`${API}/projects/${PROJE}/customers?${s}`);
    const kayitlar = sayfa.items || [];
    toplam += kayitlar.length;
    for (const m of kayitlar) if (SILINECEK.test(m.id || '')) hedef.push(m.id);
    imlec = sayfa.next_page ? kayitlar.at(-1)?.id : null;
    process.stdout.write(`\rtarandı: ${toplam} · eşleşen: ${hedef.length}`);
  } while (imlec);
  console.log('');
  if (hedef.length && hedef.length === toplam) {
    console.error(`DURDURULDU: ${toplam} müşterinin TAMAMI desene uyuyor. Desen yanlış olabilir.`);
    process.exit(1);
  }
  console.log(`${toplam} müşteriden ${hedef.length} tanesi ölçüm kaydı · ${toplam - hedef.length} korunacak.`);
} else {
  // --- v1: listeleme yok, kimlikleri üret ---
  for (const o of ONEKLER) for (let i = 1; i <= UST_SINIR; i++) hedef.push(`${o}-${i}`);
  hedef.push(...TEKIL);
  console.log(`v1 anahtarı: listeleme yok, ${hedef.length} ölçüm kimliği denenecek.`);
  console.log('Olmayan kimlik 404 döner ve atlanır — gerçek kullanıcı bu desene uymaz.');
}

// Son emniyet: desene uymayan bir şey listeye sızmasın.
const sizinti = hedef.filter((id) => !SILINECEK.test(id));
if (sizinti.length) {
  console.error('DURDURULDU: desene uymayan kimlik var →', sizinti.slice(0, 5).join(', '));
  process.exit(1);
}
if (!hedef.length) { console.log('Silinecek ölçüm kaydı yok.'); process.exit(0); }
console.log('İlk 5 örnek:', hedef.slice(0, 5).join(', '));

if (!SIL) { console.log('\nKuru koşu. Gerçekten silmek için: node rc-temizle.mjs --sil'); process.exit(0); }

// --- Sil ---
const silUrl = (id) => v2Mi
  ? `https://api.revenuecat.com/v2/projects/${PROJE}/customers/${encodeURIComponent(id)}`
  : `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(id)}`;

let silinen = 0, yok = 0, hata = 0, islenen = 0;
for (const id of hedef) {
  try {
    const r = await iste(silUrl(id), { method: 'DELETE' });
    if (r.ok) silinen++;
    else if (r.status === 404) yok++;
    else { hata++; if (hata <= 3) console.error(`\n${id} → ${r.status} ${await r.text()}`); }
  } catch (e) { hata++; if (hata <= 3) console.error('\n' + e.message); }
  if (++islenen % 25 === 0 || islenen === hedef.length)
    process.stdout.write(`\rilerleme: ${islenen}/${hedef.length} · silinen: ${silinen} · zaten yok: ${yok}${hata ? ` · hata: ${hata}` : ''}`);
}
console.log(`\nBitti. Silinen: ${silinen} · zaten yok: ${yok} · hata: ${hata}`);
