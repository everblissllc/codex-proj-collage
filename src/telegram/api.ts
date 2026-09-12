import type { CardImage } from "../rendering/types";
import { workerFetch, type FetchLike } from "../network/worker-fetch";

export class TelegramApi {
  constructor(private readonly token: string, private readonly fetcher: FetchLike = workerFetch) {}
  private async call(method: string, body: BodyInit, headers?: HeadersInit): Promise<void> {
    const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", body, headers, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
    const result = await response.json() as { ok?: boolean };
    if (!result.ok) throw new Error(`Telegram ${method} returned ok=false`);
  }
  sendMessage(chatId: number, text: string): Promise<void> {
    return this.call("sendMessage", JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), { "content-type": "application/json" });
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
