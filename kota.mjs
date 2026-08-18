// Cihaz başına TOPLAM ücretsiz AI sorgusu sayacı.
//
// NEDEN SUPABASE (7 Ağu 2026 ölçümü):
// Sayaç önce bellekte, sonra konteyner diskinde (./veri) tutuluyordu. Render'ın
// free planında kalıcı disk YOK ve instance 15 dk hareketsizlikte uyuyor; uyanışta
// konteyner FS'i sıfırdan kuruluyor. Ölçüm: kota tüketildikten 45 dk sonra aynı
// cihaz `kalan:5` aldı. Yani "toplam 5 ücretsiz sorgu" fiilen "her uyanışta 5"
// demekti ve PAYWALL HİÇ TETİKLENMİYORDU. Sayaç artık Supabase'de (PostgREST)
// tutulur; konteyner FS'i yalnızca yedek/hızlı yol olarak kalır.
//
// KURALLAR
// - Ham cihaz kimliği hiçbir yere yazılmaz; yalnız SHA-256 özeti saklanır.
// - FAIL-OPEN: Supabase'e ulaşılamazsa hizmet KESİLMEZ. Yalnız loglanır ve o an
//   elimizdeki (yerel) sayaçla devam edilir. Ödeme altyapısı arızalıyken ücretsiz
//   kullanıcıyı kapıda bırakmak, birkaç fazla ücretsiz sorgudan çok daha pahalı.
// - Sayaç süreç içinde monoton artar ve her artışta uzağa yazılır; tek instance
//   çalıştığımız için (Render free) yarış durumu pratikte oluşmaz. İki instance
//   açılırsa en kötü ihtimalle bir cihaz birkaç fazla ücretsiz sorgu alır.
//
// Tablo şeması: supabase-kota.sql (kullanıcı Supabase SQL Editor'de bir kez çalıştırır)
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const varsayilanDosya = () => process.env.KOTA_DOSYA
  || (existsSync('/veri') ? '/veri/kota/kullanim.jsonl' : './veri/kota/kullanim.jsonl');

const TABLO = process.env.KOTA_TABLO || 'mihenk_kota';
const UZAK_ZAMAN_ASIMI = Number(process.env.KOTA_TIMEOUT_MS || 4000);

export class ToplamKota {
  constructor({ limit = 5, dosya = varsayilanDosya(), url = '', anahtar = '' } = {}) {
    this.limit = Math.max(0, Number(limit) || 0);
    this.dosya = dosya;
    this.url = (url || '').replace(/\/+$/, '');
    this.anahtar = anahtar || '';
    this.sayac = new Map();      // hash -> bilinen en yüksek kullanım
    this.cozuldu = new Set();    // hash -> uzaktan (Supabase) bir kez okundu
    this.uzakHata = 0;           // ölçüm: kaç kez uzağa ulaşılamadı
    this.uzakOkuma = 0; this.uzakYazma = 0;
    try { mkdirSync(dirname(dosya), { recursive: true }); }
    catch { /* salt-okunur ortam: bellek sayacı yine çalışır */ }
    this.#yukle();
  }

  get uzakAcik() { return Boolean(this.url && this.anahtar); }
  get diskKalici() { return this.dosya.startsWith('/veri/'); }

