import { ProductError } from "../../types";
import { readLimitedTextWithSize } from "../resolve-url";

export type HomeDepotResponseClass =
  | "SUCCESS_HTML"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "REDIRECT_ERROR"
  | "CHALLENGE_OR_INTERSTITIAL"
  | "NON_HTML"
  | "OTHER_HTTP_ERROR";

export type HomeDepotFetchDiagnostics = {
  event: "homedepot_fetch_diagnostics";
  httpStatus: number;
  responseOk: boolean;
  normalizedContentType: string;
  responseByteLength?: number;
  redirectCount: number;
  finalHostIsHomeDepot: boolean;
  challengeIndicator: boolean;
  responseClass: HomeDepotResponseClass;
};

export type HomeDepotFetchInspection = {
  diagnostics: HomeDepotFetchDiagnostics;
  html?: string;
  error?: ProductError;
};

const ERROR_BODY_LIMIT = 64 * 1024;
const HOME_DEPOT_HOST = /^(?:[a-z0-9-]+\.)*homedepot\.com$/i;
const HTML_TYPE = /^(?:text\/html|application\/xhtml\+xml)$/i;
const CHALLENGE = /access\s+denied|verify\s+(?:that\s+)?you\s+are\s+human|captcha|bot\s+challenge|unusual\s+traffic|perimeterx|security\s+challenge/i;

function contentType(response: Response): string {
  const value = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return value && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value) ? value : "unknown";
}

function finalHostIsHomeDepot(resolvedUrl: string): boolean {
  try { return HOME_DEPOT_HOST.test(new URL(resolvedUrl).hostname); }
  catch { return false; }
}

async function readBoundedErrorBody(response: Response): Promise<{ text: string; byteLength?: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", byteLength: 0 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  while (size <= ERROR_BODY_LIMIT) {
    const { done, value } = await reader.read();
    if (done) { complete = true; break; }
    if (!value) continue;
    const remaining = ERROR_BODY_LIMIT - size;
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      size = ERROR_BODY_LIMIT;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes), byteLength: complete ? size : undefined };
}

function responseClass(status: number, responseOk: boolean, isHtml: boolean, challengeIndicator: boolean): HomeDepotResponseClass {
  if (challengeIndicator) return "CHALLENGE_OR_INTERSTITIAL";
  if (responseOk && isHtml) return "SUCCESS_HTML";
  if (responseOk) return "NON_HTML";
  if (status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  if (status >= 300 && status < 400) return "REDIRECT_ERROR";
  return "OTHER_HTTP_ERROR";
}

export async function inspectHomeDepotFetchResponse(
  response: Response,
  resolvedUrl: string,
  redirectCount: number
): Promise<HomeDepotFetchInspection> {
  const normalizedContentType = contentType(response);
  const isHtml = HTML_TYPE.test(normalizedContentType);
  if (response.ok && isHtml) {
    try {
      const result = await readLimitedTextWithSize(response);
      const challengeIndicator = CHALLENGE.test(result.text);
      return {
        html: result.text,
        diagnostics: {
          event: "homedepot_fetch_diagnostics", httpStatus: response.status, responseOk: true,
          normalizedContentType, responseByteLength: result.byteLength, redirectCount,
          finalHostIsHomeDepot: finalHostIsHomeDepot(resolvedUrl), challengeIndicator,
          responseClass: responseClass(response.status, true, true, challengeIndicator)
        }
      };
    } catch (error) {
      return {
        diagnostics: {
          event: "homedepot_fetch_diagnostics", httpStatus: response.status, responseOk: true,
          normalizedContentType, redirectCount, finalHostIsHomeDepot: finalHostIsHomeDepot(resolvedUrl),
          challengeIndicator: false, responseClass: "OTHER_HTTP_ERROR"
        },
        error: error instanceof ProductError ? error : new ProductError("STORE_HTTP_ERROR", "extraction", "Home Depot response read failed")
      };
    }
  }

  let body: { text: string; byteLength?: number } = { text: "" };
  try { body = await readBoundedErrorBody(response); }
  catch { await response.body?.cancel(); }
  const challengeIndicator = CHALLENGE.test(body.text);
  const diagnostics: HomeDepotFetchDiagnostics = {
    event: "homedepot_fetch_diagnostics", httpStatus: response.status, responseOk: response.ok,
    normalizedContentType, responseByteLength: body.byteLength, redirectCount,
    finalHostIsHomeDepot: finalHostIsHomeDepot(resolvedUrl), challengeIndicator,
    responseClass: responseClass(response.status, response.ok, isHtml, challengeIndicator)
  };
  const error = response.ok
    ? new ProductError("NOT_HTML", "extraction", `Unexpected content type ${normalizedContentType}`)
    : new ProductError("STORE_HTTP_ERROR", "extraction", `Store returned HTTP ${response.status}`);
  return { diagnostics, error };
}
