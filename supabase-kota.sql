-- Mihenk — cihaz başına toplam ücretsiz sorgu sayacı.
-- Supabase → SQL Editor → yapıştır → Run. Bir kez çalıştırılır.
--
-- Neden gerekiyor: Render free planında kalıcı disk yok ve instance uykuya dalınca
-- konteyner dosya sistemi sıfırlanıyor. Sayaç orada tutulduğu sürece "toplam 5
-- ücretsiz sorgu" fiilen "her uyanışta 5" oluyordu ve paywall hiç tetiklenmiyordu.
--
-- Gizlilik: `cihaz` kolonu ham cihaz kimliği DEĞİL, onun SHA-256 özetidir (64 hex).
-- Kullanıcıya geri götürülebilecek hiçbir alan yoktur.

create table if not exists mihenk_kota (
  cihaz  text primary key,                       -- SHA-256(cihaz kimliği), 64 hex
  sayac  integer not null default 0,             -- kullanılmış toplam ücretsiz sorgu
  guncel timestamptz not null default now()
);

-- Panelden "son 7 günde kaç yeni cihaz kota tüketti" gibi sorgular için.
create index if not exists mihenk_kota_guncel_idx on mihenk_kota (guncel);

-- Bu tabloya YALNIZCA service_role erişir (sunucu SUPABASE_SERVICE_KEY kullanır).
-- RLS açık + hiç policy yok = anon/authenticated anahtarlarla satır görünmez.
alter table mihenk_kota enable row level security;
