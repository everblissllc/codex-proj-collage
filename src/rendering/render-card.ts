import { ProductError, type GeneratedContent, type ProductData } from "../types";
import { assertPublicDns, validatePublicUrl, type DnsCheck } from "../stores/safe-url";
import { resolveUrl } from "../stores/resolve-url";
import type { CardImage, ScreenshotRenderer } from "./types";
import { walmartCardHtml } from "../stores/walmart/template";
import { walmartTheme } from "../stores/walmart/theme";
import { workerFetch, type FetchLike } from "../network/worker-fetch";

async function fetchImageAsDataUrl(url: string, fetcher: FetchLike, dnsCheck: DnsCheck, requestId?: string): Promise<string> {
  validatePublicUrl(url);
  const { response } = await resolveUrl(url, fetcher, "image/webp,image/png,image/jpeg", dnsCheck);
  if (!response.ok || response.status >= 300) throw new ProductError("IMAGE_FETCH_FAILED", "render", `Image returned HTTP ${response.status}`);
  const mime = response.headers.get("content-type")?.split(";")[0].toLowerCase();
  if (!mime || !["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new ProductError("INVALID_IMAGE_TYPE", "render", `Unsupported image type ${mime}`);
  const max = 6_000_000;
  if (Number(response.headers.get("content-length")) > max) throw new ProductError("IMAGE_TOO_LARGE", "render", "Image too large");
  const reader = response.body?.getReader();
  if (!reader) throw new ProductError("IMAGE_FETCH_FAILED", "render", "Image response empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new ProductError("IMAGE_TOO_LARGE", "render", "Image too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let pos = 0;
  for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.byteLength; }
  const valid = mime === "image/png" ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) :
    mime === "image/jpeg" ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  if (!valid) throw new ProductError("INVALID_IMAGE_DATA", "render", "Product image bytes do not match its declared type");
  console.log(JSON.stringify({ event: "product_image_downloaded", requestId, hostname: new URL(url).hostname, mimeType: mime, bytes: bytes.length }));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function renderWalmartCard(product: ProductData, content: GeneratedContent, renderer: ScreenshotRenderer, fetcher: FetchLike = workerFetch, dnsCheck: DnsCheck = assertPublicDns, requestId?: string): Promise<CardImage> {
  const imageData = await fetchImageAsDataUrl(product.imageUrl, fetcher, dnsCheck, requestId);
  return renderer.screenshot(walmartCardHtml(product, content, imageData), walmartTheme.width, walmartTheme.height);
}

export async function renderCard(product: ProductData, content: GeneratedContent, renderer: ScreenshotRenderer, fetcher: FetchLike = workerFetch, dnsCheck: DnsCheck = assertPublicDns, requestId?: string): Promise<CardImage> {
  if (product.store !== "walmart") throw new ProductError("UNSUPPORTED_STORE", "store", `No template for ${product.store}`);
  try { return await renderWalmartCard(product, content, renderer, fetcher, dnsCheck, requestId); }
  catch (error) {
    if (error instanceof ProductError && error.stage === "render") throw error;
    throw new ProductError("RENDER_FAILED", "render", String(error));
  }
}
