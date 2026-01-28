import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";
import type { Plugin, ResolvedConfig } from "vite";
import ejs from "ejs";
import { minify } from "terser";
import swTemplate from "./templates/sw.ejs";
import inlineScriptTemplate from "./templates/inline-script.ejs";

export interface ViteSwCacherPluginOptions {
  extensions?: string[];
  pattern?: string;
  ttl?: number;
  maxItemsCount?: number;
  cacheName?: string;
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

  const source = renderTemplate(swTemplate, {
    cacheNameJson: JSON.stringify(options.cacheName),
    ttlMs: Math.max(0, options.ttlMs),
    maxItems: options.maxItems,
    extensionsJson: JSON.stringify(options.extensions),
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
    configResolved(config) {
      resolvedConfig = config;
    },
    async transformIndexHtml(html) {
      const base = resolvedConfig?.base ?? "/";
      const swUrl = joinBase(base, swFileName);
      const inlineScript = renderTemplate(inlineScriptTemplate, {
        swUrlJson: JSON.stringify(swUrl),
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
    async generateBundle(_, bundle) {
      const extensions = normalizeExtensions(options.extensions);
      const staticCount = countStaticOutputs(bundle, extensions);
      const ttlMs = options.ttl ?? DEFAULT_TTL_MS;
      const maxItems =
        options.maxItemsCount ?? staticCount * 2;
      const cacheName = options.cacheName ?? DEFAULT_CACHE_NAME;

      const swSource = await buildServiceWorkerSource({
        cacheName,
        ttlMs,
        maxItems,
        extensions,
        pattern: options.pattern,
      });

      this.emitFile({
        type: "asset",
        fileName: swFileName,
        source: swSource,
      });
    },
  };
};

export default viteSwCacherPlugin;
