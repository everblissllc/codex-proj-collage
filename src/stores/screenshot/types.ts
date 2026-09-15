import type { ProductData, StoreId } from "../../types";

export type MobileViewport = { width: number; height: number; deviceScaleFactor: number; isMobile: true; hasTouch: true };
export interface ScreenshotStoreAdapter {
  store: StoreId;
  allowsHost(hostname: string): boolean;
  extract(html: string, inputUrl: string, resolvedUrl: string): ProductData;
  inspect(html: string): Record<string, boolean>;
  viewport: MobileViewport;
  readySelector(nonce: string): string;
  screenshotSelector(nonce: string): string;
  readyScript?(nonce: string): string;
  style?: string;
}
