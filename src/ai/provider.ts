import type { CopyDraft } from "../types";
export interface CopyProvider { generate(rawTitle: string, correctionReason?: string): Promise<CopyDraft>; }
