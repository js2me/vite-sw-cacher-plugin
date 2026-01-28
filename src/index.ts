import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";
import type { Plugin, ResolvedConfig } from "vite";
import ejs from "ejs";
import { minify } from "terser";
import { lookup as lookupMimeType } from "mime-types";
import swTemplate from "./templates/sw.ejs";
import inlineScriptTemplate from "./templates/inline-script.ejs";

export interface ViteSwCacherPluginOptions {
  /** Массив расширений (пример: [".js", ".css"]) */
  extensions?: string[];
  /** URL-паттерн со * (пример: "*vk.com*") */
  pattern?: string;
  /** TTL в мс (пример: 24 * 60 * 60 * 1000) */
  ttl?: number;
  /** Лимит элементов кэша (пример: 200) */
  maxItemsCount?: number | ((staticCount: number) => number); 
  /** Имя кеша (пример: "vite-sw-cacher-plugin") */
  cacheName?: string;
  /** Инлайн SW через Blob (пример: true) */
  inlineSw?: boolean;
  /** Лениво подгружать статику (пример: true) */
  lazyPreload?: boolean;
}

const DEFAULT_EXTENSIONS = [
  ".html",
  ".css",
  ".js",
  ".svg",
  ".png",
  ".jpeg",
  ".jpg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
];

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_NAME = "vite-sw-cacher-plugin";
const DEFAULT_SW_FILE_NAME = "sw-cacher.js";

const normalizeExtensions = (extensions?: string[]): string[] => {
  const list = extensions?.length ? extensions : DEFAULT_EXTENSIONS;
  const normalized = list.map((ext) => {
    const trimmed = ext.trim();
    if (!trimmed) return "";
    return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
  });

  return Array.from(new Set(normalized.filter(Boolean)));
};

const wildcardToRegexSource = (pattern: string): string => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped.replace(/\*/g, ".*")}$`;
};

const countStaticOutputs = (bundle: OutputBundle, extensions: string[]): number => {
  if (!extensions.length) return 0;
  const normalized = extensions.map((ext) => ext.toLowerCase());
  const items = Object.values(bundle) as Array<OutputAsset | OutputChunk>;
  return items.filter((item) => {
    const name = item.fileName.toLowerCase();
    return normalized.some((ext) => name.endsWith(ext));
  }).length;
};

const joinBase = (base: string, fileName: string): string => {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${fileName}`;
};

const INLINE_PLACEHOLDER = "/*__VITE_SW_CACHER_INLINE__*/";

const collectStaticUrls = (
  bundle: OutputBundle,
  base: string,
  swFileName: string,
): string[] => {
  const urls: string[] = [];
  for (const item of Object.values(bundle)) {
    const fileName = item.fileName;
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".html")) continue;
    if (lower.endsWith(".map")) continue;
    if (lower === swFileName.toLowerCase()) continue;
    urls.push(joinBase(base, fileName));
  }
  return Array.from(new Set(urls));
};

const injectScriptIntoHtml = (html: string, script: string): string => {
  const tag = `<script>${script}</script>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${tag}</head>`);
  }
  return `${html}${tag}`;
};

const toHtmlString = (source: OutputAsset["source"]): string => {
  if (typeof source === "string") return source;
  return new TextDecoder().decode(source);
};

const renderTemplate = (template: string, data: Record<string, unknown>): string =>
  ejs.render(template, data);

const minifyScript = async (code: string): Promise<string> => {
  const result = await minify(code, {
    compress: true,
    mangle: true,
    format: { comments: false },
  });
  return result.code ?? code;
};

const buildServiceWorkerSource = async (options: {
  cacheName: string;
  ttlMs: number;
  maxItems: number;
  extensions: string[];
  pattern?: string;
}): Promise<string> => {
  const patternSource = options.pattern ? wildcardToRegexSource(options.pattern) : null;
  const urlPatternSource = patternSource
    ? `new RegExp(${JSON.stringify(patternSource)})`
    : "null";
  const allowedContentTypes = Array.from(
    new Set(
      options.extensions
        .map((ext) => lookupMimeType(ext))
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    ),
  );

  const source = renderTemplate(swTemplate, {
    cacheNameJson: JSON.stringify(options.cacheName),
    ttlMs: Math.max(0, options.ttlMs),
    maxItems: options.maxItems,
    extensionsJson: JSON.stringify(options.extensions),
    allowedContentTypesJson: JSON.stringify(allowedContentTypes),
    urlPatternSource,
  });

  return minifyScript(source);
};

export const viteSwCacherPlugin = (
  options: ViteSwCacherPluginOptions = {},
): Plugin => {
  let resolvedConfig: ResolvedConfig | null = null;
  const swFileName = DEFAULT_SW_FILE_NAME;

  return {
    name: "vite-sw-cacher-plugin",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      resolvedConfig = config;
    },
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        if (options.inlineSw || options.lazyPreload) {
          return {
            html,
            tags: [
              {
                tag: "script",
                injectTo: "head",
                children: INLINE_PLACEHOLDER,
              },
            ],
          };
        }
        const base = resolvedConfig?.base ?? "/";
        const swUrl = joinBase(base, swFileName);
        const inlineScript = renderTemplate(inlineScriptTemplate, {
          inlineSw: false,
          lazyPreload: false,
          swUrlJson: JSON.stringify(swUrl),
          assetsJson: "[]",
        });
        const minifiedInlineScript = await minifyScript(inlineScript);

        return {
          html,
          tags: [
            {
              tag: "script",
              injectTo: "head",
              children: minifiedInlineScript,
            },
          ],
        };
      },
    },
    async generateBundle(_, bundle) {
      const extensions = normalizeExtensions(options.extensions);
      const staticCount = countStaticOutputs(bundle, extensions);
      const ttlMs = options.ttl ?? DEFAULT_TTL_MS;
      const maxItems =
        typeof options.maxItemsCount === 'function' ?
          options.maxItemsCount(staticCount) :
          options.maxItemsCount ?? staticCount * 2;
      const cacheName = options.cacheName ?? DEFAULT_CACHE_NAME;
      const inlineSw = options.inlineSw ?? false;
      const lazyPreload = options.lazyPreload ?? false;
      const base = resolvedConfig?.base ?? "/";

      const swSource = await buildServiceWorkerSource({
        cacheName,
        ttlMs,
        maxItems,
        extensions,
        pattern: options.pattern,
      });

      if (inlineSw || lazyPreload) {
        const assets = collectStaticUrls(bundle, base, swFileName);
        const inlineScript = renderTemplate(inlineScriptTemplate, {
          inlineSw,
          lazyPreload,
          swUrlJson: JSON.stringify(joinBase(base, swFileName)),
          swCodeJson: JSON.stringify(swSource),
          assetsJson: JSON.stringify(assets),
        });
        const minifiedInlineScript = await minifyScript(inlineScript);

        for (const item of Object.values(bundle)) {
          if (item.type !== "asset") continue;
          if (!item.fileName.toLowerCase().endsWith(".html")) continue;
          const html = toHtmlString(item.source);
          const updatedHtml = html.includes(INLINE_PLACEHOLDER)
            ? html.replace(INLINE_PLACEHOLDER, minifiedInlineScript)
            : injectScriptIntoHtml(html, minifiedInlineScript);
          item.source = updatedHtml;
        }
        if (!inlineSw) {
          this.emitFile({
            type: "asset",
            fileName: swFileName,
            source: swSource,
          });
        }
        return;
      }

      this.emitFile({
        type: "asset",
        fileName: swFileName,
        source: swSource,
      });
    },
  };
};

export default viteSwCacherPlugin;
