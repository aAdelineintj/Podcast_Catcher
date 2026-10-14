"use client";

import React, { useEffect, useRef, useState } from "react";
import { Play, Pause, Copy, Heart, ChevronLeft, ChevronRight, Repeat } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface BottomPlayerRef {
  seek: (time: number | string) => void;
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
}

export const BottomPlayer = React.forwardRef<BottomPlayerRef, { 
  audioSrc?: string | null;
  title?: string;
  onTimeUpdate?: (time: number) => void;
  onDurationChange?: (duration: number) => void;
  onPlaybackError?: (message: string) => void;
  copySourceText?: string;
  onCopyResult?: (message: string) => void;
  onFavoriteCurrent?: () => void;
  isCurrentFavorited?: boolean;
  onPrevSentence?: () => void;
  onNextSentence?: () => void;
  hasPrevSentence?: boolean;
  hasNextSentence?: boolean;
  loopEnabled?: boolean;
  loopCount?: number;
  onToggleLoop?: () => void;
  onChangeLoopCount?: (count: number) => void;
  onLoopFinished?: () => void;
  sentenceBoundaries?: { start: number; end: number }[];
  activeIndex?: number;
}>(({
  audioSrc,
  title = "Podcast",
  onTimeUpdate,
  onDurationChange,
  onPlaybackError,
  copySourceText,
  onCopyResult,
  onFavoriteCurrent,
  isCurrentFavorited = false,
  onPrevSentence,
  onNextSentence,
  hasPrevSentence = false,
  hasNextSentence = false,
  loopEnabled = false,
  loopCount = 2,
  onToggleLoop,
  onChangeLoopCount,
  onLoopFinished,
  sentenceBoundaries,
  activeIndex = -1,
}, ref) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isSpeedMenuOpen, setIsSpeedMenuOpen] = useState(false);

  // 单句循环：loopAnchorRef = 当前要循环的句索引；loopPlaysRef = 已播放遍数。
  // 开循环或切到新句子时，把锚点钉到 activeIndex 并重置遍数。
  const loopAnchorRef = useRef<number>(-1);
  const loopPlaysRef = useRef<number>(0);

  // handleTimeUpdate 的 effect deps 没列入循环相关 props，会闭包到初次挂载的旧值。
  // 用 propsRef 把最新值每次 render 都写一次，handler 内部统一读 ref，避免 stale state。
  const loopPropsRef = useRef({
    loopEnabled,
    loopCount,
    sentenceBoundaries,
    hasNextSentence,
    onNextSentence,
    onLoopFinished,
  });
  useEffect(() => {
    loopPropsRef.current = {
      loopEnabled,
      loopCount,
      sentenceBoundaries,
      hasNextSentence,
      onNextSentence,
      onLoopFinished,
    };
  });
  useEffect(() => {
    loopAnchorRef.current = loopEnabled && activeIndex >= 0 ? activeIndex : -1;
    loopPlaysRef.current = 0;
  }, [activeIndex, loopEnabled]);

  const parseTimeToSeconds = (timeStr: string | number): number => {
    if (typeof timeStr === "number") return timeStr;
    const parts = timeStr.split(":").map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  };

  React.useImperativeHandle(ref, () => ({
    seek: (time: number | string) => {
      if (audioRef.current) {
        const seconds = parseTimeToSeconds(time);
        audioRef.current.currentTime = seconds;
        audioRef.current.play().catch(() => {});
      }
    },
    play: () => audioRef.current?.play(),
    pause: () => audioRef.current?.pause(),
    togglePlayPause: () => {
      if (!audioRef.current) {
        return;
      }
      if (audioRef.current.paused) {
        audioRef.current.play().catch(() => {});
      } else {
        audioRef.current.pause();
      }
    },
  }));

  // Sync state with audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playbackRate;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => {
      const time = audio.currentTime;
      setCurrentTime(time);
      onTimeUpdate?.(time);

      // 单句循环：播放到句尾时，回到句首重播（有限遍数播完则自动跳到下一句继续，
      // 末句则停在句尾并停掉循环）。所有循环相关值都从 propsRef 读，避开 stale closure。
      const lp = loopPropsRef.current;
      if (lp.loopEnabled && loopAnchorRef.current >= 0 && !audio.paused) {
        const boundary = lp.sentenceBoundaries?.[loopAnchorRef.current];
        if (boundary && time >= boundary.end - 0.06) {
          const completed = loopPlaysRef.current + 1;
          if (lp.loopCount === -1) {
            loopPlaysRef.current = completed;
            audio.currentTime = boundary.start;
          } else if (completed < lp.loopCount) {
            loopPlaysRef.current = completed;
            audio.currentTime = boundary.start;
          } else {
            // 这句循环已播够 N 遍：先把 anchor 临时置 -1，避免 useEffect 还没跑、
            // 旧句尾跨进下一句时又被触发；然后跳下一句让循环接力。
            loopPlaysRef.current = 0;
            loopAnchorRef.current = -1;
            if (lp.hasNextSentence && lp.onNextSentence) {
              lp.onNextSentence();
            } else {
              audio.pause();
              lp.onLoopFinished?.();
            }
          }
        }
      }
    };
    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
      onDurationChange?.(audio.duration);
    };
    const handleError = () => {
      onPlaybackError?.("音频加载失败，请检查音频地址或重启后端服务。");
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("error", handleError);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("error", handleError);
    };
  }, [audioSrc, onDurationChange, onPlaybackError, onTimeUpdate, playbackRate]);

  useEffect(() => {
    if (!isSpeedMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!speedMenuRef.current?.contains(event.target as Node)) {
        setIsSpeedMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isSpeedMenuOpen]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (!audioSrc) {
      onPlaybackError?.("还没有可播放的音频文件。");
      return;
    }
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch((err) => {
        console.error("Playback error:", err);
        onPlaybackError?.("播放失败，请确认浏览器允许播放音频。");
      });
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || duration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    audioRef.current.currentTime = percentage * duration;
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const speedOptions = [0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6];
  const loopCounts = [1, 2, 3, 4, 5, -1];

  const handleCopy = async () => {
    const text = copySourceText?.trim();
    if (!text) {
      onCopyResult?.("当前没有可复制的原文。");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      onCopyResult?.("已复制当前原文。");
    } catch (error) {
      console.error("Copy error:", error);
      onCopyResult?.("复制失败，请检查浏览器剪贴板权限。");
    }
  };

  const handlePlaybackRateChange = (rate: number) => {
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
    setPlaybackRate(rate);
    setIsSpeedMenuOpen(false);
  };

  return (
    <div className="border-t border-gray-100 bg-white px-10 py-6 shrink-0 relative z-10">
      <audio ref={audioRef} src={audioSrc || undefined} />
      
      {/* Progress Bar Top */}
      <div 
        className="absolute top-0 left-0 right-0 h-1 bg-gray-50 overflow-hidden cursor-pointer group"
        onClick={handleProgressClick}
      >
        <div 
          className="absolute inset-y-0 left-0 bg-blue-500 transition-all duration-300 group-hover:bg-blue-600" 
          style={{ width: `${progress}%` }} 
        />
        <div 
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-600 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ left: `${progress}%` }}
        />
      </div>

      <div className="flex items-center justify-between mt-2 relative">
        {/* Left: Actions */}
        <div className="flex items-center gap-6 text-gray-400">
          <div className="text-[10px] font-bold font-mono min-w-8">{formatTime(currentTime)}</div>
          <button onClick={handleCopy} className="hover:text-blue-500 transition-colors">
            <Copy size={18} />
          </button>
          <button
            onClick={onFavoriteCurrent}
            className={cn(
              "transition-colors",
              isCurrentFavorited ? "text-red-500 hover:text-red-600" : "hover:text-red-500"
            )}
          >
            <Heart size={18} className={cn(isCurrentFavorited && "fill-current")} />
          </button>
          <div className="flex items-center gap-1.5 pl-2 border-l border-gray-100">
            <button
              onClick={onToggleLoop}
              title={loopEnabled ? "单句循环：开" : "单句循环：关"}
              className={cn(
                "transition-colors",
                loopEnabled ? "text-blue-500" : "text-gray-400 hover:text-blue-500"
              )}
            >
              <Repeat size={18} />
            </button>
            {loopEnabled && (
              <div className="flex items-center gap-1">
                {loopCounts.map((count) => (
                  <button
                    key={count}
                    onClick={() => onChangeLoopCount?.(count)}
                    className={cn(
                      "min-w-[20px] rounded-md px-1.5 py-0.5 text-[10px] font-black transition-all",
                      loopCount === count
                        ? "bg-gray-900 text-white"
                        : "text-gray-400 hover:bg-gray-100"
                    )}
                  >
                    {count === -1 ? "∞" : count}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Middle: Controls - 绝对居中，跟左侧循环次数按钮的宽度互不影响 */}
        <div className="flex items-center gap-5 absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <button
            onClick={onPrevSentence}
            disabled={!hasPrevSentence}
            title="上一句（←）"
            className="text-gray-400 hover:text-blue-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-gray-400"
          >
            <ChevronLeft size={26} />
          </button>
          <button 
            onClick={togglePlay}
            className="w-14 h-14 bg-gray-900 text-white rounded-full flex items-center justify-center shadow-xl shadow-gray-900/20 hover:scale-105 active:scale-95 transition-all"
          >
            {isPlaying ? (
              <Pause size={28} className="fill-current" />
            ) : (
              <Play size={28} className="fill-current ml-1" />
            )}
          </button>
          <button
            onClick={onNextSentence}
            disabled={!hasNextSentence}
            title="下一句（→）"
            className="text-gray-400 hover:text-blue-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-gray-400"
          >
            <ChevronRight size={26} />
          </button>
        </div>

        {/* Right: Speed */}
        <div className="flex items-center gap-8">
          <div className="text-[10px] font-bold font-mono text-gray-400 min-w-8 text-right">{formatTime(duration)}</div>
          
          <div ref={speedMenuRef} className="relative">
            <button
              onClick={() => setIsSpeedMenuOpen((open) => !open)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-100 bg-white px-3 py-1 shadow-sm transition-all active:scale-95 hover:border-gray-200 group"
            >
              <span className="text-[10px] font-black text-gray-900 group-hover:text-blue-600">{playbackRate}x</span>
            </button>

            {isSpeedMenuOpen && (
              <div className="absolute bottom-full right-0 mb-2 min-w-[72px] overflow-hidden rounded-2xl border border-gray-100 bg-white/95 p-1.5 shadow-xl shadow-gray-900/10 backdrop-blur-md">
                {speedOptions.map((option) => {
                  const isActive = playbackRate === option;
                  return (
                    <button
                      key={option}
                      onClick={() => handlePlaybackRateChange(option)}
                      className={cn(
                        "flex w-full items-center justify-center rounded-xl px-3 py-2 text-[11px] font-bold transition-all",
                        isActive
                          ? "bg-gray-900 text-white"
                          : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                      )}
                    >
                      {option}x
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
