/**
 * `POST /api/import-link` —— Apple Podcasts 链接 → 解析 RSS → 返回剧集列表
 *
 * 思路：
 *   ① 从 Apple 播客网页链接里抠出播客的数字 ID（和地区码）
 *   ② 调公开的 iTunes Lookup API 反查播主自托管的真实 feedUrl
 *   ③ 拉取该 feedUrl 的 RSS XML，解析出剧集列表（标题 / 音频直链 / 时长）
 *
 * 为什么放服务端做：iTunes Lookup 虽支持 CORS，但播主自托管的 feedUrl
 * 大多不开放 CORS，浏览器直连会被拦；放服务端拉就能绕开。
 * 这一步也天然兼容 Cloudflare Workers（只用到 fetch / URL / 正则，无 Node 专属 API）。
 *
 * 解析完之后，前端让用户勾选要导入的剧集，再调 `/api/import-link/import`
 * 建行并触发本机 worker 转写 —— 整套流程都不经过「让用户下载 RSS」。
 */

import { NextResponse } from "next/server";

import { BadRequestError, jsonError, readJsonBody } from "@/lib/api-helpers";

// 按需接口，绝不进缓存
export const dynamic = "force-dynamic";

type ImportLinkBody = { url?: unknown };

const APPLE_HOST = "podcasts.apple.com";

/** 匹配 Apple 播客链接里的地区码（可选）和播客数字 ID。 */
const APPLE_LINK_RE = /podcasts\.apple\.com\/(?:([a-z]{2})\/)?podcast\/[^/]*\/id(\d+)/i;

/** 浏览器化的 UA：部分播主 CDN 会拦默认 fetch UA，带一个能降低被拦概率。 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** 单次解析最多返回的剧集数，避免巨型 feed 撑爆响应。 */
const MAX_EPISODES = 200;

type LookupResult = {
  collectionName?: string;
  trackName?: string;
  feedUrl?: string;
  artworkUrl600?: string;
  artworkUrl100?: string;
};

export type ImportEpisode = {
  title: string;
  enclosureUrl: string;
  durationLabel: string | null;
  pubDate: string | null;
};

async function lookupFeedUrl(podcastId: string, country: string): Promise<LookupResult | null> {
  const endpoint = `https://itunes.apple.com/lookup?id=${encodeURIComponent(
    podcastId,
  )}&entity=podcast&country=${encodeURIComponent(country)}`;

  const response = await fetch(endpoint, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`iTunes Lookup 请求失败（HTTP ${response.status}）。`);
  }

  const data = (await response.json()) as { resultCount: number; results: LookupResult[] };
  if (!data.resultCount || data.resultCount < 1) {
    return null;
  }
  return data.results[0] ?? null;
}

/** 解码 XML 文本节点：剥离 CDATA、反转义常见 / 数字实体。 */
function decodeXmlText(raw: string): string {
  let text = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
  };
  text = text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (match) => named[match] ?? match);
  text = text.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  return text.trim();
}

/** 在单个 <item> 片段里抓第一个匹配标签的内容（支持 CDATA）。 */
function pickTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(re);
  return match ? decodeXmlText(match[1]) : null;
}

/** 在 <enclosure> 标签里抓 url 属性（兼容单 / 双引号）。 */
function pickEnclosureUrl(block: string): string | null {
  const tagMatch = block.match(/<enclosure\b[^>]*>/i);
  if (!tagMatch) return null;
  const urlMatch = tagMatch[0].match(/\burl\s*=\s*["']([^"']*)["']/i);
  return urlMatch ? urlMatch[1].trim() : null;
}

/** 从 RSS 文本里解析出剧集列表。 */
function parseEpisodes(rssText: string): ImportEpisode[] {
  const itemBlocks = rssText.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const episodes: ImportEpisode[] = [];

  for (const block of itemBlocks) {
    if (episodes.length >= MAX_EPISODES) break;

    const enclosureUrl = pickEnclosureUrl(block);
    // 没有可下载音频的条目（如纯文字公告）直接跳过
    if (!enclosureUrl || !/^https?:\/\//i.test(enclosureUrl)) {
      continue;
    }

    const title = pickTag(block, "title") || "未命名剧集";
    const durationLabel = pickTag(block, "itunes:duration") || null;
    const pubDate = pickTag(block, "pubDate") || null;

    episodes.push({ title, enclosureUrl, durationLabel, pubDate });
  }

  return episodes;
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<ImportLinkBody>(request);

    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!rawUrl) {
      throw new BadRequestError("请输入 Apple Podcasts 链接。");
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestError("链接格式不正确，请输入完整的 Apple Podcasts 网址。");
    }

    if (!parsed.hostname.endsWith(APPLE_HOST)) {
      throw new BadRequestError(
        "当前仅支持 Apple Podcasts 链接（podcasts.apple.com）。小宇宙版本后续开放。",
      );
    }

    const match = rawUrl.match(APPLE_LINK_RE);
    if (!match) {
      throw new BadRequestError(
        "没能从链接里识别到播客 ID。请确认是形如 https://podcasts.apple.com/.../id123456789 的播客主页链接。",
      );
    }
    const country = match[1]?.toLowerCase() || "us";
    const podcastId = match[2];

    // 先用链接里的地区查；查不到再退回 us，覆盖「粘贴了 cn 链接但节目在 us 区」等情况
    let result = await lookupFeedUrl(podcastId, country);
    if (!result && country !== "us") {
      result = await lookupFeedUrl(podcastId, "us");
    }

    if (!result || !result.feedUrl) {
      throw new BadRequestError(
        "在 Apple 目录里没找到这个播客，或该播客未提供公开的 RSS。请确认链接正确。",
      );
    }

    const feedResponse = await fetch(result.feedUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      cache: "no-store",
    });

    if (!feedResponse.ok) {
      throw new Error(`RSS 拉取失败（HTTP ${feedResponse.status}）。播主服务器可能拒绝了请求。`);
    }

    const rssText = await feedResponse.text();
    if (!rssText || !rssText.includes("<rss")) {
      throw new Error("拉到的内容不是合法的 RSS，无法解析。");
    }

    const episodes = parseEpisodes(rssText);

    return NextResponse.json({
      title: result.collectionName || result.trackName || "未命名播客",
      feedUrl: result.feedUrl,
      artworkUrl: result.artworkUrl600 || result.artworkUrl100 || null,
      episodeCount: episodes.length,
      episodes,
    });
  } catch (error) {
    return jsonError(error, "解析链接失败。");
  }
}
