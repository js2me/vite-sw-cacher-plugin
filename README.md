# vite-sw-cacher-plugin

Vite 7 плагин, который инлайнит регистрацию сервис-воркера и кеширует статику с fallback на кэш при 404.

## Установка

```bash
pnpm add -D vite-sw-cacher-plugin
```

## Использование

### Базовая настройка

```ts
import { defineConfig } from "vite";
import swCacher from "vite-sw-cacher-plugin";

export default defineConfig({
  plugins: [swCacher()],
});
```

### С кастомными опциями

```ts
import { defineConfig } from "vite";
import swCacher from "vite-sw-cacher-plugin";

export default defineConfig({
  plugins: [
    swCacher({
      extensions: [".html", ".css", ".js", ".svg", ".png", ".jpg", ".gif"],
      pattern: ["*vk.com*", "*example.com*"],
      excludePattern: ["*api.vk.com*"],
      ttl: 24 * 60 * 60 * 1000,
      maxItemsCount: 200,
      cacheName: "vite-sw-cacher-plugin",
      inlineSw: false,
      lazyPreload: true,
      lazyPreloadConcurrency: 1,
      lazyPreloadBatchDelayMs: 1000,
      lazyPreloadPriorityExtensions: [".js", ".css"],
    }),
  ],
});
```

## Опции

- `extensions?`: массив расширений. По умолчанию вся статика (`.html,.css,.js,.svg,.png,.jpeg,.jpg,.gif,.webp,.avif,.bmp,.ico,.tif,.tiff`).
- `pattern?`: URL‑паттерн или массив паттернов (поддерживает `*`).
- `excludePattern?`: исключающий URL‑паттерн или массив паттернов (поддерживает `*`).
- `ttl?`: время жизни в мс, по умолчанию 24 часа.
- `maxItemsCount?`: максимум кэша. По умолчанию `кол-во статичных файлов из Vite * 2`.
- `cacheName?`: имя группы кешей, по умолчанию `vite-sw-cacher-plugin`.
- `inlineSw?`: вшивает SW в инлайн-скрипт через Blob URL (может быть ограничено CSP/браузером).
- `lazyPreload?`: лениво подгружает все статичные файлы из сборки после `load`.
- `lazyPreloadConcurrency?`: максимум параллельных загрузок, по умолчанию `3`.
- `lazyPreloadBatchDelayMs?`: пауза между пачками загрузок, по умолчанию `120`.
- `lazyPreloadPriorityExtensions?`: приоритетные расширения (по умолчанию `.js`, `.css`).
