import { describe, expect, it, vi } from "vitest";
import { viteSwCacherPlugin } from "../src/index";

vi.mock("terser", () => ({
  minify: vi.fn(async (code: string) => ({ code })),
}));

vi.mock("../src/templates/sw.ejs", () => ({
  default:
    "const URL_PATTERNS=<%- urlPatternSources %>;const EXCLUDE_URL_PATTERNS=<%- excludeUrlPatternSources %>;self.addEventListener(\"install\",()=>{});",
}));

vi.mock("../src/templates/inline-script.ejs", () => ({
  default:
    "<% if (inlineSw) { %>const swCode=<%- swCodeJson %>;<% } %><% if (lazyPreload) { %>const assets=<%- assetsJson %>;for (const url of assets){fetch(url);} <% } %>navigator.serviceWorker.register(<%- swUrlJson %>);",
}));

const createHtmlAsset = (html: string) => ({
  type: "asset",
  fileName: "index.html",
  source: html,
});

const getTransformHandler = (plugin: any) => {
  const transform = plugin.transformIndexHtml;
  if (typeof transform === "function") return transform;
  if (transform && typeof transform.handler === "function") return transform.handler;
  return undefined;
};

const applyTransformResult = (html: string, result: any): string => {
  if (!result) return html;
  if (typeof result === "string") return result;
  const tags = result.tags ?? [];
  if (!tags.length) return result.html ?? html;
  const injected = tags
    .map((tag: any) => `<${tag.tag}>${tag.children ?? ""}</${tag.tag}>`)
    .join("");
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${injected}</head>`);
  }
  return `${html}${injected}`;
};

const getAssetsFromHtml = (html: string): string[] => {
  const match = html.match(/const assets=([^;]+);/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
};

describe("vite-sw-cacher-plugin", () => {
  it("инлайнит регистрационный скрипт по умолчанию", async () => {
    const plugin = viteSwCacherPlugin();
    plugin.configResolved?.({ base: "/" } as any);

    const handler = getTransformHandler(plugin);
    const result = await handler?.("<html><head></head><body></body></html>");
    expect(result).toBeTruthy();
    const tags = (result as any).tags;
    expect(Array.isArray(tags)).toBe(true);
    expect(tags[0].children).toContain("serviceWorker");
  });

  it("использует base при регистрации SW", async () => {
    const plugin = viteSwCacherPlugin();
    plugin.configResolved?.({ base: "/app/" } as any);

    const handler = getTransformHandler(plugin);
    const result = await handler?.("<html><head></head><body></body></html>");
    const tags = (result as any).tags;
    expect(tags[0].children).toContain("/app/sw-cacher.js");
  });

  it("для inlineSw возвращает плейсхолдер в transformIndexHtml", async () => {
    const plugin = viteSwCacherPlugin({ inlineSw: true });
    plugin.configResolved?.({ base: "/" } as any);

    const handler = getTransformHandler(plugin);
    const result = await handler?.("<html><head></head><body></body></html>");
    const tags = (result as any).tags;
    expect(tags[0].children).toContain("__VITE_SW_CACHER_INLINE__");
  });

  it("подставляет lazy preload скрипт в HTML при generateBundle", async () => {
    const plugin = viteSwCacherPlugin({ lazyPreload: true });
    plugin.configResolved?.({ base: "/" } as any);

    const htmlAsset = createHtmlAsset("<html><head></head><body></body></html>");
    const bundle: any = {
      "index.html": htmlAsset,
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    const outputHtml = String(htmlAsset.source);
    expect(outputHtml).toContain("serviceWorker");
    expect(outputHtml).toContain("fetch(");
    expect(outputHtml).toContain("assets/main.js");
    expect(outputHtml).not.toContain("__VITE_SW_CACHER_INLINE__");
  });

  it("не эмитит sw-cacher.js при inlineSw", async () => {
    const plugin = viteSwCacherPlugin({ inlineSw: true });
    plugin.configResolved?.({ base: "/" } as any);

    const htmlAsset = createHtmlAsset("<html><head></head><body></body></html>");
    const bundle: any = {
      "index.html": htmlAsset,
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    expect(ctx.emitFile).not.toHaveBeenCalled();
    expect(String(htmlAsset.source)).toContain("serviceWorker");
  });

  it("эмитит sw-cacher.js при lazyPreload без inlineSw", async () => {
    const plugin = viteSwCacherPlugin({ lazyPreload: true });
    plugin.configResolved?.({ base: "/" } as any);

    const htmlAsset = createHtmlAsset("<html><head></head><body></body></html>");
    const bundle: any = {
      "index.html": htmlAsset,
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    expect(ctx.emitFile).toHaveBeenCalledTimes(1);
    expect(ctx.emitFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "sw-cacher.js" }),
    );
  });

  it("поддерживает pattern и excludePattern", async () => {
    const plugin = viteSwCacherPlugin({
      pattern: ["*vk.com*", "*example.com*"],
      excludePattern: "*api.vk.com*",
    });
    plugin.configResolved?.({ base: "/" } as any);

    const bundle: any = {
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    const call = ctx.emitFile.mock.calls[0]?.[0];
    const swSource = String(call?.source ?? "");
    expect(swSource).toContain("URL_PATTERNS");
    expect(swSource).toContain("EXCLUDE_URL_PATTERNS");
    expect(swSource).toContain("vk\\\\.com");
    expect(swSource).toContain("example\\\\.com");
    expect(swSource).toContain("api\\\\.vk\\\\.com");
  });

  it("исключает .html, .map и sw-cacher.js из списка ассетов", async () => {
    const plugin = viteSwCacherPlugin({ lazyPreload: true });
    plugin.configResolved?.({ base: "/" } as any);

    const htmlAsset = createHtmlAsset("<html><head></head><body></body></html>");
    const bundle: any = {
      "index.html": htmlAsset,
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
      "assets/app.js.map": { type: "asset", fileName: "assets/app.js.map", source: "" },
      "sw-cacher.js": { type: "asset", fileName: "sw-cacher.js", source: "" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    const assets = getAssetsFromHtml(String(htmlAsset.source));
    expect(assets).toContain("/assets/main.js");
    expect(assets).not.toContain("/assets/app.js.map");
    expect(assets).not.toContain("/sw-cacher.js");
    expect(assets).not.toContain("/index.html");
  });

  it("применяет base к ассетам при lazyPreload", async () => {
    const plugin = viteSwCacherPlugin({ lazyPreload: true });
    plugin.configResolved?.({ base: "/base/" } as any);

    const htmlAsset = createHtmlAsset("<html><head></head><body></body></html>");
    const bundle: any = {
      "index.html": htmlAsset,
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    const assets = getAssetsFromHtml(String(htmlAsset.source));
    expect(assets).toContain("/base/assets/main.js");
  });

  it("не добавляет fetch при lazyPreload=false", async () => {
    const plugin = viteSwCacherPlugin({ lazyPreload: false });
    plugin.configResolved?.({ base: "/" } as any);

    const handler = getTransformHandler(plugin);
    const result = await handler?.("<html><head></head><body></body></html>");
    const tags = (result as any).tags;
    expect(tags[0].children).toContain("serviceWorker");
    expect(tags[0].children).not.toContain("fetch(");
  });

  it("заменяет плейсхолдер на скрипт при lazyPreload", async () => {
    const plugin = viteSwCacherPlugin({ lazyPreload: true });
    plugin.configResolved?.({ base: "/" } as any);

    const htmlWithPlaceholder = "<html><head><script>/*__VITE_SW_CACHER_INLINE__*/</script></head><body></body></html>";
    const htmlAsset = createHtmlAsset(htmlWithPlaceholder);
    const bundle: any = {
      "index.html": htmlAsset,
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    const outputHtml = String(htmlAsset.source);
    expect(outputHtml).not.toContain("__VITE_SW_CACHER_INLINE__");
    expect(outputHtml).toContain("serviceWorker");
  });

  it("вставляет плейсхолдер и заменяет его финальным скриптом", async () => {
    const plugin = viteSwCacherPlugin({ lazyPreload: true });
    plugin.configResolved?.({ base: "/" } as any);

    const originalHtml = "<html><head></head><body></body></html>";
    const handler = getTransformHandler(plugin);
    const transformResult = await handler?.(originalHtml);
    const htmlWithPlaceholder = applyTransformResult(originalHtml, transformResult);

    expect(htmlWithPlaceholder).toContain("__VITE_SW_CACHER_INLINE__");

    const htmlAsset = createHtmlAsset(htmlWithPlaceholder);
    const bundle: any = {
      "index.html": htmlAsset,
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    const outputHtml = String(htmlAsset.source);
    expect(outputHtml).not.toContain("__VITE_SW_CACHER_INLINE__");
    expect(outputHtml).toContain("serviceWorker");
    expect(outputHtml).toContain("fetch(");
  });

  it("работает при inlineSw и lazyPreload одновременно", async () => {
    const plugin = viteSwCacherPlugin({ inlineSw: true, lazyPreload: true });
    plugin.configResolved?.({ base: "/" } as any);

    const htmlAsset = createHtmlAsset("<html><head></head><body></body></html>");
    const bundle: any = {
      "index.html": htmlAsset,
      "assets/main.js": { type: "chunk", fileName: "assets/main.js" },
    };

    const ctx = { emitFile: vi.fn() };
    await plugin.generateBundle?.call(ctx as any, {}, bundle);

    expect(ctx.emitFile).not.toHaveBeenCalled();
    const outputHtml = String(htmlAsset.source);
    expect(outputHtml).toContain("serviceWorker");
    expect(outputHtml).toContain("fetch(");
  });
});
