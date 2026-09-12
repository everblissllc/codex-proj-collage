import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { detectStore } from "../src/stores/detect-store";
import { resolveUrl } from "../src/stores/resolve-url";
import { validatePublicUrl } from "../src/stores/safe-url";
import { extractWalmartProduct } from "../src/stores/walmart/extractor";
import { normalizePrice } from "../src/stores/walmart/price";
import { parseCopyDraft, parseWorkersAIResponse } from "../src/ai/workers-ai-provider";
import { generateProductCopy } from "../src/ai/generate-product-copy";
import { walmartCardHtml } from "../src/stores/walmart/template";
import { processProductLink } from "../src/orchestration/process-product-link";
import type { ProductData } from "../src/types";

const withWas = readFileSync(new URL("./fixtures/walmart-with-was.html", import.meta.url), "utf8");
const currentOnly = readFileSync(new URL("./fixtures/walmart-current-only.html", import.meta.url), "utf8");
const input = "https://affiliate.example.org/go?id=abc";
const walmart = "https://www.walmart.com/ip/123";

describe("store and safe redirects", () => {
  it("detects Walmart and normalized future stores without guessing", () => {
    expect(detectStore("https://www.walmart.com/ip/123")).toBe("walmart");
    expect(detectStore("https://amzn.to/xyz")).toBe("amazon");
    expect(detectStore("https://notwalmart.com/ip/123")).toBeUndefined();
  });
  it("resolves a short affiliate URL one validated hop at a time", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: walmart } })).mockResolvedValueOnce(new Response(withWas, { status: 200, headers: { "content-type": "text/html" } }));
    const page = await resolveUrl(input, mock, undefined, async () => {});
    expect(page.resolvedUrl).toBe(walmart);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });
  it("rejects redirects into private or metadata hosts", async () => {
    expect(() => validatePublicUrl("http://127.0.0.1/")).toThrow();
    expect(() => validatePublicUrl("http://169.254.169.254/latest/meta-data")).toThrow();
    const mock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://10.0.0.5/" } }));
    await expect(resolveUrl(input, mock, undefined, async () => {})).rejects.toMatchObject({ code: "UNSAFE_URL" });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("Walmart extraction", () => {
  it("reads structured current and explicit old prices", () => {
    const product = extractWalmartProduct(withWas, input, walmart);
    expect(product.rawTitle).toContain("Toniebox Audio Player");
    expect(product.currentPrice).toEqual({ value: 59, formatted: "$59.00", currency: "USD" });
    expect(product.oldPrice?.formatted).toBe("$99.00");
    expect(product.inputUrl).toBe(input);
    expect(product.canonicalProductUrl).toBe(walmart);
  });
  it("leaves old price absent when no genuine old price exists", () => {
    const product = extractWalmartProduct(currentOnly, input, walmart);
    expect(product.currentPrice.formatted).toBe("$59.00");
    expect(product.oldPrice).toBeUndefined();
  });
  it("rejects malformed or missing prices", () => {
    expect(() => normalizePrice("$59.00–$99.00")).toThrow();
    expect(() => extractWalmartProduct(currentOnly.replace("59.00", "Call for price"), input, walmart)).toThrowError(expect.objectContaining({ code: "MISSING_PRICE" }));
  });
  it("rejects missing product images", () => {
    expect(() => extractWalmartProduct(currentOnly.replace(/<meta property="og:image"[^>]+>/, ""), input, walmart)).toThrowError(expect.objectContaining({ code: "MISSING_IMAGE" }));
  });
});

describe("copy and rendering", () => {
  const product = extractWalmartProduct(withWas, input, walmart);
  it("rejects invalid AI structured content", () => {
    expect(() => parseCopyDraft({ shortTitle: "Now $59", facebookBody: "Buy it" })).toThrow();
    expect(() => parseCopyDraft({ shortTitle: "Good title", facebookBody: "https://wrong.link" })).toThrow();
    expect(() => parseCopyDraft(JSON.parse("{}"))).toThrow();
  });
  it("rejects malformed Workers AI JSON", () => {
    expect(() => parseWorkersAIResponse({ response: "not json" })).toThrow();
  });
  it("appends the exact original affiliate URL after the model body", async () => {
    const content = await generateProductCopy(product, { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set with Elsa", facebookBody: "Disney Toniebox Starter Set with Elsa is now $59.00, was $99.00." }) }, "#Ad");
    expect(content.facebookPost.endsWith(input)).toBe(true);
    expect(content.facebookPost).not.toContain(walmart);
  });
  it("shrinks and clamps long titles in the controlled template", () => {
    const html = walmartCardHtml(product, { shortTitle: "Disney Toniebox Starter Set with Elsa and More Long Product Description Words", facebookPost: "" }, "data:image/png;base64,AAAA");
    expect(html).toContain("font-size:49px");
    expect(html).toContain("-webkit-line-clamp:3");
    expect(html).toContain("object-fit:contain");
  });
  it("hides an absent old price", () => {
    const html = walmartCardHtml({ ...product, oldPrice: undefined }, { shortTitle: "Disney Toniebox Starter Set", facebookPost: "" }, "data:image/png;base64,AAAA");
    expect(html).not.toContain("<span class=\"old-price\">");
  });
});

describe("orchestration", () => {
  const renderer = { screenshot: vi.fn(async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" as const })) };
  const copyProvider = { generate: vi.fn(async () => ({ shortTitle: "Disney Toniebox Starter Set", facebookBody: "Disney Toniebox Starter Set is now $59.00, was $99.00." })) };
  it("rejects unsupported stores with no extraction or AI call", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("html", { status: 200 }));
    await expect(processProductLink("https://example.org/p/1", { fetcher, dnsCheck: async () => {}, copyProvider, renderer, disclosure: "#Ad", requestId: "test" })).rejects.toMatchObject({ code: "UNSUPPORTED_STORE" });
    expect(copyProvider.generate).not.toHaveBeenCalled();
  });
  it("processes a redirected Walmart page and renders once", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: walmart } }))
      .mockResolvedValueOnce(new Response(withWas, { status: 200, headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200, headers: { "content-type": "image/png" } }));
    const result = await processProductLink(input, { fetcher, dnsCheck: async () => {}, copyProvider, renderer, disclosure: "#Ad", requestId: "test" });
    expect(result.product.resolvedUrl).toBe(walmart);
    expect(result.content.facebookPost.endsWith(input)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(renderer.screenshot).toHaveBeenCalledTimes(1);
  });
});
