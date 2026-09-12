import type { CopyDraft, ProductData } from "../types";
export interface CopyProvider { generate(product: ProductData): Promise<CopyDraft>; }
