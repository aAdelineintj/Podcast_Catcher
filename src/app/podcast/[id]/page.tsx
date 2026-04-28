"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { FileSearch } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { Transcription } from "@/components/Transcription";
import { BottomPlayer, type BottomPlayerRef } from "@/components/BottomPlayer";
import { loadPodcastHistory, getPodcastHistoryItem, upsertPodcastHistoryItem } from "@/lib/podcast-history";
import type { StoredPodcast, TranscriptSegment } from "@/types/podcast";

type JobStatusResponse = {
  job_id: string;
  status: string;
  stage: string;
  filename: string;
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

export default function PodcastDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const podcastId = params.id;
  const [historyItems, setHistoryItems] = useState<StoredPodcast[]>([]);
  const [podcast, setPodcast] = useState<StoredPodcast | null>(null);
  const [rssInput, setRssInput] = useState("");
  const [isSubmittingRss, setIsSubmittingRss] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playerRef = useRef<BottomPlayerRef>(null);
  const [currentTime, setCurrentTime] = useState(0);

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

    const stopPolling = () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const applyJobUpdate = (data: JobStatusResponse) => {
      const nextPodcast: StoredPodcast = {
        id: data.job_id,
        title: data.filename,
        date: getPodcastHistoryItem(data.job_id)?.date || new Date().toLocaleString(),
        duration: data.segments[data.segments.length - 1]?.start || "0:00",
        mediaUrl: data.media_url,
        status: data.status,
        stage: data.stage,
        progress: data.progress,
        translatedCount: data.translated_count,
        totalSegments: data.total_segments,
        errorMessage: data.error,
        segments: data.segments,
      };

      upsertPodcastHistoryItem(nextPodcast);
      setPodcast(nextPodcast);
      setHistoryItems(loadPodcastHistory());

      if (data.status === "success" || data.status === "failed") {
        stopPolling();
      }
    };

    const fetchJobStatus = async () => {
      const response = await fetch(`http://localhost:8000/jobs/${podcastId}`);
      if (!response.ok) {
        throw new Error("Failed to fetch job status");
      }
      const data: JobStatusResponse = await response.json();
      applyJobUpdate(data);
    };

    const shouldPoll = !podcast || (podcast.status !== "success" && podcast.status !== "failed");
    if (shouldPoll) {
      void fetchJobStatus().catch((error) => {
        console.error(error);
        setErrorMessage("获取任务进度失败，请检查后端服务。");
      });

      pollTimerRef.current = setInterval(() => {
        fetchJobStatus().catch((error) => {
          console.error(error);
          setErrorMessage("获取任务进度失败，请检查后端服务。");
          stopPolling();
        });
      }, 1500);
    }

    return () => {
      stopPolling();
    };
  }, [podcast, podcastId]);

  const currentStageText = useMemo(() => {
    if (!podcast) {
      return "载入中";
    }
    return stageTextMap[podcast.stage] || podcast.stage;
  }, [podcast]);

  const lines = podcast?.segments ?? [];

  const handleSelectNowPlaying = () => {
    router.push("/");
  };

  const handleSelectHistory = (item: StoredPodcast) => {
    router.push(`/podcast/${item.id}`);
  };

  const handleSelectFavorites = () => {
    router.push("/");
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
        <Header
          mode="player"
          title={podcast?.title || "Podcast"}
          subtitle={`${currentStageText}${podcast && podcast.totalSegments > 0 ? ` · ${podcast.translatedCount}/${podcast.totalSegments}` : ""}`}
          rssValue={rssInput}
          onRssChange={setRssInput}
          onSubmitRss={() => void handleSubmitRss()}
          isSubmittingRss={isSubmittingRss}
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
            {errorMessage && (
              <div className="px-10 pt-4 text-sm font-bold text-red-500">{errorMessage}</div>
            )}
            <Transcription 
              lines={linesWithActive} 
              onSeek={(time) => playerRef.current?.seek(time)}
            />
            <BottomPlayer
              ref={playerRef}
              audioSrc={podcast.mediaUrl}
              title={podcast.title}
              onTimeUpdate={setCurrentTime}
            />
          </>
        )}
      </main>
    </div>
  );
}
