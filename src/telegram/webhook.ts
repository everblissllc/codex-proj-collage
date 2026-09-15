import { ProductError } from "../types";
import { findProductUrl, validatePublicUrl, type UrlEntity } from "../stores/safe-url";
import { WorkersAICopyProvider } from "../ai/workers-ai-provider";
import { BrowserScreenshotRenderer } from "../rendering/browser-renderer";
import { BrowserMobilePageRenderer } from "../rendering/mobile-page-renderer";
import { processProductLink } from "../orchestration/process-product-link";
import { TelegramApi, TelegramApiError } from "./api";
import { workerFetch } from "../network/worker-fetch";
import { D1R2CardCache, cardCacheTtlSeconds } from "../cache/card-cache";

export type Env = {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  AI: Ai;
  AI_TEXT_MODEL: string;
  AFFILIATE_DISCLOSURE: string;
  BROWSER: ConstructorParameters<typeof BrowserScreenshotRenderer>[0];
  PRODUCT_JOBS: Queue<TelegramJob>;
  CARD_CACHE_DB?: D1Database;
  CARD_CACHE_BUCKET?: R2Bucket;
  CARD_CACHE_TTL_SECONDS?: string;
};
type TelegramUpdate = { message?: { text?: string; caption?: string; entities?: UrlEntity[]; caption_entities?: UrlEntity[]; chat?: { id?: number }; from?: { id?: number } } };
export type TelegramJob = { chatId: number; telegramUserId?: number; inputUrl: string; requestId: string };

function secretMatches(actual: string | null, expected: string): boolean {
  if (!actual || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function telegramErrorMessage(error: unknown): string {
  if (!(error instanceof ProductError)) return "Something went wrong creating the card. Please try again.";
  if (["INVALID_URL", "UNSAFE_URL"].includes(error.code)) return "Please send a valid product link.";
  if (error.code === "DNS_CHECK_FAILED") return "I couldn't open that link. Please try another product link.";
  if (error.code === "UNSUPPORTED_STORE") return "That store isn't supported yet.";
  if (["FETCH_FAILED", "REDIRECT_LOOP", "TOO_MANY_REDIRECTS", "REDIRECT_MISSING_LOCATION"].includes(error.code)) return "I couldn't open that link. Please try another product link.";
  if (error.code === "MISSING_PRICE") return "I found the product, but couldn't reliably determine its current price.";
  if (error.stage === "ai") return "I found the product but couldn't generate the card text. Please try again.";
  if (error.stage === "render") return "I found the product but couldn't generate the image.";
  if (error.stage === "extraction") return "I found the Walmart page but couldn't read the product information.";
  return "Please send a valid product link.";
}

export async function handleTelegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!secretMatches(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TELEGRAM_WEBHOOK_SECRET)) return new Response("Unauthorized", { status: 401 });
  if (Number(request.headers.get("content-length")) > 100_000) return new Response("Payload too large", { status: 413 });
  let update: TelegramUpdate;
  try {
    const body = await request.text();
    if (body.length > 100_000) return new Response("Payload too large", { status: 413 });
    update = JSON.parse(body) as TelegramUpdate;
  } catch { return new Response("Bad request", { status: 400 }); }
  const chatId = update.message?.chat?.id;
  if (typeof chatId !== "number") return new Response("ok");
  const telegram = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  const message = update.message?.text ?? update.message?.caption ?? "";
  const inputUrl = findProductUrl(message, update.message?.text ? update.message.entities : update.message?.caption_entities);
  if (!inputUrl) {
    ctx.waitUntil(telegram.sendMessage(chatId, "Please send a valid product link."));
    return new Response("ok");
  }
  try { validatePublicUrl(inputUrl); }
  catch {
    ctx.waitUntil(telegram.sendMessage(chatId, "Please send a valid product link."));
    return new Response("ok");
  }
  try {
    const requestId = crypto.randomUUID();
    await env.PRODUCT_JOBS.send({ chatId, telegramUserId: update.message?.from?.id, inputUrl, requestId });
    console.log(JSON.stringify({ event: "webhook_accepted", requestId, telegramUserId: update.message?.from?.id }));
  } catch (error) {
    console.error(JSON.stringify({ event: "queue_send_failed", errorCode: "QUEUE_SEND_FAILED" }));
    return new Response("Queue unavailable", { status: 503 });
  }
  return new Response("ok");
}

