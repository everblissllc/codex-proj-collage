export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Preserve the native Worker's global receiver when fetch is passed between layers.
export const workerFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
