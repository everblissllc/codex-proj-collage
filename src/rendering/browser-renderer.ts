import { ProductError } from "../types";
import type { ScreenshotRenderer, CardImage } from "./types";

export class BrowserScreenshotRenderer implements ScreenshotRenderer {
  constructor(private readonly browser: BrowserRun) {}
  async screenshot(html: string, width: number, height: number): Promise<CardImage> {
    const response = await this.browser.quickAction("screenshot", {
      html, viewport: { width, height }, screenshotOptions: { type: "png" }
    });
    if (!response.ok) throw new ProductError("BROWSER_ERROR", "render", `Browser Run returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 10_000_000) throw new ProductError("IMAGE_TOO_LARGE", "render", "Rendered card exceeds Telegram photo limit");
    if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
      throw new ProductError("BROWSER_BAD_IMAGE", "render", "Browser Run did not return a PNG");
    }
    return { bytes, mimeType: "image/png" };
  }
}
