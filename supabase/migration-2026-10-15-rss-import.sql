-- ═══════════════════════════════════════════════════════════════
--  播客精听 —— RSS 导入迁移（2026-10-15）
--
--  适用：已经建过表的 Supabase 库（create table if not exists 不会给
--        已存在的表加列 / 改索引，所以必须单独跑这一段）。
--
--  用法：Supabase Dashboard → SQL Editor → New query → 整段粘贴 → Run。
--        全部 if not exists / drop if exists，可重复执行，不会报错。
-- ═══════════════════════════════════════════════════════════════

-- 1. 新增远程音频直链列（本地上传保持 NULL）
alter table public.podcasts
  add column if not exists source_audio_url text;

-- 2. 让认领函数也能认领「远程音频」任务：
--    把源函数里 `where audio_uploaded_at is not null` 改成
--    `where (audio_uploaded_at is not null or source_audio_url is not null)`
--    （用下面这段 create or replace 整段覆盖即可，与 schema.sql 第 6 节一致）
create or replace function public.claim_next_podcast(p_worker_id text)
returns setof public.podcasts
language sql
security definer
set search_path = public
as $$
  with candidate as (
    select id
      from public.podcasts
     where (audio_uploaded_at is not null or source_audio_url is not null)
       and attempts < 3
       and (
             status = 'queued'
             -- 租约超时：上一个 worker 大概率已经死了
             or (status = 'processing' and locked_at < now() - interval '30 minutes')
           )
     order by created_at
     for update skip locked
     limit 1
  )
  update public.podcasts p
     set status     = 'processing',
         stage      = 'transcribing',
         progress   = greatest(p.progress, 2),
         locked_by  = p_worker_id,
         locked_at  = now(),
         attempts   = p.attempts + 1,
         updated_at = now()
    from candidate c
   where p.id = c.id
  returning p.*;
$$;

-- 3. 认领索引覆盖新谓词
drop index if exists podcasts_claim_idx;
create index if not exists podcasts_claim_idx
  on public.podcasts (status, created_at)
  where (audio_uploaded_at is not null or source_audio_url is not null);

-- 4. 重复导入同集时幂等去重（兜底竞态）
create unique index if not exists podcasts_source_audio_url_key
  on public.podcasts (source_audio_url)
  where source_audio_url is not null;
