import path from "node:path";
import type { NextConfig } from "next";

/**
 * PocketBay 是单服务架构：公网入口只指向一个容器。
 * 因此前端与后端跑在同一个容器里，由 Next.js 把接口路径代理给本机 FastAPI。
 */
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8000";

/**
 * 显式钉死项目根目录。
 *
 * Next 靠「向上查找锁文件」自动推断工作区根，只要上层任何目录里存在
 * package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lock(b)，就会被误判。
 * 本机 `/Users/mac/package-lock.json` 就是这种情况（家目录里误建过 npm 项目），
 * 导致 Next 把根推断成 `/Users/mac` —— 于是每次 dev/build 都刷警告，
 * 且模块解析范围与文件监听范围被放大到整个家目录。
 *
 * 显式设置后：解析范围收敛到本项目，缓存校验与文件监听开销都随之下降，
 * 产物追踪（outputFileTracingRoot）也不会再试图追踪项目外的文件。
 */
const projectRoot = __dirname;

/** 需要转发给 FastAPI 的路径（与 backend/main.py 的路由一一对应）。 */
const API_PATHS = [
  "/health",
  "/openapi.json",
  "/docs",
  "/redoc",
  "/parse-rss",
  "/process-podcast",
  "/process-rss-item",
  "/jobs/:path*",
  "/media/:path*",
  "/api/:path*",
];

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  outputFileTracingRoot: path.join(projectRoot),
  async rewrites() {
    return {
      beforeFiles: API_PATHS.map((path) => ({
        source: path,
        destination: `${BACKEND_ORIGIN}${path}`,
      })),
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
