import type { FavoriteSentence } from "@/types/podcast";

const STORAGE_KEY = "podcast-favorites";

function sortByDate(items: FavoriteSentence[]) {
  return [...items].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function buildFavoriteId(podcastId: string, start: string) {
  return `${podcastId}:${start}`;
}

export function loadPodcastFavorites(): FavoriteSentence[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return sortByDate(JSON.parse(raw) as FavoriteSentence[]);
  } catch {
    return [];
  }
}

export function savePodcastFavorites(items: FavoriteSentence[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sortByDate(items)));
}

export function upsertPodcastFavorite(item: FavoriteSentence) {
  const current = loadPodcastFavorites();
  const next = current.filter((favorite) => favorite.id !== item.id);
  next.unshift(item);
  savePodcastFavorites(next);
}

export function hasPodcastFavorite(id: string) {
  return loadPodcastFavorites().some((item) => item.id === id);
}

export function deletePodcastFavorite(id: string) {
  const current = loadPodcastFavorites();
  savePodcastFavorites(current.filter((item) => item.id !== id));
}

export function updatePodcastFavoriteTags(id: string, tags: string[]) {
  const current = loadPodcastFavorites();
  const next = current.map((item) =>
    item.id === id
      ? {
          ...item,
          tags,
        }
      : item,
  );
  savePodcastFavorites(next);
}

export function updatePodcastFavoritePodcastTitle(podcastId: string, podcastTitle: string) {
  const current = loadPodcastFavorites();
  const next = current.map((item) =>
    item.podcastId === podcastId
      ? {
          ...item,
          podcastTitle,
        }
      : item,
  );
  savePodcastFavorites(next);
}
