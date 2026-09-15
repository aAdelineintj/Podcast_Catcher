"use client";

import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { FileSearch, RefreshCw } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { Transcription } from "@/components/Transcription";
import { BottomPlayer, type BottomPlayerRef, type SentenceLoopCount } from "@/components/BottomPlayer";
import { loadPodcastHistory, getPodcastHistoryItem, updatePodcastHistoryTitle, upsertPodcastHistoryItem } from "@/lib/podcast-history";
import { buildFavoriteId, hasPodcastFavorite, updatePodcastFavoritePodcastTitle, upsertPodcastFavorite } from "@/lib/podcast-favorites";
import { apiUrl } from "@/lib/api";
import type { FavoriteSentence, SourceLanguage, StoredPodcast, TranscriptSegment } from "@/types/podcast";

type JobStatusResponse = {
  job_id: string;
  status: string;
  stage: string;
  filename: string;
  source_language?: SourceLanguage;
  transcription_language?: string | null;
  media_url: string | null;
  progress: number;
  translated_count: number;
  total_segments: number;
  error: string | null;
  segments: TranscriptSegment[];
};

const stageTextMap: Record<string, string> = {
  idle: "等待上传",
  uploading: "上传中",
  uploaded: "上传完成",
  queued: "任务排队中",
  transcribing: "正在转写原文",
  transcribed: "转写完成，准备翻译",
  translating: "正在逐句翻译",
  completed: "处理完成",
  failed: "处理失败",
};

