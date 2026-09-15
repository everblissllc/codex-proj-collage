import type { StoreId } from "../../types";
import { elfAdapter } from "./elf";
import type { ScreenshotStoreAdapter } from "./types";

const adapters: Partial<Record<StoreId, ScreenshotStoreAdapter>> = { elf: elfAdapter };
export function screenshotStore(store: StoreId): ScreenshotStoreAdapter | undefined { return adapters[store]; }
