export type CardImage = { bytes: Uint8Array; mimeType: "image/png" };
export interface ScreenshotRenderer {
  screenshot(html: string, width: number, height: number, requestId?: string): Promise<CardImage>;
}
