// Cihaz başına toplam ücretsiz AI sorgusu.
//
// Kota sunucu belleğinde tutulursa her deploy/restart kullanıcıya yeniden hak verir.
// Render'ın kalıcı diskine append-only yazıyoruz; başlangıçta dosyayı okuyup sayacı
// yeniden kuruyoruz. Ham cihaz kimliği diske girmez, yalnız SHA-256 özeti saklanır.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const varsayilanDosya = () => process.env.KOTA_DOSYA
  || (existsSync('/veri') ? '/veri/kota/kullanim.jsonl' : './veri/kota/kullanim.jsonl');

export class ToplamKota {
  constructor({ limit = 5, dosya = varsayilanDosya() } = {}) {
    this.limit = Math.max(0, Number(limit) || 0);
    this.dosya = dosya;
    this.sayac = new Map();
    try { mkdirSync(dirname(dosya), { recursive: true }); }
    catch { /* salt-okunur ortam: bellek sayacı yine çalışır */ }
    this.#yukle();
  }

  #anahtar(cihaz) {
    return createHash('sha256').update(String(cihaz || 'anon')).digest('hex');
  }

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
      console.warn('[KOTA] okunamadı:', e.message);
    }
  }

  kalan(cihaz) {
    const kullanilan = this.sayac.get(this.#anahtar(cihaz)) || 0;
    return Math.max(0, this.limit - kullanilan);
  }

  kullan(cihaz) {
    const c = this.#anahtar(cihaz);
    const kullanilan = this.sayac.get(c) || 0;
    if (kullanilan >= this.limit) return false;
    this.sayac.set(c, kullanilan + 1);
    try {
      appendFileSync(this.dosya, JSON.stringify({ c, t: new Date().toISOString() }) + '\n');
    } catch (e) {
      // İstek sırasında kullanıcıyı cezalandırma; mevcut süreçte sayaç düşmüş kalır.
      // Disk düzelmezse restart sonrası bu tek kullanım geri gelebilir.
      console.warn('[KOTA] yazılamadı:', e.message);
    }
    return true;
  }

  cihazSayisi() {
    return this.sayac.size;
  }
}

export const toplamKota = new ToplamKota({
  limit: Number(process.env.FREE_LIMIT || 5),
});
