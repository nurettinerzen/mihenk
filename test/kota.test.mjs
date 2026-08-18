import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToplamKota } from '../kota.mjs';

test('toplam kota restart sonrasında sıfırlanmaz', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'mihenk-kota-'));
  const dosya = join(dizin, 'kullanim.jsonl');
  try {
    const ilk = new ToplamKota({ limit: 5, dosya });
    assert.equal(await ilk.kalan('cihaz-a'), 5);
    for (let i = 0; i < 5; i++) assert.equal(await ilk.kullan('cihaz-a'), true);
    assert.equal(await ilk.kalan('cihaz-a'), 0);
    assert.equal(await ilk.kullan('cihaz-a'), false);

    const yeniden = new ToplamKota({ limit: 5, dosya });
    assert.equal(await yeniden.kalan('cihaz-a'), 0);
    assert.equal(await yeniden.kalan('cihaz-b'), 5);
    assert.equal(yeniden.cihazSayisi(), 1);

    const disk = readFileSync(dosya, 'utf8');
    assert.equal(disk.includes('cihaz-a'), false);
  } finally {
    rmSync(dizin, { recursive: true, force: true });
  }
});