  #anahtarla(cihaz) {
    return createHash('sha256').update(String(cihaz || 'anon')).digest('hex');
  }

  #baslik(ek = {}) {
    return { apikey: this.anahtar, authorization: `Bearer ${this.anahtar}`, 'content-type': 'application/json', ...ek };
  }

  // Konteyner FS'indeki append-only yedek. Uyanışta genelde boştur (free plan),
  // ama Starter'a dönülüp disk takılırsa ya da yerelde çalışırken işe yarar.
  #yukle() {
    if (!existsSync(this.dosya)) return;
    try {
      for (const satir of readFileSync(this.dosya, 'utf8').split('\n')) {
        if (!satir) continue;
        try {
          const kayit = JSON.parse(satir);
          if (!/^[a-f0-9]{64}$/.test(kayit.c || '')) continue;
          const onceki = this.sayac.get(kayit.c) || 0;
          this.sayac.set(kayit.c, Math.min(this.limit, onceki + 1));
        } catch { /* yarım/bozuk satırı atla */ }
      }
    } catch (e) {
      console.warn('[KOTA] yerel yedek okunamadı:', e.message);
    }
  }

  async #uzakIstek(yol, secenek = {}) {
    const iptal = AbortSignal.timeout(UZAK_ZAMAN_ASIMI);
    const r = await fetch(`${this.url}/rest/v1/${yol}`, { ...secenek, signal: iptal });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const metin = await r.text();
    return metin ? JSON.parse(metin) : null;
  }

  // Bu cihazın uzak sayacını bir kez okuyup belleğe yerleştirir.
  // Ulaşılamazsa sessizce yerel değerle devam edilir (fail-open).
  async #coz(c) {
    if (!this.uzakAcik || this.cozuldu.has(c)) return;
    try {
      this.uzakOkuma++;
      const satir = await this.#uzakIstek(`${TABLO}?cihaz=eq.${c}&select=sayac&limit=1`, { headers: this.#baslik() });
      const uzak = Number(satir && satir[0] && satir[0].sayac) || 0;
      // Yerel yedek uzaktan yüksekse (uzağa yazma başarısız olmuş olabilir) yükseği al.
      this.sayac.set(c, Math.max(this.sayac.get(c) || 0, uzak));
      this.cozuldu.add(c);
    } catch (e) {
      this.uzakHata++;
      console.warn('[KOTA] uzak okunamadı (fail-open):', e.message);
      // cozuldu'ya EKLEME: sonraki istekte yeniden dene.
    }
  }

  async #uzakYaz(c, sayi) {
    if (!this.uzakAcik) return;
    try {
      this.uzakYazma++;
      await this.#uzakIstek(`${TABLO}?on_conflict=cihaz`, {
        method: 'POST',
        headers: this.#baslik({ prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ cihaz: c, sayac: sayi, guncel: new Date().toISOString() }),
      });
    } catch (e) {
      this.uzakHata++;
      console.warn('[KOTA] uzak yazılamadı:', e.message);
    }
  }

  async kalan(cihaz) {
    const c = this.#anahtarla(cihaz);
    await this.#coz(c);
    const kullanilan = this.sayac.get(c) || 0;
    return Math.max(0, this.limit - kullanilan);
  }

  async kullan(cihaz) {
    const c = this.#anahtarla(cihaz);
    await this.#coz(c);
    const kullanilan = this.sayac.get(c) || 0;
    if (kullanilan >= this.limit) return false;
    const yeni = kullanilan + 1;
    this.sayac.set(c, yeni);
    try {
      appendFileSync(this.dosya, JSON.stringify({ c, t: new Date().toISOString() }) + '\n');
    } catch (e) {
      // İstek sırasında kullanıcıyı cezalandırma; asıl kalıcılık Supabase'de.
      console.warn('[KOTA] yerel yedeğe yazılamadı:', e.message);
    }
    await this.#uzakYaz(c, yeni);
    return true;
  }

  cihazSayisi() {
    return this.sayac.size;
  }

  // /olcum ucunda görünür: kalıcılık gerçekten çalışıyor mu, panelden anlaşılsın.
  durum() {
    return {
      kalici: this.uzakAcik || this.diskKalici,
      depo: this.uzakAcik ? 'supabase+disk' : this.diskKalici ? 'disk' : 'gecici-disk',
      tablo: this.uzakAcik ? TABLO : null,
      cihaz: this.sayac.size, okuma: this.uzakOkuma, yazma: this.uzakYazma, hata: this.uzakHata,
    };
  }
}

export const toplamKota = new ToplamKota({
  limit: Number(process.env.FREE_LIMIT || 5),
  url: process.env.SUPABASE_URL || '',
  anahtar: process.env.SUPABASE_SERVICE_KEY || '',
});

if (!toplamKota.uzakAcik && !toplamKota.diskKalici) {
  console.warn('[KOTA] ⚠️ SUPABASE_URL/SUPABASE_SERVICE_KEY yok — kota KALICI DEĞİL: '
    + 'sunucu her uyandığında ücretsiz hak sıfırlanır ve paywall tetiklenmez.');
}
