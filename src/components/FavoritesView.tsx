"use client";

import React from "react";
import { Play, Headphones, FileText, Download } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface FavoriteItem {
  id: string;
  original: string;
  translation: string;
  podcastTitle: string;
}

export const FavoritesView = ({ 
  items,
  onPlay 
}: { 
  items: FavoriteItem[];
  onPlay: (item: FavoriteItem) => void;
}) => {
  return (
    <div className="flex-1 flex flex-col h-full bg-white overflow-hidden">
      {/* Header for Favorites */}
      <div className="px-10 py-8 border-b border-gray-100 flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-black text-gray-900">我的收藏</h2>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
            {items.length} 条收藏语料
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 text-white rounded-xl font-bold text-xs hover:bg-gray-800 transition-all shadow-lg shadow-gray-900/10 active:scale-[0.98]">
            <FileText size={16} />
            <span>导出 Anki</span>
          </button>
          <button className="flex items-center gap-2 px-6 py-2.5 bg-gray-50 text-gray-600 rounded-xl font-bold text-xs hover:bg-gray-100 transition-all border border-gray-100 active:scale-[0.98]">
            <Download size={16} />
            <span>导出 Excel</span>
          </button>
        </div>
      </div>

      {/* Grid of Favorite Cards */}
      <div className="flex-1 overflow-y-auto px-10 py-10 custom-scrollbar">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-20">
          {items.map((item) => (
            <FavoriteCard key={item.id} item={item} onPlay={() => onPlay(item)} />
          ))}
        </div>
      </div>
    </div>
  );
};

const FavoriteCard = ({ item, onPlay }: { item: FavoriteItem; onPlay: () => void }) => (
  <div className="group bg-white border border-gray-100 rounded-[32px] p-8 hover:shadow-2xl hover:shadow-blue-500/5 transition-all duration-500 flex flex-col gap-6 relative overflow-hidden">
    {/* Podcast Source Badge */}
    <div className="flex items-center gap-2 text-[10px] font-bold text-blue-500 uppercase tracking-widest">
      <Headphones size={12} />
      <span className="truncate max-w-[200px]">{item.podcastTitle}</span>
    </div>

    {/* Text Content */}
    <div className="space-y-4 flex-1">
      <p className="text-lg font-bold text-gray-900 leading-relaxed line-clamp-3 group-hover:text-blue-600 transition-colors">
        {item.original}
      </p>
      <p className="text-sm font-bold text-gray-400 leading-relaxed line-clamp-3">
        {item.translation}
      </p>
    </div>

    {/* Play Button Overlay/Footer */}
    <div className="flex items-center justify-between mt-2">
      <div className="h-px flex-1 bg-gray-50 group-hover:bg-blue-50 transition-colors mr-6" />
      <button 
        onClick={onPlay}
        className="w-12 h-12 bg-blue-600 text-white rounded-2xl flex items-center justify-center shadow-lg shadow-blue-600/20 hover:scale-110 active:scale-95 transition-all"
      >
        <Play size={20} className="fill-current ml-0.5" />
      </button>
    </div>
  </div>
);
