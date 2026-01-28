import { describe, expect, it, vi } from "vitest";
import { viteSwCacherPlugin } from "../src/index";

vi.mock("../src/templates/sw.ejs", () => ({
  default: "self.addEventListener(\"install\",()=>{});",
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

    const result = await plugin.transformIndexHtml?.("<html><head></head><body></body></html>");
    expect(result).toBeTruthy();
    const tags = (result as any).tags;
    expect(Array.isArray(tags)).toBe(true);
    expect(tags[0].children).toContain("serviceWorker");
  });

  it("использует base при регистрации SW", async () => {
    const plugin = viteSwCacherPlugin();
    plugin.configResolved?.({ base: "/app/" } as any);

    const result = await plugin.transformIndexHtml?.("<html><head></head><body></body></html>");
    const tags = (result as any).tags;
    expect(tags[0].children).toContain("/app/sw-cacher.js");
  });

  it("для inlineSw возвращает плейсхолдер в transformIndexHtml", async () => {
    const plugin = viteSwCacherPlugin({ inlineSw: true });
    plugin.configResolved?.({ base: "/" } as any);

    const result = await plugin.transformIndexHtml?.("<html><head></head><body></body></html>");
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

    const result = await plugin.transformIndexHtml?.("<html><head></head><body></body></html>");
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
