import { ProductError, type BrowserDiagnostics } from "../types";
import type { ScreenshotRenderer, CardImage } from "./types";

function safeStatusText(value: string): string | undefined {
  const standard = new Set(["Bad Request", "Request Timeout", "Payload Too Large", "Unprocessable Entity", "Too Many Requests", "Internal Server Error", "Bad Gateway", "Service Unavailable", "Gateway Timeout"]);
  return standard.has(value) ? value : undefined;
}

function browserMsUsed(response: Response): number | undefined {
  const value = response.headers.get("x-browser-ms-used");
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function boundedErrorMessage(response: Response): Promise<string> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("json") || !response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = 4096 - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object") return "";
    const errors = (parsed as { errors?: unknown }).errors;
    if (!Array.isArray(errors)) return "";
    return errors.slice(0, 3).map(error => {
      if (!error || typeof error !== "object") return "";
      const item = error as { message?: unknown; detail?: unknown };
      return [item.message, item.detail].filter((part): part is string => typeof part === "string").join(" ");
    }).join(" ").slice(0, 2048);
  } catch {
    return "";
  }
}

function classifyBrowserError(status: number, message: string): string {
  if (/timed? out|timeout|deadline exceeded/i.test(message) || status === 408 || status === 504) return "BROWSER_TIMEOUT";
  if (/rate.?limit|too many requests|quota exceeded/i.test(message) || status === 429) return "BROWSER_RATE_LIMIT";
  if (/unavailable|overloaded|capacity/i.test(message) || status === 502 || status === 503) return "BROWSER_SERVICE_UNAVAILABLE";
  if (/bad request|invalid (?:input|request|html)/i.test(message) || status === 400 || status === 413) return "BROWSER_BAD_REQUEST";
  return "BROWSER_UNKNOWN_ERROR";
}

export class BrowserScreenshotRenderer implements ScreenshotRenderer {
  constructor(private readonly browser: BrowserRun) {}

  async screenshot(html: string, width: number, height: number, requestId?: string): Promise<CardImage> {
    const started = Date.now();
    try {
      const readySelector = '.card[data-card-ready="true"]';
      const response = await this.browser.quickAction("screenshot", {
        html,
        viewport: { width, height },
        screenshotOptions: { type: "png" },
        gotoOptions: { waitUntil: "domcontentloaded", timeout: 8000 },
        waitForSelector: { selector: readySelector, visible: true, timeout: 5000 },
        selector: readySelector,
        setJavaScriptEnabled: true,
        actionTimeout: 8000,
        bestAttempt: true
      });
      if (!response.ok) {
        const message = await boundedErrorMessage(response).catch(() => "");
        const diagnostics: BrowserDiagnostics = {
          browserStatus: response.status,
          browserStatusText: safeStatusText(response.statusText),
          browserDurationMs: Date.now() - started,
          browserMsUsed: browserMsUsed(response),
          browserReason: classifyBrowserError(response.status, message)
        };
        throw new ProductError("BROWSER_ERROR", "render", `Browser Run returned HTTP ${response.status}`, undefined, diagnostics);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 10_000_000) throw new ProductError("IMAGE_TOO_LARGE", "render", "Rendered card exceeds Telegram photo limit");
      if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
        throw new ProductError("BROWSER_BAD_IMAGE", "render", "Browser Run did not return a PNG");
      }
      console.log(JSON.stringify({ event: "browser_render_complete", requestId, browserDurationMs: Date.now() - started, browserMsUsed: browserMsUsed(response), outputBytes: bytes.length, mimeType: "image/png" }));
      return { bytes, mimeType: "image/png" };
    } catch (error) {
      const diagnostics = error instanceof ProductError ? error.browserDiagnostics : undefined;
      console.error(JSON.stringify({
        event: "browser_render_failed", requestId,
        browserDurationMs: diagnostics?.browserDurationMs ?? Date.now() - started,
        browserStatus: diagnostics?.browserStatus,
        browserStatusText: diagnostics?.browserStatusText,
        browserMsUsed: diagnostics?.browserMsUsed,
        browserReason: diagnostics?.browserReason ?? (error instanceof ProductError ? error.code : "BROWSER_UNKNOWN_ERROR")
      }));
      throw error;
    }
  }
}
