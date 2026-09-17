import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../hadis.html',import.meta.url),'utf8');
function setup(getProducts){
 const calls=[];
 const c=vm.createContext({Object,Promise,Error,console,setTimeout,clearTimeout,URUNLER:{yillik:'year',aylik:'month'},seciliUrun:'year',rcUrunler:null,
 CapEklenti:()=>({Purchases:{getProducts}}),cihazAl:async()=>{},rcKur:async()=>true,
 iapPremiumKontrol:()=>new Promise(()=>{}),fiyatCiz(){},avantajCiz(){},denemeCiz(){},paywallDugmeCiz(){},urunYokGizle(){calls.push('hide')},olay:(...x)=>calls.push(x),duzId:id=>id.split(':')[0]});
 vm.runInContext(html.slice(html.indexOf('const urunlerHazirMi'),html.indexOf('async function iapBaslat')),c);
 return {c,calls,run:()=>vm.runInContext('_iapCalistir()',c)};
}
test('hak sorgusu takılsa da iki mağaza ürünü yüklenir',async()=>{
 const {c,run}=setup(async()=>({products:[{identifier:'year:annual'},{identifier:'month:monthly'}]}));
 assert.equal(await run(),true);assert.equal(vm.runInContext('urunlerHazirMi()',c),true);
});
test('kısmi katalog tamamlanana kadar tekrar gerekir; eldeki ürün kaybolmaz',async()=>{
 let n=0;const {c,run}=setup(async()=>({products:[{identifier:++n===1?'month':'year'}]}));
 assert.equal(await run(),false);assert.equal(vm.runInContext('seciliUrunHazirMi()',c),false);
 assert.equal(await run(),true);assert(c.rcUrunler.month);assert(c.rcUrunler.year);
});
test('boş yanıt önceki fiyatı silmez ve eksik planı hazır saymaz',async()=>{
 const {c,run}=setup(async()=>({products:[]}));c.rcUrunler={year:{identifier:'year',priceString:'$5'}};
 assert.equal(await run(),false);assert.equal(c.rcUrunler.year.priceString,'$5');
});
test('mağaza zaman aşımı beklemeyi sonlandırır, sonraki istek çalışır',async()=>{
 const {c}=setup(async()=>({products:[]}));
 await assert.rejects(vm.runInContext('iapZamanli(new Promise(()=>{}), 5)',c),e=>e.code==='TIMEOUT');
 assert.equal(await vm.runInContext('iapZamanli(Promise.resolve(true),5)',c),true);
});
test('HTML scriptleri geçerli JavaScript',()=>{for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new Function(m[1]);});
