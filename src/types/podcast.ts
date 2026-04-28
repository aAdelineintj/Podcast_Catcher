"use client";

export type TranscriptSegment = {
  start: string;
  original: string;
  translation: string;
  translation_status?: string;
  detected_lang?: string;
  detection_reason?: string;
};

export type StoredPodcast = {
  id: string;
  title: string;
  date: string;
  duration: string;
  mediaUrl?: string | null;
  status: string;
  stage: string;
  progress: number;
  translatedCount: number;
  totalSegments: number;
  errorMessage?: string | null;
  segments: TranscriptSegment[];
};
