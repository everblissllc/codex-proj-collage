import type { CopyProvider } from "./provider";
import { ProductError, type GeneratedContent, type ProductData } from "../types";

export type AiAttemptFailure = { attempt: number; errorCode: string; validationReason: string };
export type GeneratedCopyResult = GeneratedContent & { attemptsUsed: number };

function invalidContent(reason: string): never {
  throw new ProductError("AI_INVALID_CONTENT", "ai", "AI content failed validation", reason);
}

function validateBody(body: string, product: ProductData): void {
  const prices = [...body.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?/g)].map(match => match[0].replace(/\s/g, ""));
  const allowed = [product.currentPrice.formatted, product.oldPrice?.formatted].filter(Boolean);
  if (!body.includes(product.currentPrice.formatted)) invalidContent("AI_CURRENT_PRICE_MISMATCH");
  if (product.oldPrice && !body.includes(product.oldPrice.formatted)) {
    invalidContent(prices.some(price => price !== product.currentPrice.formatted) ? "AI_OLD_PRICE_MISMATCH" : "AI_OLD_PRICE_MISSING");
  }
  if (prices.some(price => !allowed.includes(price))) invalidContent("AI_UNEXPECTED_PRICE");
  if (/\b(?:only \d+ left|limited stock|lowest price ever|expires? (?:today|tonight))\b|\d+(?:\.\d+)?\s*%|\bsave\s+\d+/i.test(body)) invalidContent("AI_UNSUPPORTED_CLAIM");
}

function retryableValidationError(error: unknown): ProductError | undefined {
  if (!(error instanceof ProductError) || error.stage !== "ai") return undefined;
  if (error.code === "AI_INVALID_CONTENT") return error;
  if (error.code === "AI_BAD_JSON" || error.code === "AI_EMPTY_RESPONSE") {
    return new ProductError("AI_INVALID_CONTENT", "ai", "AI output failed validation", error.code);
  }
  return undefined;
}

export async function generateProductCopy(product: ProductData, provider: CopyProvider, disclosure = "#Ad", onAttemptFailed?: (failure: AiAttemptFailure) => void): Promise<GeneratedCopyResult> {
  let correctionReason: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const draft = await provider.generate(product, correctionReason);
      validateBody(draft.facebookBody, product);
      const safeDisclosure = disclosure.trim() || "#Ad";
      return {
        shortTitle: draft.shortTitle,
        facebookPost: `${safeDisclosure} 🚨 ${draft.facebookBody}\n\n👉 ${product.postUrl}`,
        attemptsUsed: attempt
      };
    } catch (error) {
      const validation = retryableValidationError(error);
      if (!validation) {
        if (error instanceof ProductError) throw error;
        throw new ProductError("AI_PROVIDER_FAILED", "ai", "Workers AI inference failed");
      }
      correctionReason = validation.validationReason ?? "AI_INVALID_CONTENT";
      onAttemptFailed?.({ attempt, errorCode: validation.code, validationReason: correctionReason });
      if (attempt === 2) throw validation;
    }
  }
  throw new ProductError("AI_PROVIDER_FAILED", "ai", "Workers AI attempts exhausted");
}
