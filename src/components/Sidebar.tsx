"use client";

import React from "react";
import { Headphones, Heart, MessageSquare, Trash2 } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { StoredPodcast } from "@/types/podcast";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface PodcastItem {
  id: string;
  title: string;
  date: string;
  duration: string;
}

export const Sidebar = ({ 
  activeTab = "now-playing",
  selectedPodcastId,
  historyItems = [],
  onSelectNowPlaying,
  onSelectHistory,
  onSelectFavorites,
  onDeletePodcast
}: { 
  activeTab?: string;
  selectedPodcastId?: string | null;
  historyItems?: StoredPodcast[];
  onSelectNowPlaying?: () => void;
  onSelectHistory?: (podcast: StoredPodcast) => void;
  onSelectFavorites?: () => void;
  onDeletePodcast?: (id: string) => void;
}) => {
  return (
    <aside className="w-64 border-r border-gray-100 flex flex-col h-screen bg-white">
      {/* Logo Section */}
      <div className="p-6 flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
          <Headphones className="text-white w-6 h-6" />
        </div>
        <span className="font-bold text-xl text-gray-900 tracking-tight">PodcastCatcher</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 overflow-y-auto pt-2">
        <div className="mb-8">
          <div 
            onClick={onSelectNowPlaying}
            className={cn(
              "px-4 py-3 rounded-xl flex items-center gap-3 cursor-pointer transition-all",
              activeTab === "now-playing" ? "bg-blue-50 text-blue-600 shadow-sm" : "text-gray-500 hover:bg-gray-50"
            )}
          >
            <Headphones size={20} strokeWidth={activeTab === "now-playing" ? 2.5 : 2} />
            <span className="font-bold">Now Playing</span>
          </div>
        </div>

        <div className="mb-8">
          <h3 className="px-4 text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em] mb-4">
            HISTORY
          </h3>
          <div className="space-y-1">
            {historyItems.map((item) => (
              <HistoryCard
                key={item.id}
                item={item}
                active={selectedPodcastId === item.id && activeTab === "now-playing"}
                onClick={() => onSelectHistory?.(item)}
                onDelete={onDeletePodcast}
              />
            ))}
            {historyItems.length === 0 && (
              <div className="px-4 py-3 text-xs font-bold text-gray-300">
                还没有上传记录
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Footer / Favorites */}
      <div className="p-4 border-t border-gray-100 bg-white">
        <button 
          onClick={onSelectFavorites}
          className={cn(
            "w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl transition-all active:scale-[0.98] mb-3",
            activeTab === "favorites" ? "bg-blue-50 text-blue-600 shadow-sm" : "text-gray-600 hover:bg-gray-50"
          )}
        >
          <Heart size={20} strokeWidth={activeTab === "favorites" ? 2.5 : 2} />
          <span className="font-bold text-sm">我的收藏</span>
        </button>

        <div className="text-center space-y-1 pb-2">
          <p className="text-[10px] font-medium text-gray-400">开发者日常在线反馈Bug</p>
          <a href="#" className="text-[10px] font-bold text-gray-500 hover:text-blue-500 flex items-center justify-center gap-1.5 transition-colors">
             <MessageSquare size={10} />
             MaydayAzure
          </a>
        </div>
      </div>
    </aside>
  );
};

const HistoryCard = ({ item, active = false, onClick, onDelete }: { 
  item: any; 
  active?: boolean;
  onClick: () => void;
  onDelete?: (id: string) => void;
}) => {
  // 格式化日期逻辑
  const formattedDate = React.useMemo(() => {
    if (!item.date) return "";
    try {
      const date = new Date(item.date);
      if (isNaN(date.getTime())) return item.date;
      return date.toLocaleDateString("zh-CN").replace(/\//g, "-");
    } catch {
      return item.date;
    }
  }, [item.date]);

  // 删除确认气泡：默认收起，点击删除图标展开，点空白 / 取消收起
  const [confirming, setConfirming] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!confirming) return;
    const onPointerDown = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setConfirming(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirming(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [confirming]);

  const handleDeleteClick = (event: React.MouseEvent) => {
    // 别触发卡片的「跳去详情页」点击
    event.stopPropagation();
    setConfirming((value) => !value);
  };

  const handleConfirm = (event: React.MouseEvent) => {
    event.stopPropagation();
    setConfirming(false);
    onDelete?.(item.id);
  };

  const handleCancel = (event: React.MouseEvent) => {
    event.stopPropagation();
    setConfirming(false);
  };

  return (
    <div 
      onClick={onClick}
      className={cn(
        "relative p-4 rounded-2xl cursor-pointer transition-all border-2",
        active ? "border-blue-500 bg-white shadow-md shadow-blue-500/5" : "border-transparent hover:bg-gray-50"
      )}
    >
      <h4 className={cn(
        "text-sm font-bold mb-2 leading-tight line-clamp-2",
        active ? "text-gray-900" : "text-gray-500"
      )}>
        {item.title}
      </h4>
      <div className="flex items-center justify-between gap-2 text-[10px] font-medium text-gray-400">
        <div className="flex items-center gap-2 min-w-0">
          <span>{formattedDate}</span>
          <span>•</span>
          <span>{item.duration}</span>
          {item.status !== "success" && (
            <>
              <span>•</span>
              <span>{item.stage}</span>
            </>
          )}
        </div>

        {/* 只支持删除已转写成功的播客，避免产生孤儿数据 */}
        {item.status === "success" && (
          <div className="relative shrink-0" ref={popoverRef}>
            <button
              type="button"
              aria-label="删除这集播客"
              onClick={handleDeleteClick}
              className="p-1 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <Trash2 size={14} />
            </button>

            {confirming && (
              <div
                onClick={(event) => event.stopPropagation()}
                className="absolute right-0 bottom-full mb-2 z-50 w-44 rounded-xl border border-gray-200 bg-white p-3 shadow-xl"
              >
                <p className="text-xs font-semibold text-gray-700 mb-1 leading-snug">
                  确定删除这集播客？
                </p>
                <p className="text-[10px] text-gray-400 mb-3 leading-snug">
                  该集及其收藏句子都会被删除。
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="px-2.5 py-1 rounded-md text-[11px] font-medium text-gray-500 hover:bg-gray-100 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    className="px-2.5 py-1 rounded-md text-[11px] font-bold text-white bg-red-500 hover:bg-red-600 transition-colors"
                  >
                    确定
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
