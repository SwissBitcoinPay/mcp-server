/** A fetch for tests: each URL goes to `route`, which answers JSON (or throws: no answer). */
export type Route = (url: URL, init: RequestInit | undefined) => unknown;

export type JsonAnswer = { status?: number; json?: unknown; text?: string };

export function answer(json: unknown, status = 200): JsonAnswer {
  return { status, json };
}

export function fakeFetch(route: (url: URL) => JsonAnswer | Promise<JsonAnswer>) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    if (init?.signal?.aborted) throw init.signal.reason;
    const result = await route(url);
    const body = result.text ?? JSON.stringify(result.json);
    return new Response(body, {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
