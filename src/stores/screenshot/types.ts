import type { ProductData, StoreId } from "../../types";

export type MobileViewport = { width: number; height: number; deviceScaleFactor: number; isMobile: true; hasTouch: true };
export type ScreenshotStoreExtractionMode = "worker-html" | "browser-page";
export interface ScreenshotStoreAdapter {
  store: StoreId;
  extractionMode: ScreenshotStoreExtractionMode;
  allowsHost(hostname: string): boolean;
  extract(html: string, inputUrl: string, resolvedUrl: string): ProductData;
  inspect(html: string): Record<string, boolean>;
  viewport: MobileViewport;
  readySelector(nonce: string): string;
  screenshotSelector(nonce: string): string;
  readyScript?(nonce: string): string;
  style?: string;
  browserExtractionSelector?(nonce: string): string;
  browserExtractionScript?(nonce: string): string;
  extractBrowserResult?(json: string, inputUrl: string, resolvedUrl: string): ProductData;
  inspectBrowserResult?(json: string): Record<string, string | number | boolean | undefined>;
}
