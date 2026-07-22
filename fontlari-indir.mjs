// fontlari-indir.mjs — Google Fonts CSS'ini çekip woff2'leri yerele indirir, fonts.css üretir.
// Offline/paketleme için (CDN bağımlılığı kalksın). Tek seferlik.

import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const CSS_URL = 'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Amiri:wght@400;700&family=Sora:wght@500;600;700&display=swap';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const css = await (await fetch(CSS_URL, { headers: { 'User-Agent': UA } })).text();
await mkdir(new URL('./fonts/', import.meta.url), { recursive: true });

// Her @font-face bloğundaki woff2 URL'sini indir, yerel yola çevir.
const urls = [...css.matchAll(/url\((https:\/\/[^)]+\.woff2)\)/g)].map(m => m[1]);
const benzersiz = [...new Set(urls)];
console.log(`${benzersiz.length} woff2 indiriliyor...`);

let yeniCss = css;
for (const u of benzersiz) {
  const buf = Buffer.from(await (await fetch(u, { headers: { 'User-Agent': UA } })).arrayBuffer());
  // İçerik-hash'li isim: font değişince isim değişir → cache tuzağı yok, değişmeyen stabil kalır.
  const ad = createHash('sha256').update(buf).digest('hex').slice(0, 12) + '.woff2';
  await writeFile(new URL(`./fonts/${ad}`, import.meta.url), buf);
  yeniCss = yeniCss.split(u).join(`fonts/${ad}`);
}
await writeFile(new URL('./fonts.css', import.meta.url), yeniCss);
console.log(`fonts.css yazıldı (${benzersiz.length} yerel woff2). CDN bağımlılığı kalktı.`);
