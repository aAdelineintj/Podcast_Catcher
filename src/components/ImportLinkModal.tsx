"use client";

import React, { useState } from "react";
import {
  Check,
  X,
  Loader2,
  Link2,
  AlertCircle,
  ArrowLeft,
  ListChecks,
} from "lucide-react";
import { apiRequest } from "@/lib/api";
import type { SourceLanguage } from "@/types/podcast";

type ImportEpisode = {
  title: string;
  enclosureUrl: string;
  durationLabel: string | null;
  pubDate: string | null;
};

type ImportLinkResult = {
  title: string;
  feedUrl: string;
  artworkUrl: string | null;
  episodeCount: number;
  episodes: ImportEpisode[];
};

type ImportSuccess = {
  created: number;
  skipped: number;
};

const LANGUAGE_OPTIONS: { value: SourceLanguage; label: string }[] = [
  { value: "fr", label: "法语" },
  { value: "en", label: "英语" },
  { value: "zh", label: "中文" },
  { value: "zh_en", label: "中英混合" },
  { value: "auto", label: "自动" },
];

export function ImportLinkModal({
  onClose,
  onImported,
  defaultSourceLanguage = "auto",
}: {
  onClose: () => void;
  onImported?: () => void;
  defaultSourceLanguage?: SourceLanguage;
}) {
  const [url, setUrl] = useState("");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportLinkResult | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sourceLanguage, setSourceLanguage] =
    useState<SourceLanguage>(defaultSourceLanguage);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ImportSuccess | null>(null);

  const allSelected = result ? selected.size === result.episodes.length : false;

  const handleParse = async () => {
    if (!url.trim() || parsing) return;
    setParsing(true);
    setError(null);
    setResult(null);
    setSelected(new Set());
    try {
      const data = await apiRequest<ImportLinkResult>("/api/import-link", {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      });
      setResult(data);
      // 默认全选，用户再按需取消
      setSelected(new Set(data.episodes.map((ep) => ep.enclosureUrl)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析链接失败，请重试。");
    } finally {
      setParsing(false);
    }
  };

  const toggleEpisode = (enclosureUrl: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(enclosureUrl)) {
        next.delete(enclosureUrl);
      } else {
        next.add(enclosureUrl);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (!result) return;
    setSelected(allSelected ? new Set() : new Set(result.episodes.map((ep) => ep.enclosureUrl)));
  };

  const handleImport = async () => {
    if (!result || selected.size === 0 || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const episodes = result.episodes
        .filter((ep) => selected.has(ep.enclosureUrl))
        .map((ep) => ({
          title: ep.title,
          enclosureUrl: ep.enclosureUrl,
          durationLabel: ep.durationLabel,
        }));
      const data = await apiRequest<ImportSuccess>("/api/import-link/import", {
        method: "POST",
        body: JSON.stringify({ episodes, sourceLanguage }),
      });
      setSuccess(data);
      onImported?.();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "导入失败，请重试。");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-3xl bg-white shadow-2xl ring-1 ring-black/5 overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2">
            <Link2 size={18} className="text-blue-600" strokeWidth={2.5} />
            <h2 className="text-base font-bold text-gray-900">导入链接</h2>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-black text-blue-600">
              Apple Podcasts
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-gray-400 transition-all hover:bg-gray-50 hover:text-gray-600"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          {!result ? (
            <>
              <p className="text-[13px] font-medium leading-relaxed text-gray-500">
                粘贴 Apple Podcasts 的播客主页链接，我们会解析出剧集，勾选后直接导入并开始转写。
              </p>
              <p className="text-[11px] font-bold text-gray-400">
                当前仅支持 Apple Podcasts（podcasts.apple.com），小宇宙版本后续开放。
              </p>

              <div className="space-y-2">
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleParse();
                    }
                  }}
                  placeholder="https://podcasts.apple.com/.../id123456789"
                  className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-900 outline-none transition-all focus:border-blue-400 focus:bg-white"
                  autoFocus
                />

                {error && (
                  <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-[12px] font-bold text-red-500">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </div>

              <button
                onClick={() => void handleParse()}
                disabled={parsing || !url.trim()}
                className="w-full px-6 py-3 bg-blue-600 text-white rounded-2xl font-bold text-sm transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 hover:bg-blue-700"
              >
                {parsing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" strokeWidth={3} />
                    解析中...
                  </>
                ) : (
                  "解析链接"
                )}
              </button>
            </>
          ) : success ? (
            <div className="space-y-4 text-center py-4">
              <div className="mx-auto h-12 w-12 rounded-full bg-green-50 flex items-center justify-center">
                <Check size={24} className="text-green-500" strokeWidth={3} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-900">已加入转写队列</h3>
                <p className="text-[12px] font-medium text-gray-500 mt-1">
                  新增 {success.created} 集
                  {success.skipped > 0 ? `，跳过已导入的 ${success.skipped} 集` : ""}
                  。本机 worker 会自动下载音频并开始转写。
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-full px-6 py-3 bg-blue-600 text-white rounded-2xl font-bold text-sm transition-all active:scale-[0.98] hover:bg-blue-700"
              >
                返回首页查看
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {result.artworkUrl ? (
                  // 封面是外链图，加载失败不影响功能，用背景兜底
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={result.artworkUrl}
                    alt=""
                    className="h-14 w-14 rounded-xl object-cover ring-1 ring-gray-100"
                  />
                ) : (
                  <div className="h-14 w-14 rounded-xl bg-blue-50 flex items-center justify-center">
                    <Link2 size={20} className="text-blue-500" />
                  </div>
                )}
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-gray-900 line-clamp-2">{result.title}</h3>
                  <p className="text-[11px] font-bold text-gray-400">
                    {result.episodeCount} 集可导入
                  </p>
                </div>
              </div>

              {/* 语种 + 全选 */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center rounded-full border border-gray-100 bg-gray-50 p-1">
                  {LANGUAGE_OPTIONS.map((option) => {
                    const isActive = sourceLanguage === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSourceLanguage(option.value)}
                        className={
                          "rounded-full px-3 py-1.5 text-[11px] font-black transition-all " +
                          (isActive
                            ? "bg-white text-blue-600 shadow-sm"
                            : "text-gray-400 hover:text-gray-700")
                        }
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={toggleAll}
                  className="flex items-center gap-1.5 text-[12px] font-bold text-blue-600 hover:text-blue-700"
                >
                  <ListChecks size={15} />
                  {allSelected ? "取消全选" : "全选"}
                </button>
              </div>

              {importError && (
                <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-[12px] font-bold text-red-500">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>{importError}</span>
                </div>
              )}

              {/* 剧集列表 */}
              <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {result.episodes.map((ep) => {
                  const checked = selected.has(ep.enclosureUrl);
                  return (
                    <button
                      key={ep.enclosureUrl}
                      type="button"
                      onClick={() => toggleEpisode(ep.enclosureUrl)}
                      className={
                        "w-full flex items-start gap-3 rounded-2xl border px-3 py-2.5 text-left transition-all " +
                        (checked
                          ? "border-blue-200 bg-blue-50"
                          : "border-gray-100 bg-white hover:bg-gray-50")
                      }
                    >
                      <span
                        className={
                          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-all " +
                          (checked
                            ? "border-blue-500 bg-blue-500 text-white"
                            : "border-gray-300 bg-white text-transparent")
                        }
                      >
                        <Check size={13} strokeWidth={3} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-bold text-gray-900 line-clamp-2">
                          {ep.title}
                        </span>
                        {ep.durationLabel && (
                          <span className="mt-0.5 block text-[10px] font-bold text-gray-400">
                            {ep.durationLabel}
                            {ep.pubDate ? ` · ${ep.pubDate.slice(0, 10)}` : ""}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setResult(null);
                    setUrl("");
                    setSelected(new Set());
                  }}
                  className="px-4 py-3 rounded-2xl font-bold text-sm text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
                >
                  <ArrowLeft size={15} />
                  重选链接
                </button>
                <button
                  onClick={() => void handleImport()}
                  disabled={importing || selected.size === 0}
                  className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-2xl font-bold text-sm transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 hover:bg-blue-700"
                >
                  {importing ? (
                    <>
                      <Loader2 size={16} className="animate-spin" strokeWidth={3} />
                      导入中...
                    </>
                  ) : (
                    `导入选中 ${selected.size} 集`
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
