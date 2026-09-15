import { ProductError } from "../types";
import { validatePublicUrl } from "../stores/safe-url";
import type { ScreenshotStoreAdapter } from "../stores/screenshot/types";
import { BrowserScreenshotRenderer } from "./browser-renderer";
import type { CardImage } from "./types";

export interface MobilePageScreenshotRenderer {
  screenshotProductPage(url: string, adapter: ScreenshotStoreAdapter, requestId?: string): Promise<CardImage>;
}

export class BrowserMobilePageRenderer extends BrowserScreenshotRenderer implements MobilePageScreenshotRenderer {
  async screenshotProductPage(url: string, adapter: ScreenshotStoreAdapter, requestId?: string): Promise<CardImage> {
    const target = validatePublicUrl(url);
    if (!adapter.allowsHost(target.hostname)) throw new ProductError("UNSAFE_SCREENSHOT_URL", "render", "Screenshot target is outside the store");
    const nonce = crypto.randomUUID().replace(/-/g, "");
    console.log(JSON.stringify({ event: "mobile_product_screenshot_started", requestId, store: adapter.store, hostname: target.hostname, width: adapter.viewport.width, height: adapter.viewport.height }));
    return this.capture({
      url: target.href,
      viewport: adapter.viewport,
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 20000 },
      waitForSelector: { selector: adapter.readySelector(nonce), visible: true, timeout: 12000 },
      selector: adapter.screenshotSelector(nonce),
      screenshotOptions: { type: "png" },
      setJavaScriptEnabled: true,
      addScriptTag: adapter.readyScript ? [{ content: adapter.readyScript(nonce) }] : undefined,
      addStyleTag: adapter.style ? [{ content: adapter.style }] : undefined,
      actionTimeout: 15000,
      bestAttempt: false,
      cacheTTL: 0
    }, requestId, true);
  }
}
