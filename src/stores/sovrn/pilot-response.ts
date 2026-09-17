export const SOVRN_PILOT_BUILD_HEADER = "x-sovrn-pilot-build";

export function withSovrnPilotBuildMarker(response: Response, buildId?: string): Response {
  const headers = new Headers(response.headers);
  headers.set(SOVRN_PILOT_BUILD_HEADER, buildId || "unavailable");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
