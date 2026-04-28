"use client";

import React from "react";
import { Play, SkipBack, SkipForward, Repeat, Share2, Copy, MoreHorizontal, Headphones } from "lucide-react";

export const Player = ({ title }: { title: string }) => {
  return (
    <div className="mx-8 mt-6 p-6 bg-white border border-gray-100 rounded-3xl shadow-sm flex items-center gap-8 group hover:shadow-md transition-all">
      {/* Cover Art */}
      <div className="w-24 h-24 bg-yellow-100 rounded-2xl flex items-center justify-center shrink-0 shadow-inner group-hover:scale-105 transition-transform">
        <Headphones className="text-yellow-500 w-10 h-10" />
      </div>

      {/* Info & Controls */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900 truncate pr-8">
            {title}
          </h2>
          <div className="flex items-center gap-3 shrink-0">
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-full transition-all">
              <Share2 size={14} />
              <span>分享</span>
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-full transition-all">
              <Copy size={14} />
              <span>拷贝文本</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-4">
            <button className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-all">
              <Repeat size={20} />
            </button>
            <button className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-all">
              <SkipBack size={24} className="fill-current" />
            </button>
            <button className="w-12 h-12 bg-orange-500 text-white rounded-full flex items-center justify-center hover:bg-orange-600 shadow-lg shadow-orange-500/30 hover:shadow-orange-500/40 transition-all active:scale-95">
              <Play size={24} className="fill-current ml-1" />
            </button>
            <button className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-all">
              <SkipForward size={24} className="fill-current" />
            </button>
          </div>

          {/* Progress Bar */}
          <div className="flex-1 flex items-center gap-4">
            <span className="text-xs font-medium text-gray-400 w-8">0:20</span>
            <div className="flex-1 h-2 bg-gray-100 rounded-full relative overflow-hidden group/progress cursor-pointer">
              <div className="absolute inset-0 bg-yellow-400/20 w-full" />
              <div className="absolute inset-y-0 left-0 bg-yellow-400 w-[15%] rounded-full shadow-sm" />
            </div>
            <span className="text-xs font-medium text-gray-400 w-8">6:14</span>
          </div>

          <div className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs font-bold hover:bg-gray-200 transition-colors cursor-pointer">
            1.0x
          </div>
        </div>
      </div>
    </div>
  );
};
