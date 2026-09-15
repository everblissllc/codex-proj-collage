import type { StoreId } from "../../types";
import { elfAdapter } from "./elf";
import { bubbleAdapter } from "./bubble";
import type { ScreenshotStoreAdapter } from "./types";

const adapters: Partial<Record<StoreId, ScreenshotStoreAdapter>> = { elf: elfAdapter, bubble: bubbleAdapter };
export function screenshotStore(store: StoreId): ScreenshotStoreAdapter | undefined { return adapters[store]; }
