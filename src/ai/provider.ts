import type { CopyDraft, ProductData } from "../types";
export interface CopyProvider { generate(product: ProductData, correctionReason?: string): Promise<CopyDraft>; }
