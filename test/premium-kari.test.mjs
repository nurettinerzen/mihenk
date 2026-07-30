import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../hadis.html', import.meta.url), 'utf8');

test('ücretsiz dinleme yalnız Alafasy ile sınırlıdır', () => {
  assert.match(html, /const UCRETSIZ_KARI = 'ar\.alafasy'/);
  assert.match(html, /if\(!premium && secilen!==UCRETSIZ_KARI\)/);
  assert.match(html, /paywallGoster\('kari-sec'\)/);
});

test('ücretsiz kullanıcı indirilmiş premium sesi çevrimdışı oynatamaz', () => {
  assert.match(html, /async function sesKaynagi\(id\)\{\s*[\s\S]*?if\(!premium\) return sesUrl\(id\)/);
  assert.match(html, /if\(!premium && kari!==UCRETSIZ_KARI\)/);
});

test('Plus paketi yedi kâriyi ve çevrimdışı dinlemeyi anlatır', () => {
  const blok = html.match(/const KARILER=\[([\s\S]*?)\];/)?.[1] || '';
  assert.equal((blok.match(/\{id:/g) || []).length, 7);
  assert.match(html, /Tüm kâriler, çevrimdışı dinleme ve sınırsız arama/);
});
