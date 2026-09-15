const RAW_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export const API_BASE = RAW_BASE.replace(/\/+$/, "");

export const apiUrl = (path: string) => {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
};
