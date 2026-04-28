"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, SkipBack, SkipForward, Share2, Copy, Repeat } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface BottomPlayerRef {
  seek: (time: number | string) => void;
  play: () => void;
  pause: () => void;
}

export const BottomPlayer = React.forwardRef<BottomPlayerRef, { 
  audioSrc?: string | null;
  title?: string;
  onTimeUpdate?: (time: number) => void;
}>(({ 
  audioSrc,
  title = "Podcast",
  onTimeUpdate
}, ref) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

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
  }));

  // Sync state with audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => {
      const time = audio.currentTime;
      setCurrentTime(time);
      onTimeUpdate?.(time);
    };
    const handleLoadedMetadata = () => setDuration(audio.duration);

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, [audioSrc]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(err => console.error("Playback error:", err));
    }
  };

  const skip = (seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime += seconds;
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

      <div className="flex items-center justify-between mt-2">
        {/* Left: Actions */}
        <div className="flex items-center gap-6 text-gray-400">
          <div className="text-[10px] font-bold font-mono min-w-8">{formatTime(currentTime)}</div>
          <button className="hover:text-blue-500 transition-colors">
            <Share2 size={18} />
          </button>
          <button className="hover:text-blue-500 transition-colors">
            <Copy size={18} />
          </button>
        </div>

        {/* Middle: Controls */}
        <div className="flex items-center gap-10">
          <div className="w-12 h-12 flex items-center justify-center text-gray-400 hover:text-gray-900 transition-all">
             <button onClick={() => skip(-15)} className="hover:scale-110 active:scale-95 transition-all">
               <SkipBack size={24} className="fill-current" />
             </button>
          </div>
          
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

          <div className="w-12 h-12 flex items-center justify-center text-gray-400 hover:text-gray-900 transition-all">
             <button onClick={() => skip(15)} className="hover:scale-110 active:scale-95 transition-all">
               <SkipForward size={24} className="fill-current" />
             </button>
          </div>
        </div>

        {/* Right: Mode & Speed */}
        <div className="flex items-center gap-8">
          <div className="text-[10px] font-bold font-mono text-gray-400 min-w-8 text-right">{formatTime(duration)}</div>
          
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[8px] font-bold text-gray-300 uppercase tracking-widest">LOOP MODE</span>
            <div className="flex items-center bg-gray-50 rounded-full p-1 border border-gray-100">
              <button className="px-3 py-1 text-[10px] font-bold text-gray-400 hover:text-gray-900 rounded-full transition-all">Sentence</button>
              <div className="w-px h-3 bg-gray-200" />
              <button className="px-3 py-1 text-[10px] font-bold text-gray-900 bg-white rounded-full shadow-sm">Off</button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1 bg-white border border-gray-100 rounded-lg shadow-sm hover:border-gray-200 cursor-pointer transition-all active:scale-95 group">
             <span className="text-[10px] font-black text-gray-900 group-hover:text-blue-600">1x</span>
          </div>
        </div>
      </div>
    </div>
  );
});
