// yap-www.mjs — Capacitor webDir'ini (www/) hadis.html + fonts'tan derler.
// Tek kaynak hadis.html; iOS app bunu bundle'lar, backend'i (Render) uzaktan çağırır.

import { mkdir, copyFile, readdir, rm } from 'node:fs/promises';

const kok = new URL('./', import.meta.url);
const www = new URL('./www/', import.meta.url);
await rm(www, { recursive: true, force: true });
await mkdir(new URL('./fonts/', www), { recursive: true });

await copyFile(new URL('./hadis.html', kok), new URL('./index.html', www));
await copyFile(new URL('./fonts.css', kok), new URL('./fonts.css', www));
for (const f of await readdir(new URL('./fonts/', kok))) {
  await copyFile(new URL(`./fonts/${f}`, kok), new URL(`./fonts/${f}`, www));
}
console.log('www/ hazır (Capacitor webDir): index.html + fonts.css + fonts/');