function PodcastDetailContent() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const podcastId = params.id;
  const startTimeFromUrl = searchParams.get("t");
  const [historyItems, setHistoryItems] = useState<StoredPodcast[]>([]);
  const [podcast, setPodcast] = useState<StoredPodcast | null>(null);
  const [rssInput, setRssInput] = useState("");
  const [isSubmittingRss, setIsSubmittingRss] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 任务状态相关的错误单独存一份：它和播放器报错、RSS 报错的生命周期不同，
  // 混用一个 state 会让轮询成功时把播放器报错一起清掉。
  const [statusError, setStatusError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailureRef = useRef(0);
  const podcastRef = useRef<StoredPodcast | null>(null);
  const playerRef = useRef<BottomPlayerRef>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentDuration, setCurrentDuration] = useState(0);
  const [sentenceLoopEnabled, setSentenceLoopEnabled] = useState(false);
  const [loopSentenceIndex, setLoopSentenceIndex] = useState<number | null>(null);
  const [sentenceLoopCount, setSentenceLoopCount] = useState<SentenceLoopCount>("infinite");
  const [favoriteRefreshKey, setFavoriteRefreshKey] = useState(0);
  const loopCompletedCountRef = useRef(1);
  const loopBoundaryHandledRef = useRef(false);

  const parseTimeToSeconds = (timeStr: string): number => {
    const parts = timeStr.split(":").map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  };

  const activeIndex = useMemo(() => {
    if (!podcast || podcast.segments.length === 0) return -1;
    let index = -1;
    for (let i = 0; i < podcast.segments.length; i++) {
      const segmentStart = parseTimeToSeconds(podcast.segments[i].start);
      if (currentTime >= segmentStart) {
        index = i;
      } else {
        break;
      }
    }
    return index;
  }, [podcast, currentTime]);

  const linesWithActive = useMemo(() => {
    return (podcast?.segments ?? []).map((line, index) => ({
      ...line,
      active: index === activeIndex,
    }));
  }, [podcast, activeIndex]);

  const currentOriginalText = useMemo(() => {
    if (!podcast || podcast.segments.length === 0) {
      return "";
    }
    if (activeIndex >= 0 && podcast.segments[activeIndex]) {
      return podcast.segments[activeIndex].original;
    }
    return podcast.segments[0]?.original || "";
  }, [podcast, activeIndex]);

  const resolvedAudioSrc = useMemo(() => {
    if (!podcastId) {
      return null;
    }
    return podcast?.mediaUrl || apiUrl(`/jobs/${podcastId}/media`);
  }, [podcast?.mediaUrl, podcastId]);

  const currentFavoritePayload = useMemo<FavoriteSentence | null>(() => {
    if (!podcast || podcast.segments.length === 0) {
      return null;
    }

    const targetSegment =
      activeIndex >= 0 && podcast.segments[activeIndex]
        ? podcast.segments[activeIndex]
        : podcast.segments[0];
    const targetIndex =
      activeIndex >= 0 && podcast.segments[activeIndex]
        ? activeIndex
        : 0;

    if (!targetSegment) {
      return null;
    }

    const nextSegment = podcast.segments[targetIndex + 1];

    return {
      id: buildFavoriteId(podcast.id, targetSegment.start),
      podcastId: podcast.id,
      podcastTitle: podcast.title,
      mediaUrl: resolvedAudioSrc,
      start: targetSegment.start,
      end: nextSegment?.start ?? podcast.duration,
      original: targetSegment.original,
      translation: targetSegment.translation,
      createdAt: new Date().toISOString(),
    };
  }, [activeIndex, podcast, resolvedAudioSrc]);

  const isCurrentFavorited = useMemo(() => {
    if (!currentFavoritePayload) {
      return false;
    }
    return hasPodcastFavorite(currentFavoritePayload.id);
  }, [currentFavoritePayload, favoriteRefreshKey]);

  const loopRange = useMemo(() => {
    if (!podcast || !sentenceLoopEnabled || loopSentenceIndex === null) {
      return null;
    }

    const segment = podcast.segments[loopSentenceIndex];
    if (!segment) {
      return null;
    }

    const start = parseTimeToSeconds(segment.start);
    const nextSegment = podcast.segments[loopSentenceIndex + 1];
    const nextStart = nextSegment ? parseTimeToSeconds(nextSegment.start) : currentDuration;
    const fallbackEnd = Math.max(start + 1, currentDuration || start + 5);
    const end = nextStart > start ? nextStart : fallbackEnd;

    return { start, end };
  }, [currentDuration, loopSentenceIndex, podcast, sentenceLoopEnabled]);

  const resetLoopProgress = () => {
    loopCompletedCountRef.current = 1;
    loopBoundaryHandledRef.current = false;
  };

  // Handle initial seek from URL
  useEffect(() => {
    if (podcast && startTimeFromUrl && playerRef.current) {
      // Small delay to ensure player is ready
      const timer = setTimeout(() => {
        playerRef.current?.seek(startTimeFromUrl);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [podcast, startTimeFromUrl]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const timer = window.setTimeout(() => {
      setToastMessage(null);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    if (!podcast || podcast.segments.length === 0) {
      setSentenceLoopEnabled(false);
      setLoopSentenceIndex(null);
      resetLoopProgress();
      return;
    }

    setLoopSentenceIndex((currentIndex) => {
      if (currentIndex === null) {
        return currentIndex;
      }
      return Math.min(currentIndex, podcast.segments.length - 1);
    });
  }, [podcast]);

  useEffect(() => {
    podcastRef.current = podcast;
  }, [podcast]);

  useEffect(() => {
    const history = loadPodcastHistory();
    setHistoryItems(history);
    const target = history.find((item) => item.id === podcastId) ?? null;
    setPodcast(target);
  }, [podcastId]);

  useEffect(() => {
    if (!podcastId) {
      return;
    }

    pollFailureRef.current = 0;

    const stopPolling = () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const isSettled = () => {
      const current = podcastRef.current;
      return !!current && (current.status === "success" || current.status === "failed");
    };

    const applyJobUpdate = (data: JobStatusResponse) => {
      const existing = getPodcastHistoryItem(data.job_id);
      const nextPodcast: StoredPodcast = {
        id: data.job_id,
        // 已有标题优先：轮询不能把用户改过的标题、或历史记录里的标题冲掉
        title: existing?.title || data.filename,
        date: existing?.date || new Date().toLocaleString(),
        duration: data.segments[data.segments.length - 1]?.start || "0:00",
        mediaUrl: data.media_url,
        status: data.status,
        stage: data.stage,
        progress: data.progress,
        translatedCount: data.translated_count,
        totalSegments: data.total_segments,
        sourceLanguage: data.source_language,
        transcriptionLanguage: data.transcription_language,
        errorMessage: data.error,
        segments: data.segments,
      };

      upsertPodcastHistoryItem(nextPodcast);
      podcastRef.current = nextPodcast;
      setPodcast(nextPodcast);
      setHistoryItems(loadPodcastHistory());

      if (data.status === "success" || data.status === "failed") {
        stopPolling();
      }
    };

    const fetchJobStatus = async () => {
      let response: Response;
      try {
        response = await fetch(apiUrl(`/jobs/${podcastId}`));
      } catch {
        throw new Error("无法连接到后端服务，请确认后端是否已启动。");
      }

      if (response.status === 404) {
        // 后端重启导致内存态任务丢失时就是这个结果，重试没有意义
        throw new Error("任务记录已丢失（后端可能重启过），结果未生成，请重新上传该音频。");
      }
      if (!response.ok) {
        throw new Error(`读取任务状态失败（HTTP ${response.status}）。`);
      }

      const data: JobStatusResponse = await response.json();
      applyJobUpdate(data);
    };

    const handlePollFailure = (error: unknown) => {
      const message = error instanceof Error ? error.message : "读取任务状态失败。";
      pollFailureRef.current += 1;
      // 关键：必须把失败变成用户可见的状态，否则页面会静默停在「处理中」
      setStatusError(
        pollFailureRef.current >= 3
          ? `${message} 已停止自动刷新。`
          : `${message}（第 ${pollFailureRef.current} 次重试…）`,
      );

      const fatal =
        message.includes("任务记录已丢失") || message.includes("无法连接到后端服务");
      if (fatal || pollFailureRef.current >= 3) {
        stopPolling();
      }
    };

    const pollOnce = () =>
      fetchJobStatus()
        .then(() => {
          pollFailureRef.current = 0;
          setStatusError(null);
        })
        .catch(handlePollFailure);

    if (!isSettled()) {
      void pollOnce();
      pollTimerRef.current = setInterval(() => {
        if (isSettled()) {
          stopPolling();
          return;
        }
        void pollOnce();
      }, 1500);
    }

    return () => {
      stopPolling();
    };
  }, [podcastId]);

  const currentStageText = useMemo(() => {
    if (!podcast) {
      return "载入中";
    }
    return stageTextMap[podcast.stage] || podcast.stage;
  }, [podcast]);

  const lines = podcast?.segments ?? [];

  const seekToSegment = (index: number) => {
    if (!podcast || !playerRef.current) {
      return;
    }
    const segment = podcast.segments[index];
    if (!segment) {
      return;
    }
    if (sentenceLoopEnabled) {
      setLoopSentenceIndex(index);
      resetLoopProgress();
    }
    playerRef.current.seek(segment.start);
  };

  const handlePreviousSentence = () => {
    if (!podcast || podcast.segments.length === 0) {
      return;
    }

    if (activeIndex <= 0) {
      seekToSegment(0);
      return;
    }

    seekToSegment(activeIndex - 1);
  };

  const handleNextSentence = () => {
    if (!podcast || podcast.segments.length === 0) {
      return;
    }

    if (activeIndex < 0) {
      seekToSegment(0);
      return;
    }

    const nextIndex = Math.min(activeIndex + 1, podcast.segments.length - 1);
    seekToSegment(nextIndex);
  };

  const handleToggleSentenceLoop = (enabled: boolean) => {
    if (!enabled) {
      setSentenceLoopEnabled(false);
      setLoopSentenceIndex(null);
      resetLoopProgress();
      setToastMessage("已关闭逐句循环。");
      return;
    }

    if (!podcast || podcast.segments.length === 0) {
      setToastMessage("当前还没有可循环的字幕。");
      return;
    }

    const targetIndex = activeIndex >= 0 ? activeIndex : 0;
    setSentenceLoopEnabled(true);
    setLoopSentenceIndex(targetIndex);
    resetLoopProgress();
    playerRef.current?.seek(podcast.segments[targetIndex].start);
    setToastMessage(
      sentenceLoopCount === "infinite"
        ? "已开启逐句循环：一直。"
        : `已开启逐句循环：每句 ${sentenceLoopCount} 次。`
    );
  };

  const handleSentenceLoopCountChange = (count: SentenceLoopCount) => {
    setSentenceLoopCount(count);
    resetLoopProgress();
    setToastMessage(count === "infinite" ? "逐句循环次数已设为一直。" : `逐句循环次数已设为每句 ${count} 次。`);
  };

  const handleFavoriteCurrent = () => {
    if (!currentFavoritePayload) {
      setToastMessage("当前没有可收藏的句子。");
      return;
    }

    upsertPodcastFavorite(currentFavoritePayload);
    setFavoriteRefreshKey((value) => value + 1);
    setToastMessage("已收藏当前句子。");
  };

  const handlePlayerTimeUpdate = (time: number) => {
    setCurrentTime(time);

    if (!sentenceLoopEnabled || !loopRange || !playerRef.current) {
      return;
    }

    if (time < loopRange.end - 0.2) {
      loopBoundaryHandledRef.current = false;
      return;
    }

    if (loopBoundaryHandledRef.current) {
      return;
    }

    loopBoundaryHandledRef.current = true;

    const shouldRepeatCurrentSentence =
      sentenceLoopCount === "infinite" || loopCompletedCountRef.current < sentenceLoopCount;

    if (shouldRepeatCurrentSentence) {
      loopCompletedCountRef.current += 1;
      playerRef.current.seek(loopRange.start);
      return;
    }

    if (!podcast || loopSentenceIndex === null) {
      setSentenceLoopEnabled(false);
      setLoopSentenceIndex(null);
      resetLoopProgress();
      return;
    }

    const nextIndex = loopSentenceIndex + 1;
    if (nextIndex < podcast.segments.length) {
      setLoopSentenceIndex(nextIndex);
      resetLoopProgress();
      playerRef.current.seek(podcast.segments[nextIndex].start);
      return;
    }

    setSentenceLoopEnabled(false);
    setLoopSentenceIndex(null);
    resetLoopProgress();
    setToastMessage("逐句循环已完成。");
  };

  useEffect(() => {
    const isEditableElement = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element) {
        return false;
      }

      const tagName = element.tagName;
      return (
        element.isContentEditable ||
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT"
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        playerRef.current?.togglePlayPause();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handlePreviousSentence();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        handleNextSentence();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        handleFavoriteCurrent();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleNextSentence, handlePreviousSentence, currentFavoritePayload, favoriteRefreshKey]);

  const handleSelectNowPlaying = () => {
    router.push("/");
  };

  const handleSelectHistory = (item: StoredPodcast) => {
    router.push(`/podcast/${item.id}`);
  };

  const handleSelectFavorites = () => {
    router.push("/?view=favorites");
  };

  const handleSavePodcastTitle = (title: string) => {
    if (!podcast) {
      return;
    }

    const nextPodcast: StoredPodcast = {
      ...podcast,
      title,
    };

    updatePodcastHistoryTitle(podcast.id, title);
    updatePodcastFavoritePodcastTitle(podcast.id, title);
    setPodcast(nextPodcast);
    setHistoryItems(loadPodcastHistory());
    setFavoriteRefreshKey((value) => value + 1);
    setToastMessage("已更新当前播客标题。");
  };

  const handleSeekFromTranscript = (time: string) => {
    if (sentenceLoopEnabled && podcast) {
      const targetIndex = podcast.segments.findIndex((segment) => segment.start === time);
      if (targetIndex >= 0) {
        setLoopSentenceIndex(targetIndex);
        resetLoopProgress();
      }
    }
    playerRef.current?.seek(time);
  };

  const handleSubmitRss = async () => {
    const value = rssInput.trim();
    if (!value) {
      setErrorMessage("请先输入一个 RSS 链接。");
      return;
    }

    try {
      new URL(value);
    } catch {
      setErrorMessage("RSS 链接格式不正确，请检查后重试。");
      return;
    }

    setIsSubmittingRss(true);
    setErrorMessage("RSS 导入功能下一步接后端解析，当前版本先支持本地 MP3 上传。");
    setTimeout(() => {
      setIsSubmittingRss(false);
    }, 600);
  };

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden font-sans">
      <Sidebar
        activeTab="now-playing"
        selectedPodcastId={podcastId}
        historyItems={historyItems}
        onSelectNowPlaying={handleSelectNowPlaying}
        onSelectHistory={handleSelectHistory}
        onSelectFavorites={handleSelectFavorites}
      />

      <main className="flex-1 flex flex-col min-w-0 bg-white relative z-0 shadow-2xl">
        {toastMessage && (
          <div className="fixed bottom-30 left-[55%] z-[120] -translate-x-1/2 rounded-full border border-white/20 bg-gray-900/30 px-4 py-1.5 text-[13px] font-semibold tracking-[0.01em] text-white shadow-lg shadow-black/10 backdrop-blur-lg">
            {toastMessage}
          </div>
        )}

        <Header
          mode="player"
          title={podcast?.title || "Podcast"}
          subtitle={`${currentStageText}${podcast && podcast.totalSegments > 0 ? ` · ${podcast.translatedCount}/${podcast.totalSegments}` : ""}`}
          rssValue={rssInput}
          onRssChange={setRssInput}
          onSubmitRss={() => void handleSubmitRss()}
          isSubmittingRss={isSubmittingRss}
          editableTitle
          onSaveTitle={handleSavePodcastTitle}
        />

        {!podcast ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white text-center">
            <div className="space-y-4">
              <div className="w-20 h-20 bg-gray-50 rounded-[24px] flex items-center justify-center mx-auto border border-gray-100 shadow-inner">
                <FileSearch className="text-gray-300 w-10 h-10" />
              </div>
              <h3 className="text-xl font-black text-gray-900">没有找到这条播客记录</h3>
              <p className="text-sm font-bold text-gray-400">可以返回首页重新上传一个音频。</p>
            </div>
          </div>
        ) : (
          <>
            {(podcast.errorMessage || statusError) && (
              <div className="mx-10 mt-4 rounded-2xl border border-red-100 bg-red-50 px-5 py-4">
                <p className="text-sm font-bold text-red-600">
                  {podcast.errorMessage || statusError}
                </p>
                <p className="mt-1 text-xs font-bold text-red-400">
                  可返回首页重新上传该音频。
                </p>
              </div>
            )}
            {errorMessage && (
              <div className="px-10 pt-4 text-sm font-bold text-red-500">{errorMessage}</div>
            )}
            {lines.length === 0 && !podcast.errorMessage && !statusError ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white text-center">
                <div className="w-16 h-16 rounded-[20px] bg-blue-50 border border-blue-100 flex items-center justify-center">
                  <RefreshCw className="text-blue-400 w-7 h-7 animate-spin" />
                </div>
                <h3 className="mt-5 text-lg font-black text-gray-900">{currentStageText}</h3>
                <p className="mt-2 text-[13px] font-bold text-gray-400 max-w-sm">
                  {podcast.totalSegments > 0
                    ? `已处理 ${podcast.translatedCount}/${podcast.totalSegments} 句，字幕会逐步出现。`
                    : "正在等待后端返回第一批字幕，请保持本页打开。"}
                </p>
              </div>
            ) : (
              <Transcription
                lines={linesWithActive}
                onSeek={handleSeekFromTranscript}
              />
            )}
            <BottomPlayer
              ref={playerRef}
              audioSrc={resolvedAudioSrc}
              title={podcast.title}
              onTimeUpdate={handlePlayerTimeUpdate}
              onDurationChange={setCurrentDuration}
              onPlaybackError={setErrorMessage}
              copySourceText={currentOriginalText}
              onCopyResult={setToastMessage}
              onFavoriteCurrent={handleFavoriteCurrent}
              isCurrentFavorited={isCurrentFavorited}
              onPreviousSentence={handlePreviousSentence}
              onNextSentence={handleNextSentence}
              sentenceLoopEnabled={sentenceLoopEnabled}
              onToggleSentenceLoop={handleToggleSentenceLoop}
              sentenceLoopCount={sentenceLoopCount}
              onSentenceLoopCountChange={handleSentenceLoopCountChange}
            />
          </>
        )}
      </main>
    </div>
  );
}

export default function PodcastDetailPage() {
  return (
    <Suspense fallback={null}>
      <PodcastDetailContent />
    </Suspense>
  );
}
