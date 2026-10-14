import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import tailwindcss from "@tailwindcss/postcss";
import autoprefixer from "autoprefixer";
import { defineConfig } from "vite";
import vinext from "vinext";

/**
 * vinext（Vite）侧的构建配置。`next dev` 不受影响，两套并存。
 *
 * ── 为什么 PostCSS 配置要内联，而不是留着 postcss.config.cjs ──
 * `cf` 的 `@cloudflare/config` 会注册一个 Node 模块加载钩子（用来读 cloudflare.config.ts）。
 * 该钩子在 Vite 的 CSS 插件去 `import()` 加载 `postcss.config.cjs` 时返回 undefined，
 * Node 直接抛：
 *   TypeError [ERR_INVALID_RETURN_PROPERTY_VALUE]:
 *     Expected a string, an ArrayBuffer, or a TypedArray to be returned
 *     for the "source" from the "load" hook but got undefined.
 * 报错文案完全指不到 PostCSS，很容易误判成 CSS 写坏了。
 *
 * 在 Vite 里用**对象形式的 `css.postcss`** 之后，Vite 不再去搜索配置文件，
 * 这条加载路径就绕开了。`postcss.config.cjs` 继续保留，给 `next dev` 用。
 * 两边的插件列表必须保持一致，否则两套构建产出的 CSS 会不一样。
 */
export default defineConfig({
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  plugins: [
    vinext({
      images: { optimizer: imagesOptimizer() },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
