import type { StoredPodcast } from "@/types/podcast";

const STORAGE_KEY = "podcast-history";

function sortByDate(items: StoredPodcast[]) {
  return [...items].sort(
    (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime(),
  );
}

export function loadPodcastHistory(): StoredPodcast[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as StoredPodcast[];
    return sortByDate(parsed);
  } catch {
    return [];
  }
}

export function savePodcastHistory(items: StoredPodcast[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sortByDate(items)));
}

export function upsertPodcastHistoryItem(item: StoredPodcast) {
  const current = loadPodcastHistory();
  const next = current.filter((podcast) => podcast.id !== item.id);
  next.unshift(item);
  savePodcastHistory(next);
}

export function getPodcastHistoryItem(id: string) {
  return loadPodcastHistory().find((item) => item.id === id) ?? null;
}