export async function processTelegramJob(job: TelegramJob, env: Env): Promise<void> {
  const { chatId, inputUrl, requestId, telegramUserId } = job;
  const telegram = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  console.log(JSON.stringify({ event: "queue_job_started", requestId, telegramUserId }));
  const deliveryDiagnostics = (error: unknown) => error instanceof TelegramApiError
    ? { httpStatus: error.httpStatus, telegramErrorCode: error.telegramErrorCode, telegramDescriptionCategory: error.telegramDescriptionCategory }
    : { telegramDescriptionCategory: "UNKNOWN" };
  const sendErrorMessage = async (message: string): Promise<void> => {
    try {
      await telegram.sendMessage(chatId, message);
    } catch (error) {
      console.error(JSON.stringify({ event: "telegram_error_message_failed", requestId, operation: "send_error_message", errorCode: "TELEGRAM_API_ERROR", ...deliveryDiagnostics(error) }));
    }
  };
  const logDeliveryFailure = (operation: "send_progress" | "send_photo" | "send_copy", error: unknown): void => {
    console.error(JSON.stringify({ event: "telegram_delivery_failed", requestId, operation, errorCode: "TELEGRAM_API_ERROR", ...deliveryDiagnostics(error) }));
  };
  try {
    await telegram.sendMessage(chatId, "⏳ Creating your product card...");
  } catch (error) {
    logDeliveryFailure("send_progress", error);
  }
  let result: Awaited<ReturnType<typeof processProductLink>>;
  try {
    result = await processProductLink(inputUrl, {
      fetcher: workerFetch,
      copyProvider: new WorkersAICopyProvider(env.AI, env.AI_TEXT_MODEL),
      renderer: new BrowserScreenshotRenderer(env.BROWSER),
      pageRenderer: new BrowserMobilePageRenderer(env.BROWSER),
      disclosure: env.AFFILIATE_DISCLOSURE || "#Ad",
      requestId,
      telegramUserId,
      cardCache: env.CARD_CACHE_DB && env.CARD_CACHE_BUCKET
        ? new D1R2CardCache(env.CARD_CACHE_DB, env.CARD_CACHE_BUCKET, cardCacheTtlSeconds(env.CARD_CACHE_TTL_SECONDS))
        : undefined
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "job_processing_failed", requestId, telegramUserId, errorStage: error instanceof ProductError ? error.stage : "unknown", errorCode: error instanceof ProductError ? error.code : "UNEXPECTED_ERROR", validationReason: error instanceof ProductError ? error.validationReason : undefined, ...(error instanceof ProductError ? error.browserDiagnostics : undefined) }));
    await sendErrorMessage(telegramErrorMessage(error));
    return;
  }
  try {
    await telegram.sendPhoto(chatId, result.card);
    console.log(JSON.stringify({ event: "telegram_photo_sent", requestId, telegramUserId }));
  } catch (error) {
    logDeliveryFailure("send_photo", error);
    await sendErrorMessage("Your card was created, but I couldn't send the image. Please try again.");
    return;
  }
  try {
    await telegram.sendMessage(chatId, `✅ Facebook post:\n\n${result.content.facebookPost}`);
    console.log(JSON.stringify({ event: "telegram_copy_sent", requestId, telegramUserId, success: true }));
  } catch (error) {
    logDeliveryFailure("send_copy", error);
    await sendErrorMessage("Your card was sent, but I couldn't send the Facebook post text. Please try again.");
  }
}
