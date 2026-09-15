import type { ProductData, GeneratedContent } from "../types";
import type { CopyProvider } from "../ai/provider";
import { generateProductCopy } from "../ai/generate-product-copy";
import type { CardImage } from "../rendering/types";
import type { MobilePageScreenshotRenderer } from "../rendering/mobile-page-renderer";
import type { ScreenshotStoreAdapter } from "../stores/screenshot/types";

export async function processScreenshotStore(product: ProductData, adapter: ScreenshotStoreAdapter, deps: {
  copyProvider: CopyProvider;
  pageRenderer: MobilePageScreenshotRenderer;
  disclosure: string;
  requestId: string;
  onAiFailure: (failure: { attempt: number; errorCode: string; validationReason: string }) => void;
}): Promise<{ content: GeneratedContent; card: CardImage; aiDurationMs: number; renderDurationMs: number; attemptsUsed: number }> {
  const aiStart = Date.now();
  const generated = await generateProductCopy(product, deps.copyProvider, deps.disclosure, deps.onAiFailure);
  const aiDurationMs = Date.now() - aiStart;
  console.log(JSON.stringify({ event: "ai_complete", requestId: deps.requestId, store: product.store, aiDurationMs, attemptsUsed: generated.attemptsUsed }));
  const renderStart = Date.now();
  const card = await deps.pageRenderer.screenshotProductPage(product.resolvedUrl, adapter, deps.requestId);
  const renderDurationMs = Date.now() - renderStart;
  return { content: generated, card, aiDurationMs, renderDurationMs, attemptsUsed: generated.attemptsUsed };
}
