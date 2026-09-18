import type { CopyProvider } from "./provider";
import { ProductError, type GeneratedContent, type ProductData } from "../types";
import { buildFacebookComment, buildFacebookPost } from "./build-facebook-post";

export type AiAttemptFailure = { attempt: number; errorCode: string; validationReason: string };
export type GeneratedCopyResult = GeneratedContent & { attemptsUsed: number };

function retryableValidationError(error: unknown): ProductError | undefined {
  if (!(error instanceof ProductError) || error.stage !== "ai") return undefined;
  if (error.code === "AI_INVALID_CONTENT") return error;
  if (error.code === "AI_BAD_JSON" || error.code === "AI_EMPTY_RESPONSE") {
    return new ProductError("AI_INVALID_CONTENT", "ai", "AI output failed validation", error.code);
  }
  return undefined;
}

export async function generateProductCopy(product: ProductData, provider: CopyProvider, _disclosure = "#Ad", onAttemptFailed?: (failure: AiAttemptFailure) => void): Promise<GeneratedCopyResult> {
  let correctionReason: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const draft = await provider.generate(product.rawTitle, correctionReason);
      return {
        shortTitle: draft.shortTitle,
        facebookPost: buildFacebookPost(product, draft.shortTitle, draft.facebookHookTemplate),
        facebookComment: buildFacebookComment(product),
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
