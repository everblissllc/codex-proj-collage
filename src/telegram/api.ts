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
    readonly telegramDescriptionCategory: TelegramDescriptionCategory
  ) {
    super("Telegram API request failed");
    this.name = "TelegramApiError";
  }
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
          : response.ok ? "INVALID_RESPONSE" : descriptionCategory(undefined, response.status)
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
