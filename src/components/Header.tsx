"use client";

import React from "react";
import { Upload, Link2, ArrowRight, Loader2 } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const Header = ({ 
  mode = "import", 
  title, 
  subtitle,
  rssValue = "",
  rssPlaceholder = "RSS 或播客链接...",
  onRssChange,
  onSubmitRss,
  onUploadClick,
  isSubmittingRss = false,
  isProcessing = false,
}: { 
  mode?: "import" | "player",
  title?: string,
  subtitle?: string,
  rssValue?: string,
  rssPlaceholder?: string,
  onRssChange?: (value: string) => void,
  onSubmitRss?: () => void,
  onUploadClick?: () => void,
  isSubmittingRss?: boolean,
  isProcessing?: boolean,
}) => {
  const hasTitle = title && title.trim() !== "";

  return (
    <header className="flex flex-col border-b border-gray-100 bg-white shrink-0">
      <div className="flex items-center justify-between px-10 py-5">
        {/* Left Section */}
        <div className="flex flex-col gap-0.5">
          {mode === "import" ? (
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">导入播客</h1>
          ) : (
            hasTitle ? (
              <>
                <h1 className="text-sm font-bold text-gray-900 line-clamp-1 max-w-md">
                  {title}
                </h1>
                <p className="text-[10px] font-bold text-gray-400">
                  {subtitle || "Transcription by Whisper v3 Large"}
                </p>
              </>
            ) : (
              <div className="h-8" /> 
            )
          )}
        </div>

        {/* Right Section */}
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-gray-50 border border-gray-100 rounded-full px-4 py-2 w-80 group focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:bg-white transition-all relative overflow-hidden">
            <Link2 size={16} className="text-gray-400 group-focus-within:text-blue-500 mr-2" />
            <input 
              type="text" 
              value={rssValue}
              placeholder={rssPlaceholder}
              className="flex-1 bg-transparent text-xs font-bold focus:outline-none text-gray-700"
              disabled={isSubmittingRss}
              onChange={(event) => onRssChange?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onSubmitRss?.();
                }
              }}
            />
            <button 
              onClick={onSubmitRss}
              disabled={isSubmittingRss}
              className={cn(
                "text-blue-500 hover:text-blue-600 transition-colors ml-2 flex items-center justify-center",
                isSubmittingRss && "opacity-50 cursor-not-allowed"
              )}
            >
              {isSubmittingRss ? (
                <Loader2 size={18} strokeWidth={3} className="animate-spin" />
              ) : (
                <ArrowRight size={18} strokeWidth={3} />
              )}
            </button>
          </div>

          <button 
            onClick={onUploadClick}
            disabled={isProcessing}
            className={cn(
              "flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white rounded-full font-bold text-xs transition-all shadow-lg shadow-blue-600/20 active:scale-[0.98]",
              isProcessing ? "cursor-not-allowed opacity-60" : "hover:bg-blue-700"
            )}
          >
            {isProcessing ? (
              <Loader2 size={16} strokeWidth={3} className="animate-spin" />
            ) : (
              <Upload size={16} strokeWidth={3} />
            )}
            <span>{isProcessing ? "Processing..." : "Local MP3"}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
