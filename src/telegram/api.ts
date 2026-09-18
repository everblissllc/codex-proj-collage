import type { CardImage } from "../rendering/types";
import { workerFetch, type FetchLike } from "../network/worker-fetch";

export type TelegramDescriptionCategory =
  | "RATE_LIMIT" | "FILE_TOO_LARGE" | "INVALID_PHOTO" | "MESSAGE_TOO_LONG"
  | "CHAT_NOT_FOUND" | "BOT_BLOCKED" | "FORBIDDEN" | "BAD_REQUEST"
  | "SERVER_ERROR" | "INVALID_RESPONSE" | "NETWORK_ERROR" | "TIMEOUT" | "UNKNOWN";

export class TelegramApiError extends Error {
  constructor(
    readonly httpStatus: number | undefined,
    readonly telegramErrorCode: number | undefined,
    readonly telegramDescriptionCategory: TelegramDescriptionCategory,
    readonly telegramDescription?: string
  ) {
    super("Telegram API request failed");
    this.name = "TelegramApiError";
  }
}

export function safeTelegramDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || [...text].length > 200 || /[\r\n\u0000-\u001f\u007f]/.test(text)) return undefined;
  if (/https?:\/\/|bot\d{6,}:[A-Za-z0-9_-]{20,}|\b\d{8,}\b/i.test(text)) return undefined;
  return /^[\x20-\x7e]+$/.test(text) ? text : undefined;
}

export function telegramPhotoDiagnostics(image: CardImage): {
  mimeType: string; byteSize: number; validPng: boolean; width?: number; height?: number; telegramPhotoLimitsValid: boolean;
} {
  const bytes = image.bytes;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const validPng = bytes.length >= 24 && signature.every((byte, index) => bytes[index] === byte) &&
    String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR";
  const view = validPng ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;
  const width = view?.getUint32(16);
  const height = view?.getUint32(20);
  const validDimensions = Boolean(width && height && width + height <= 10_000 && Math.max(width, height) / Math.min(width, height) <= 20);
  return { mimeType: image.mimeType, byteSize: bytes.byteLength, validPng, width, height, telegramPhotoLimitsValid: validPng && bytes.byteLength <= 10_000_000 && validDimensions };
}

function descriptionCategory(description: unknown, status: number): TelegramDescriptionCategory {
  const text = typeof description === "string" ? description.toLowerCase() : "";
  if (status === 429 || /too many requests|retry after/.test(text)) return "RATE_LIMIT";
  if (/file is too big|file too large|photo is too big|request entity too large/.test(text) || status === 413) return "FILE_TOO_LARGE";
  if (/photo.*invalid|invalid.*photo|image.*invalid/.test(text)) return "INVALID_PHOTO";
  if (/message is too long|message text is too long/.test(text)) return "MESSAGE_TOO_LONG";
  if (/chat not found/.test(text)) return "CHAT_NOT_FOUND";
  if (/bot was blocked|bot is blocked/.test(text)) return "BOT_BLOCKED";
  if (status === 403) return "FORBIDDEN";
  if (status === 400) return "BAD_REQUEST";
  if (status >= 500) return "SERVER_ERROR";
  return "UNKNOWN";
}

export class TelegramApi {
  constructor(private readonly token: string, private readonly fetcher: FetchLike = workerFetch) {}
  private async call(method: string, body: BodyInit, headers?: HeadersInit): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", body, headers, signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      throw new TelegramApiError(undefined, undefined,
        error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name) ? "TIMEOUT" : "NETWORK_ERROR");
    }
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new TelegramApiError(response.status, undefined, response.ok ? "INVALID_RESPONSE" : descriptionCategory(undefined, response.status)); }
    const data = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
    if (!response.ok || data?.ok !== true) {
      const telegramErrorCode = typeof data?.error_code === "number" && Number.isInteger(data.error_code) ? data.error_code : undefined;
      throw new TelegramApiError(
        response.status,
        telegramErrorCode,
        data ? descriptionCategory(data.description, telegramErrorCode ?? response.status)
          : response.ok ? "INVALID_RESPONSE" : descriptionCategory(undefined, response.status),
        safeTelegramDescription(data?.description)
      );
    }
  }
  sendMessage(chatId: number, text: string, copyButton?: { label: string; text: string }): Promise<void> {
    const validCopyButton = copyButton && [...copyButton.text].length >= 1 && [...copyButton.text].length <= 256 ? copyButton : undefined;
    const reply_markup = validCopyButton ? { inline_keyboard: [[{ text: validCopyButton.label, copy_text: { text: validCopyButton.text } }]] } : undefined;
    return this.call("sendMessage", JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) }), { "content-type": "application/json" });
  }
  sendPhoto(chatId: number, image: CardImage): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    const copy = new Uint8Array(image.bytes.byteLength);
    copy.set(image.bytes);
    form.set("photo", new Blob([copy.buffer], { type: image.mimeType }), "product-card.png");
    return this.call("sendPhoto", form);
  }
}
