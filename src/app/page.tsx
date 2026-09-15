"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileSearch, RefreshCw, Upload } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { FavoritesView } from "@/components/FavoritesView";
import { loadPodcastHistory, upsertPodcastHistoryItem } from "@/lib/podcast-history";
import { loadPodcastFavorites } from "@/lib/podcast-favorites";
import {
  DEFAULT_SOURCE_LANGUAGE,
  loadSourceLanguage,
  saveSourceLanguage,
} from "@/lib/podcast-settings";
import { apiUrl } from "@/lib/api";
import type { FavoriteSentence, SourceLanguage, StoredPodcast } from "@/types/podcast";

type JobResponse = {
  job_id: string;
  status: string;
  filename: string;
  source_language?: SourceLanguage;
};

type RSSItem = {
  title: string;
  audio_url: string;
  published_at?: string;
  description?: string;
};

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<"import" | "favorites">("import");
  const [historyItems, setHistoryItems] = useState<StoredPodcast[]>([]);
  const [favoriteItems, setFavoriteItems] = useState<FavoriteSentence[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // 初始值用常量而非直接读 localStorage，避免服务端渲染与客户端不一致（hydration mismatch）
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>(DEFAULT_SOURCE_LANGUAGE);
  const [isProcessing, setIsProcessing] = useState(false);
  const [rssInput, setRssInput] = useState("");
  const [isSubmittingRss, setIsSubmittingRss] = useState(false);
  const [rssItems, setRssItems] = useState<RSSItem[]>([]);
  const [selectedRssAudioUrl, setSelectedRssAudioUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHistoryItems(loadPodcastHistory());
    setFavoriteItems(loadPodcastFavorites());
    setSourceLanguage(loadSourceLanguage());
  }, []);

  // 语种选择持久化：按选中语言记住，下次打开沿用（首次进入仍是 DEFAULT_SOURCE_LANGUAGE）
  const handleSourceLanguageChange = (value: SourceLanguage) => {
    setSourceLanguage(value);
    saveSourceLanguage(value);
  };

  useEffect(() => {
    const nextView = searchParams.get("view");
    if (nextView === "favorites") {
      setFavoriteItems(loadPodcastFavorites());
      setView("favorites");
      return;
    }

    setView("import");
  }, [searchParams]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setView("import");
      void handleStartProcessing(file);
    }
  };

  const handleStartProcessing = async (fileToProcess?: File) => {
    const file = fileToProcess || selectedFile;
    if (!file) return;

    console.log("[upload] start", {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
    });
    setIsProcessing(true);
    setErrorMessage(null);
    setRssItems([]);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("source_language", sourceLanguage);

    try {
      console.log("[upload] request starting", "POST /process-podcast");
      const response = await fetch(apiUrl("/process-podcast"), {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Processing failed");
      }

      const data: JobResponse = await response.json();
      console.log("[upload] request finished", data);
      const now = new Date().toLocaleString();
      const draftRecord: StoredPodcast = {
        id: data.job_id,
        title: data.filename,
        date: now,
        duration: "0:00",
        status: data.status,
        stage: "queued",
        progress: 0,
        translatedCount: 0,
        totalSegments: 0,
        sourceLanguage: data.source_language || sourceLanguage,
        errorMessage: null,
        segments: [],
      };

      upsertPodcastHistoryItem(draftRecord);
      setHistoryItems(loadPodcastHistory());
      setSelectedFile(null);
      console.log("[upload] navigating", `/podcast/${data.job_id}`);
      router.push(`/podcast/${data.job_id}`);
    } catch (error) {
      console.error("Error:", error);
      setIsProcessing(false);
      setErrorMessage("处理失败，请检查后端服务是否开启�?");
      alert("处理失败，请检查后端服务是否开启�?");
    }
  };

  const handleSubmitRss = async () => {
    const value = rssInput.trim();
    console.log("[rss] submitting", {
      rawInput: rssInput,
      trimmedInput: value,
    });
    if (!value) {
      console.log("[rss] blocked: empty input");
      setErrorMessage("请先输入一�? RSS 链接�?");
      return;
    }

    try {
      new URL(value);
    } catch {
      console.log("[rss] blocked: invalid url", value);
      setErrorMessage("RSS 链接格式不正确，请检查后重试�?");
      return;
    }

    console.log("[rss] parse start", value);
    setIsSubmittingRss(true);
    setErrorMessage(null);
    setSelectedFile(null);

    try {
      console.log("[rss] request starting", "POST /parse-rss");
      const response = await fetch(apiUrl("/parse-rss"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rss_url: value }),
      });

      const data = await response.json();
      console.log("[rss] request finished", {
        status: response.status,
        data,
      });
      if (!response.ok) {
        throw new Error(data.detail || "RSS 解析失败");
      }

      setRssItems(data.items || []);
      console.log("[rss] items loaded", {
        count: (data.items || []).length,
        firstItem: (data.items || [])[0] || null,
      });
      if ((data.items || []).length === 0) {
        setErrorMessage("这个 RSS 没有解析出可用的音频条目�?");
      }
    } catch (error) {
      console.error("[rss] parse error", error);
      setRssItems([]);
      setErrorMessage(error instanceof Error ? error.message : "RSS 解析失败");
    } finally {
      console.log("[rss] parse cleanup");
      setIsSubmittingRss(false);
    }
  };

  const handleProcessRssItem = async (item: RSSItem) => {
    console.log("[rss] process item start", item);
    setSelectedRssAudioUrl(item.audio_url);
    setIsProcessing(true);
    setErrorMessage(null);

    try {
      console.log("[rss] request starting", "POST /process-rss-item");
      const response = await fetch(apiUrl("/process-rss-item"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rss_url: rssInput.trim(),
          audio_url: item.audio_url,
          title: item.title,
          published_at: item.published_at || null,
          source_language: sourceLanguage,
        }),
      });

      const data: JobResponse = await response.json();
      console.log("[rss] process item finished", {
        status: response.status,
        data,
      });
      if (!response.ok) {
        throw new Error((data as unknown as { detail?: string }).detail || "RSS 音频处理失败");
      }

      const draftRecord: StoredPodcast = {
        id: data.job_id,
        title: item.title,
        date: item.published_at || new Date().toLocaleString(),
        duration: "0:00",
        status: data.status,
        stage: "queued",
        progress: 0,
        translatedCount: 0,
        totalSegments: 0,
        sourceLanguage: data.source_language || sourceLanguage,
        errorMessage: null,
        segments: [],
      };

      upsertPodcastHistoryItem(draftRecord);
      setHistoryItems(loadPodcastHistory());
      console.log("[rss] navigating", `/podcast/${data.job_id}`);
      router.push(`/podcast/${data.job_id}`);
    } catch (error) {
      console.error("[rss] process item error", error);
      setIsProcessing(false);
      setSelectedRssAudioUrl(null);
      setErrorMessage(error instanceof Error ? error.message : "RSS 音频处理失败");
    }
  };

  const handleSelectNowPlaying = () => {
    router.push("/");
    setView("import");
  };

  const handleSelectHistory = (podcast: StoredPodcast) => {
    router.push(`/podcast/${podcast.id}`);
  };

  const handleSelectFavorites = () => {
    setFavoriteItems(loadPodcastFavorites());
    router.push("/?view=favorites");
  };

  const handleNavigateToPodcast = (podcastId: string, start: string) => {
    router.push(`/podcast/${podcastId}?t=${start}`);
  };

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden font-sans">
      <Sidebar
        activeTab={view === "favorites" ? "favorites" : "now-playing"}
        historyItems={historyItems}
        onSelectNowPlaying={handleSelectNowPlaying}
        onSelectHistory={handleSelectHistory}
        onSelectFavorites={handleSelectFavorites}
      />

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        className="hidden"
        accept="audio/*"
      />

      <main className="flex-1 flex flex-col min-w-0 bg-white relative z-0 shadow-2xl">
        {view !== "favorites" && (
          <>
            <Header
              mode="import"
              title=""
              rssValue={rssInput}
              onRssChange={setRssInput}
              onSubmitRss={() => void handleSubmitRss()}
              onUploadClick={handleUploadClick}
              isSubmittingRss={isSubmittingRss}
              isProcessing={isProcessing}
              sourceLanguage={sourceLanguage}
              onSourceLanguageChange={handleSourceLanguageChange}
            />
          </>
        )}

        {view === "favorites" ? (
          <FavoritesView 
            items={favoriteItems} 
            onNavigateToPodcast={handleNavigateToPodcast}
            onFavoritesChange={() => setFavoriteItems(loadPodcastFavorites())}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white overflow-hidden">
            <div className="max-w-md w-full text-center space-y-12 animate-in fade-in duration-700">
              <div className="relative inline-block">
                <div
                  onClick={handleUploadClick}
                  className="w-24 h-24 bg-blue-600 border-2 border-blue-500 rounded-[32px] flex items-center justify-center shadow-2xl shadow-blue-600/20 transition-transform hover:scale-105 duration-300 cursor-pointer"
                >
                  <Upload className="text-white w-10 h-10" strokeWidth={2.5} />
                </div>
              </div>

              <div className="space-y-4">
                <h2 className="text-2xl font-black text-gray-900 tracking-tight">
                  {selectedFile
                    ? `已选择: ${selectedFile.name}`
                    : rssItems.length > 0
                      ? `已找�? ${rssItems.length} �? RSS 音频`
                      : "Upload a podcast to start"}
                </h2>
                <p className="text-[13px] font-bold text-gray-400 leading-relaxed max-w-sm mx-auto">
                  {selectedFile
                    ? "上传成功后会自动新增一�? History，并跳转到对应播客页靀�?"
                    : rssItems.length > 0
                      ? "选择一个音频条目后，会自动下载并进入和本地上传相同的处理流程�?"
                      : "上传本地 MP3 后，我们会立刻在左侧 History 新增记录，并进入该音频的专属页面�?"}
                </p>
                {errorMessage && (
                  <p className="text-sm font-bold text-red-500">{errorMessage}</p>
                )}
              </div>

              {rssItems.length > 0 ? (
                <div className="pt-2 w-full text-left space-y-3 max-h-[420px] overflow-y-auto pr-2">
                  {rssItems.map((item, index) => {
                    const isCurrentItem = selectedRssAudioUrl === item.audio_url && isProcessing;
                    return (
                      <button
                        key={`${item.audio_url}-${index}`}
                        onClick={() => void handleProcessRssItem(item)}
                        disabled={isProcessing}
                        className="w-full rounded-2xl border border-gray-100 bg-white px-5 py-4 text-left shadow-sm hover:border-blue-200 hover:bg-blue-50/40 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <h3 className="text-sm font-black text-gray-900 line-clamp-2">
                              {item.title}
                            </h3>
                            <p className="mt-2 text-[11px] font-bold text-gray-400">
                              {item.published_at || "未提供发布时�?"}
                            </p>
                            {item.description && (
                              <p className="mt-2 text-xs font-medium text-gray-500 line-clamp-2">
                                {item.description}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 rounded-full bg-blue-600 px-4 py-2 text-[11px] font-black text-white">
                            {isCurrentItem ? "处理�?..." : "选择"}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="pt-4 flex flex-col gap-4">
                  {selectedFile ? (
                  <button
                    onClick={() => void handleStartProcessing()}
                    disabled={isProcessing}
                    className="w-full px-8 py-4 bg-blue-600 text-white rounded-2xl font-bold text-sm hover:bg-blue-700 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                  >
                    {isProcessing ? (
                      <>
                        <RefreshCw className="animate-spin" size={18} />
                        创建任务�?...
                      </>
                    ) : (
                      "开始处�?"
                    )}
                  </button>
                  ) : (
                  <button
                    onClick={handleUploadClick}
                    className="w-full px-8 py-4 bg-gray-50 text-gray-500 rounded-2xl font-bold text-sm hover:bg-gray-100 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                  >
                    <FileSearch size={16} />
                    选择一个音频开�?
                  </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}
