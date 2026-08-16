// RevenueCat'teki ÖLÇÜM kaynaklı sahte müşterileri siler.
//
// Neden var: RC'nin GET /subscribers/{id} ucu olmayan kimliği sessizce OLUŞTURUYOR.
// 16 Ağu 2026'da arama kalitesi canlı API'ye karşı ölçülünce ~950 test kimliği
// RC'de müşteri olarak belirdi ve kullanıcı grafiğini kullanılamaz hâle getirdi.
// (Sunucu artık bu önekleri RC'ye hiç sormuyor — bu betik geçmişi temizler.)
//
// Kullanım:
//   node rc-temizle.mjs            → yalnız SAYAR, hiçbir şey silmez (varsayılan)
//   node rc-temizle.mjs --sil      → eşleşenleri gerçekten siler
//
// Anahtar .env içindeki RC_V2_SECRET'ten okunur; ekrana hiçbir zaman basılmaz.
import { readFileSync } from 'node:fs';

const PROJE = '505344ff';                                   // Mihenk
// Yalnızca ölçüm/otomasyon kimlikleri. GERÇEK kullanıcı kimliği RevenueCat'in
// kendi anonim biçimi ($RCAnonymousID:…) ya da bir UUID — hiçbiri bu desene uymaz.
const SILINECEK = /^(test-|teshis-|ekran-goruntusu-|kurulum-testi$)/;

const SIL = process.argv.includes('--sil');

const anahtar = (() => {
  if (process.env.RC_V2_SECRET) return process.env.RC_V2_SECRET;
  try {
    const satir = readFileSync(new URL('.env', import.meta.url), 'utf8')
      .split('\n').find((s) => s.startsWith('RC_V2_SECRET='));
    return (satir || '').slice('RC_V2_SECRET='.length).trim();
  } catch { return ''; }
})();

if (!anahtar) {
  console.error('RC_V2_SECRET boş. .env dosyasına yaz (sk_ ile başlayan Secret API key).');
  process.exit(1);
}

const API = 'https://api.revenuecat.com/v2';
const bas = { Authorization: `Bearer ${anahtar}` };

async function iste(yol, secenek = {}) {
  const r = await fetch(API + yol, { ...secenek, headers: { ...bas, ...(secenek.headers || {}) } });
  if (r.status === 429) {                    // RC hız sınırı → bekle, tekrar dene
    await new Promise((c) => setTimeout(c, 2000));
    return iste(yol, secenek);
  }
  if (!r.ok) throw new Error(`${secenek.method || 'GET'} ${yol} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// --- 1) Tüm müşterileri sayfa sayfa gez, eşleşenleri topla ---
const hedef = [];
let toplam = 0, imlec = null;
do {
  const s = new URLSearchParams({ limit: '100', ...(imlec ? { starting_after: imlec } : {}) });
  const sayfa = await iste(`/projects/${PROJE}/customers?${s}`);
  const kayitlar = sayfa.items || [];
  toplam += kayitlar.length;
  for (const m of kayitlar) if (SILINECEK.test(m.id || '')) hedef.push(m.id);
  imlec = sayfa.next_page ? kayitlar.at(-1)?.id : null;
  process.stdout.write(`\rtarandı: ${toplam} · eşleşen: ${hedef.length}`);
} while (imlec);
console.log('');

// --- 2) Emniyet: hepsini silmeye kalkıyorsak bir yerde hata var, dur ---
if (!hedef.length) { console.log('Silinecek ölçüm kaydı yok.'); process.exit(0); }
if (hedef.length === toplam && toplam > 0) {
  console.error(`DURDURULDU: ${toplam} müşterinin TAMAMI desene uyuyor. Desen yanlış olabilir.`);
  process.exit(1);
}

console.log(`${toplam} müşteriden ${hedef.length} tanesi ölçüm kaydı · ${toplam - hedef.length} tanesi korunacak.`);
console.log('İlk 5 örnek:', hedef.slice(0, 5).join(', '));

if (!SIL) { console.log('\nKuru koşu. Gerçekten silmek için: node rc-temizle.mjs --sil'); process.exit(0); }

// --- 3) Sil ---
let silinen = 0, hata = 0;
for (const id of hedef) {
  try { await iste(`/projects/${PROJE}/customers/${encodeURIComponent(id)}`, { method: 'DELETE' }); silinen++; }
  catch (e) { hata++; if (hata <= 3) console.error('\n' + e.message); }
  if (silinen % 25 === 0 || silinen + hata === hedef.length) process.stdout.write(`\rsilinen: ${silinen}/${hedef.length}${hata ? ` · hata: ${hata}` : ''}`);
}
console.log(`\nBitti. Silinen: ${silinen} · hata: ${hata}`);
