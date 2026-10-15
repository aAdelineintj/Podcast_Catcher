/**
 * `POST /api/import-link/import` —— 把用户勾选的 RSS 剧集写入 podcasts 并触发转写
 *
 * 设计要点：
 *   · 只建行、不下载音频。音频由**本机 worker** 在认领后从 `source_audio_url`
 *     远程下载、转写、再回存 Storage —— 算力留本机，避免 Serverless 扛大文件。
 *   · 去重：同一集的 enclosureUrl 已存在则跳过（部分唯一索引 `podcasts_source_audio_url_key` 兜底）。
 *   · 新建行 `audio_path` / `audio_uploaded_at` 为 NULL、`source_audio_url` 非空，
 *     认领函数（claim_next_podcast）据此认领，worker 开工。
 */

import { NextResponse } from "next/server";

import { BadRequestError, jsonError, readJsonBody } from "@/lib/api-helpers";
import { normalizeSourceLanguage, type PodcastRow } from "@/lib/podcast-rows";
import { insertRows, selectRows } from "@/lib/supabase-server";

// 按需接口，绝不进缓存
export const dynamic = "force-dynamic";

type ImportEpisodeInput = {
  title?: unknown;
  enclosureUrl?: unknown;
  durationLabel?: unknown;
};

type NormalizedEpisode = {
  title: string;
  enclosureUrl: string;
  durationLabel?: string;
};

type ImportBody = {
  episodes?: unknown;
  sourceLanguage?: unknown;
};

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<ImportBody>(request);

    const rawEpisodes = Array.isArray(body.episodes) ? body.episodes : [];
    if (rawEpisodes.length === 0) {
      throw new BadRequestError("没有选中任何剧集。");
    }

    // 只保留「有合法音频直链」的条目，并去重（同一集在 feed 里出现两次等）
    const seen = new Set<string>();
    const episodes: NormalizedEpisode[] = [];
    for (const item of rawEpisodes) {
      const candidate = item as ImportEpisodeInput;
      if (!isHttpUrl(candidate.enclosureUrl)) continue;
      const url = candidate.enclosureUrl.trim();
      if (seen.has(url)) continue;
      seen.add(url);
      const title =
        typeof candidate.title === "string" && candidate.title.trim()
          ? candidate.title.trim()
          : "未命名剧集";
      episodes.push({
        title,
        enclosureUrl: url,
        durationLabel:
          typeof candidate.durationLabel === "string"
            ? candidate.durationLabel.trim()
            : undefined,
      });
    }

    if (episodes.length === 0) {
      throw new BadRequestError("选中的剧集都没有可用的音频链接，无法导入。");
    }

    const sourceLanguage = normalizeSourceLanguage(body.sourceLanguage);

    // ── 去重：拉回所有已写入的 source_audio_url，本地 Set 比对 ──
    // 不用 `or=(eq.source_audio_url.<url>,...)`：PostgREST 对嵌入完整 URL 的过滤器
    // 直接 400（URL 里的 `:` / `/` / `%` 让过滤器解析失败）。改成「拉回 + JS 比对」，
    // 请求里不出现任何 URL 值，彻底绕开这个坑。
    const existing = await selectRows<{ source_audio_url: string }>("podcasts", {
      select: "source_audio_url",
    });
    const existingUrls = new Set(
      existing.map((row) => row.source_audio_url).filter((u): u is string => Boolean(u)),
    );

    const newEpisodes = episodes.filter((ep) => !existingUrls.has(ep.enclosureUrl));
    const skipped = episodes.length - newEpisodes.length;

    if (newEpisodes.length === 0) {
      return NextResponse.json({ created: 0, skipped, ids: [] });
    }

    const rows = newEpisodes.map((ep) => ({
      title: ep.title,
      // filename 仅作展示标签用（RSS 流程不走 buildAudioObjectPath），
      // 直接存剧集标题，便于在列表 / 详情里辨识
      filename: ep.title.slice(0, 200),
      source_language: sourceLanguage,
      source_audio_url: ep.enclosureUrl,
      duration_label: ep.durationLabel ?? null,
      status: "queued",
      stage: "queued",
      progress: 0,
    }));

    const inserted = await insertRows<PodcastRow>("podcasts", rows);
    const ids = inserted.map((row) => row.id).filter((id): id is string => Boolean(id));

    return NextResponse.json({ created: inserted.length, skipped, ids });
  } catch (error) {
    return jsonError(error, "导入失败。");
  }
}
