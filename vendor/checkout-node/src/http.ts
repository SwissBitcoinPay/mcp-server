import { NetworkError } from "./errors.js";
import { readJson } from "./json.js";
import { MAX_HTTP_BODY_BYTES, USER_AGENT } from "./protocol.js";
import { decodeUtf8 } from "./text.js";

const encoder = new TextEncoder();

/** How the package makes HTTP requests. */
export type HttpOptions = {
  fetch: typeof fetch;
  /** Per request, body included. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  headers?: Record<string, string>;
};

/** The host of `url`, for messages: never its path (a Lightning address's name is in it). */
export function hostOf(url: string | URL): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * GET `url` asking for JSON (SPEC.md, "HTTP"), with the User-Agent of every implementation: no
 * redirect is followed (each URL is checked before it is asked, a redirect would skip the check: it
 * is no answer), the body is read up to MAX_HTTP_BODY_BYTES, one leading byte order mark ignored.
 * Resolves with the HTTP status and the parsed body (null when it is not JSON in UTF-8). Rejects with NetworkError when there is no answer in time, a redirect or a body
 * too large, or when `signal` aborts (then with its reason).
 */
export async function getJson(
  url: string,
  options: HttpOptions
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const { status, ok, bytes } = await getBytes(url, options);
  return { status, ok, body: parseJson(bytes) };
}

/**
 * The text of an HTTP body (SPEC.md §15): UTF-8, one leading byte order mark (EF BB BF) ignored,
 * as WHATWG's UTF-8 decode does; null when it is not UTF-8.
 */
function bodyText(bytes: Uint8Array): string | null {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return decodeUtf8(bom ? bytes.subarray(3) : bytes);
}

/**
 * GET `url` as getJson does, for the one plain-text answer (an explorer's height): the body as
 * text, null when it is not UTF-8.
 */
export async function getText(
  url: string,
  options: HttpOptions
): Promise<{ status: number; ok: boolean; text: string | null }> {
  const { status, ok, bytes } = await getBytes(url, options);
  return { status, ok, text: bodyText(bytes) };
}

async function getBytes(
  url: string,
  options: HttpOptions
): Promise<{ status: number; ok: boolean; bytes: Uint8Array }> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let answer: { status: number; ok: boolean; bytes: Uint8Array | null };
  try {
    const response = await options.fetch(url, {
      headers: { ...options.headers, Accept: "application/json", "User-Agent": USER_AGENT },
      redirect: "error",
      signal
    });
    answer = { status: response.status, ok: response.ok, bytes: await readBody(response) };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new NetworkError(`No answer from ${hostOf(url)}`, { cause: error });
  }
  // fetch rejects a redirect itself; an injected one may hand it over.
  if (answer.status >= 300 && answer.status < 400) {
    throw new NetworkError(`${hostOf(url)} answered a redirect (HTTP ${answer.status})`);
  }
  if (answer.bytes === null) {
    throw new NetworkError(`${hostOf(url)} answered more than ${MAX_HTTP_BODY_BYTES} bytes`);
  }
  return { status: answer.status, ok: answer.ok, bytes: answer.bytes };
}

/**
 * The body's bytes, or null when it is larger than MAX_HTTP_BODY_BYTES (it is then dropped, unread
 * beyond). A WHATWG stream (global fetch, Bun, Deno), a Node stream (node-fetch, given as `fetch`),
 * or else the whole body.
 */
async function readBody(response: Response): Promise<Uint8Array | null> {
  const body = response.body as unknown;
  if (body === null || body === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  /** Keeps `chunk`; false once the body is too large. */
  const keep = (chunk: unknown): boolean => {
    const bytes =
      chunk instanceof Uint8Array
        ? chunk
        : typeof chunk === "string"
          ? encoder.encode(chunk)
          : null;
    if (!bytes) throw new TypeError("Unexpected chunk of an HTTP body");
    size += bytes.length;
    if (size > MAX_HTTP_BODY_BYTES) return false;
    chunks.push(bytes);
    return true;
  };
  if (typeof (body as { getReader?: unknown }).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!keep(value)) {
        await reader.cancel().catch(() => {});
        return null;
      }
    }
  } else if (typeof body === "object" && Symbol.asyncIterator in body) {
    // Leaving the loop early destroys the stream.
    for await (const chunk of body as AsyncIterable<unknown>) if (!keep(chunk)) return null;
  } else if (!keep(new Uint8Array(await response.arrayBuffer()))) {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  const text = bodyText(bytes);
  if (text === null) return null;
  try {
    return readJson(text);
  } catch {
    return null;
  }
}
