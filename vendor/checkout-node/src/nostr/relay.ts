import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { readJson } from "../json.js";
import { AUTH_KIND, COMPLETE_READ_LIMIT, MAX_EVENTS_PER_QUERY, MAX_PAGES } from "../protocol.js";
import { secureRandomBytes, type RandomBytes } from "../random.js";

import { publicKeyOf, signEvent, type NostrEvent } from "./event.js";

/*
 * Nostr relay client (NIP-01, NIP-42; SPEC.md, "Relays"), ported from the merchant's app.
 * An integration's server lives for one call (it starts, makes an invoice, stops): a RelayPool
 * opens one connection per relay for that call, every read and write of the call goes over it,
 * and it is closed once the call is done. Every relay of a list in parallel; a call goes on as soon
 * as a majority of them answered (any two majorities of one list share a relay). Subscription ids
 * are random: what a relay receives names nothing of the integration (SPEC.md, "Relays").
 */

/**
 * The WebSocket API the client uses: the `ws` package's, or the WHATWG one (Bun, Deno). Its
 * handlers take `never` so that any implementation's own event types fit; the client reads
 * `data` of a message event only.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: never) => void) | null;
  onmessage: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
  onclose: ((event: never) => void) | null;
}

/** Opens a WebSocket to a relay's URL. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** A NIP-01 subscription filter, as far as the package uses it. */
export type RelayFilter = {
  kinds?: number[];
  authors?: string[];
  "#d"?: string[];
  /** A witness's order tag (SPEC.md, "Witnesses"). */
  "#o"?: string[];
  since?: number;
  until?: number;
  limit?: number;
};

export type PoolOptions = {
  createSocket: WebSocketFactory;
  /** Per request (a page of a read, a write), the wait for the connection included. */
  timeoutMs: number;
  /** Aborts every request of the pool. */
  signal?: AbortSignal | undefined;
  random?: RandomBytes | undefined;
  /** The clock, in Unix seconds: the date of NIP-42 authentication events. */
  now: () => number;
};
/** NIP-42 prefix of a refusal that authentication may lift. */
const AUTH_REQUIRED = "auth-required:";
/** `WebSocket.CONNECTING`, as a literal. */
const CONNECTING = 0;

type Message = unknown[];

/** A relay's refusal of an event (NIP-01 `OK` false), with its reason. */
export class RelayRefusal extends Error {
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`${url} refused the event: ${reason}`);
    this.name = "RelayRefusal";
    this.reason = reason;
  }
}

/**
 * What a read keeps of an event a relay sent (SPEC.md §13), as it comes: what it opens to, or the
 * event itself, when it opens; undefined drops it. Its id and its date are kept anyway, to page the
 * read and count each event once; so what a relay sends never piles up.
 */
export type Keep = (value: unknown) => unknown;

/** What a read keeps of an event, as it comes: its id and its date, and what `Keep` gave. */
export type Entry = { id: string | null; createdAt: number | null; value?: unknown };

/**
 * The entry of `value`: its `id` when it is a string (a long one by its SHA-256: an id is 64
 * characters), its `created_at` when it is a safe integer, and what `keep` keeps of it, if any.
 * `read` holds the ids of the query so far: an event of one of them again (a copy, or a forgery: an
 * id is its event's hash) is counted, never kept nor checked again (SPEC.md §13, "Limits").
 */
export function entryOf(value: unknown, keep: Keep, read?: Set<string>): Entry {
  const v = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const id =
    typeof v.id !== "string"
      ? null
      : v.id.length <= 64
        ? v.id
        : `#${bytesToHex(sha256(utf8ToBytes(v.id)))}`;
  const createdAt = Number.isSafeInteger(v.created_at) ? (v.created_at as number) : null;
  if (id !== null && read !== undefined) {
    if (read.has(id)) return { id, createdAt };
    read.add(id);
  }
  const kept = keep(value);
  return kept === undefined ? { id, createdAt } : { id, createdAt, value: kept };
}

/**
 * One page of a complete read (SPEC.md, "Complete reads"), read: what the read asks next (the
 * page's `until`), or how it ends. `seen` holds the ids of the read so far; the page's new ones are
 * added to it, and the events kept of them to `kept`.
 */
export function afterCompletePage(
  answer: readonly Entry[],
  seen: Set<string>,
  kept: unknown[],
  pagesRead: number
): { until: number } | { complete: boolean } {
  let oldest: number | null = null;
  let fresh = false;
  for (const entry of answer) {
    if (entry.id === null) continue;
    if (entry.createdAt !== null) {
      oldest = oldest === null ? entry.createdAt : Math.min(oldest, entry.createdAt);
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if ("value" in entry) kept.push(entry.value);
    // New, dated or not (SPEC.md §13: "no event not seen before"): the next page may hold more.
    fresh = true;
  }
  // More than asked: the relay ignored the limit, and what it left out cannot be told.
  if (answer.length > COMPLETE_READ_LIMIT) return { complete: false };
  if (answer.length < COMPLETE_READ_LIMIT) return { complete: true };
  // Full: the next page from its oldest second, unless it cannot move on.
  if (oldest === null || !fresh || pagesRead >= MAX_PAGES) return { complete: false };
  return { until: oldest };
}

/**
 * One page of a paged read (SPEC.md, "Paged reads"), read: the `until` of the next page, or null
 * when the read ends there. Only an event's string id and safe integer date page the read, whatever
 * else it holds; one without them is not kept. `seen` holds the ids of the read so far; the page's
 * new ones are added to it, and the events kept of them to `kept`.
 */
export function afterPagedPage(
  answer: readonly Entry[],
  seen: Set<string>,
  kept: unknown[]
): number | null {
  let oldest: number | null = null;
  let fresh = false;
  for (const entry of answer) {
    if (entry.id === null || entry.createdAt === null) continue;
    oldest = oldest === null ? entry.createdAt : Math.min(oldest, entry.createdAt);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if ("value" in entry) kept.push(entry.value);
    fresh = true;
  }
  if (oldest === null) return null;
  // Nothing new: the oldest second again would bring the same page.
  return fresh ? oldest : oldest - 1;
}

/**
 * Asks one relay a page of a read: the entries of its events (entryOf), for the page whose `until`
 * is given (undefined: the first page, as the filter has it). Rejects when the page fails (a
 * timeout, a closed connection, a CLOSED).
 */
export type PageQuery = (until: number | undefined) => Promise<Entry[]>;

/**
 * One relay's paged read (SPEC.md, "Paged reads"): page after page from `until`, at most MAX_PAGES,
 * each read through afterPagedPage; the events it keeps go to `events` as its pages come (what it
 * sent so far, should the read be cut). A failure after the first page ends the read with what it
 * read; a failure of the first page, or once `signal` aborted, rejects: the relay failed.
 */
export async function readPages(
  ask: PageQuery,
  until: number | undefined,
  events: unknown[],
  signal?: AbortSignal
): Promise<unknown[]> {
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let answer: Entry[];
    try {
      answer = await ask(until);
    } catch (error) {
      // A relay that stops answering after its first page keeps what it sent.
      if (page === 0 || signal?.aborted) throw error;
      break;
    }
    const next = afterPagedPage(answer, seen, events);
    if (next === null) break;
    until = next;
  }
  return events;
}

/**
 * One relay's complete read (SPEC.md, "Complete reads"): page after page from `until`, each read
 * through afterCompletePage, until it ends complete or not; the events it keeps go to `events` as
 * its pages come (what it sent so far, should the read be cut). A failure after the first page
 * ends the read incomplete; a failure of the first page, or once `signal` aborted, rejects: the
 * relay failed.
 */
export async function readCompletely(
  ask: PageQuery,
  until: number | undefined,
  events: unknown[],
  signal?: AbortSignal
): Promise<{ events: unknown[]; complete: boolean }> {
  const seen = new Set<string>();
  for (let page = 1; ; page += 1) {
    let answer: Entry[];
    try {
      answer = await ask(until);
    } catch (error) {
      if (page === 1 || signal?.aborted) throw error;
      return { events, complete: false };
    }
    const next = afterCompletePage(answer, seen, events, page);
    if ("complete" in next) return { events, complete: next.complete };
    until = next.until;
  }
}

/**
 * What a read of a list gives: the events of each relay that answered, and whether a majority of
 * the list answered (readOutcome). On every relay (SPEC.md §13), the pages that a relay still
 * reading had sent too: it has not answered, its events count all the same.
 */
export type RelayAnswers = {
  answers: Map<string, unknown[]>;
  /**
   * Whether a majority of the list answered (their reads ended: a relay still reading never did):
   * else the read is no answer (`network`), never an absence.
   */
  answered: boolean;
};

/** What a complete read of a list gives: as RelayAnswers, and whether it is complete. */
export type CompleteAnswers = RelayAnswers & {
  /** Whether a majority of the list read completely (SPEC.md, "Complete reads"). */
  complete: boolean;
};

/**
 * What one relay's read of a list is (SPEC.md §13): ended, complete or not (for a read that is not
 * a complete read, any read that ended is complete), failed, or still reading.
 */
export type RelayState = "complete" | "incomplete" | "failed" | "reading";

/**
 * Of a read of a list, from what each relay's read is: how many answered (their read ended,
 * complete or not: a relay still reading never did, whatever pages it sent), how many read
 * completely, and how many are over (answered or failed).
 */
export function tally(states: Iterable<RelayState>): {
  answered: number;
  complete: number;
  settled: number;
} {
  let answered = 0;
  let complete = 0;
  let settled = 0;
  for (const state of states) {
    if (state === "complete" || state === "incomplete") answered += 1;
    if (state === "complete") complete += 1;
    if (state !== "reading") settled += 1;
  }
  return { answered, complete, settled };
}

/**
 * What a read of a list gives once it goes on (SPEC.md §13), from what the read of each relay of
 * the list is then: whether a majority of the list answered (their reads ended, complete or not: a
 * relay still reading never did, whatever pages it sent), else the read is no answer (`network`);
 * and whether a majority read completely, which makes a complete read complete.
 */
export function readOutcome(states: Iterable<RelayState>): {
  answered: boolean;
  complete: boolean;
} {
  const list = [...states];
  const needed = majority(list.length);
  const { answered, complete } = tally(list);
  return { answered: answered >= needed, complete: complete >= needed };
}

/** The events kept of `entries`, in their order. */
function keptOf(entries: readonly Entry[]): unknown[] {
  return entries.flatMap((entry) => ("value" in entry ? [entry.value] : []));
}

/** Does nothing: what a socket's handlers become once its connection is closed. */
const ignore = () => {};

/** More than half of `count` relays: any two majorities of one list share a relay. */
export function majority(count: number): number {
  return Math.floor(count / 2) + 1;
}

/** One connection to one relay, shared by every request of a pool. */
class Connection {
  readonly #socket: WebSocketLike;
  readonly #listeners = new Set<(message: Message) => void>();
  readonly #deathListeners = new Set<(error: Error) => void>();
  /** NIP-42 answers, by public key and challenge: one AUTH per key per challenge. */
  readonly #auths = new Map<string, Promise<boolean>>();
  #challenge: string | null = null;
  #dead: Error | null = null;
  readonly opened: Promise<void>;

  constructor(
    readonly url: string,
    socket: WebSocketLike
  ) {
    this.#socket = socket;
    let opened = () => {};
    this.opened = new Promise<void>((resolve, reject) => {
      opened = resolve;
      this.#deathListeners.add(reject);
    });
    // Waited for by each request, which reports the failure itself.
    this.opened.catch(ignore);
    socket.onopen = () => opened();
    socket.onerror = () => this.#die(new Error(`${url}: connection failed`));
    socket.onclose = () => this.#die(new Error(`${url}: connection closed`));
    socket.onmessage = (event: { data: unknown }) => {
      let message: unknown;
      try {
        message = readJson(String(event.data));
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      if (message[0] === "AUTH" && typeof message[1] === "string") this.#challenge = message[1];
      for (const listener of [...this.#listeners]) listener(message);
    };
  }

  /** Hears every message of the relay until the returned function is called. */
  listen(listener: (message: Message) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Hears the end of the connection (now, when it is over already). */
  onDeath(listener: (error: Error) => void): () => void {
    if (this.#dead) {
      listener(this.#dead);
      return ignore;
    }
    this.#deathListeners.add(listener);
    return () => this.#deathListeners.delete(listener);
  }

  send(message: Message): void {
    if (this.#dead) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch (error) {
      this.#die(new Error(`${this.url}: connection failed`, { cause: error }));
    }
  }

  /**
   * Answers the relay's NIP-42 challenge with `authKey`: whether the relay took it. One AUTH per key
   * and challenge, shared by the requests that ask for it.
   */
  authenticate(authKey: Uint8Array, createdAt: number, random: RandomBytes): Promise<boolean> {
    const challenge = this.#challenge;
    if (this.#dead || challenge === null) return Promise.resolve(false);
    const id = `${publicKeyOf(authKey)}:${challenge}`;
    let answer = this.#auths.get(id);
    if (!answer) {
      const auth = signEvent(
        {
          kind: AUTH_KIND,
          created_at: createdAt,
          tags: [
            ["relay", this.url],
            ["challenge", challenge]
          ],
          content: ""
        },
        authKey,
        random
      );
      answer = new Promise<boolean>((done) => {
        const stopDeath = this.onDeath(() => done(false));
        const stop = this.listen((message) => {
          if (message[0] !== "OK" || message[1] !== auth.id) return;
          stop();
          stopDeath();
          done(message[2] === true);
        });
      });
      this.#auths.set(id, answer);
      this.send(["AUTH", auth]);
    }
    return answer;
  }

  /** Closes the connection; every request still on it fails. */
  close(): void {
    // Never null: the `ws` package emits an "error" when a socket closed while it connects aborts
    // its handshake, and an EventEmitter without a listener throws it (an uncaught exception, which
    // ends a Node process).
    const socket = this.#socket;
    socket.onmessage = socket.onerror = socket.onclose = ignore;
    socket.onopen = socket.readyState === CONNECTING ? () => socket.close() : ignore;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    this.#die(new Error(`${this.url}: connection closed`));
  }

  #die(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    this.#listeners.clear();
    for (const listener of [...this.#deathListeners]) listener(error);
    this.#deathListeners.clear();
  }
}

/**
 * The relays of one call: one connection per relay, opened at its first request, kept for the
 * call's next requests, closed by `close` or `release`. Requests are bounded by `timeoutMs` each.
 */
export class RelayPool {
  readonly #options: PoolOptions;
  readonly #random: RandomBytes;
  readonly #connections = new Map<string, Connection>();
  /** Requests not settled yet: `release` waits for them. */
  readonly #pending = new Set<Promise<unknown>>();
  /**
   * Relays a request to which ran out of time or lost its connection in this call: a read on every
   * relay counts them as failed at once (SPEC.md §13).
   */
  readonly #failed = new Set<string>();
  /** Aborted when the call is done (release, close): its reads end then, its publications go on. */
  readonly #reads = new AbortController();
  #closed = false;

  constructor(options: PoolOptions) {
    this.#options = options;
    this.#random = options.random ?? secureRandomBytes;
  }

  /**
   * What every relay of `relays` holds that matches `filter`, in parallel, page after page (NIP-01
   * `until`, for a filter that may match more than a relay sends at once; strfry: 500 events).
   * Resolves as soon as a majority of the relays answered (the others' reads are dropped), or once
   * every relay answered or failed: the events of each relay that answered, unchecked, and whether
   * a majority answered (readOutcome). Never rejects.
   */
  queryRelays(
    relays: readonly string[],
    filter: RelayFilter,
    authKey: Uint8Array,
    { paged, keep, everyRelay = false }: { paged: boolean; keep: Keep; everyRelay?: boolean }
  ): Promise<RelayAnswers> {
    return new Promise((resolve) => {
      const needed = majority(relays.length);
      const answers = new Map<string, unknown[]>();
      const stop = new AbortController();
      // The call done, the read ends with it: its relays are asked nothing more (SPEC.md §13).
      const end = () => stop.abort();
      this.#reads.signal.addEventListener("abort", end);
      if (this.#reads.signal.aborted) stop.abort();
      // On every relay: those that failed in this call count as failed at once.
      const asked = everyRelay ? relays.filter((relay) => !this.#failed.has(relay)) : relays;
      /** What each relay's read is: a read that ended is complete (not a complete read). */
      const states = new Map<string, RelayState>(
        relays.map((relay) => [relay, asked.includes(relay) ? "reading" : "failed"])
      );
      let done = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      /** What each relay sent so far: on every relay, a read cut short keeps its pages. */
      const sent = new Map(asked.map((relay) => [relay, [] as unknown[]]));
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        this.#reads.signal.removeEventListener("abort", end);
        stop.abort();
        if (everyRelay) {
          // Still reading: its pages are kept, but it has not answered (SPEC.md §13).
          for (const [relay, events] of sent) {
            if (states.get(relay) === "reading" && events.length > 0) answers.set(relay, events);
          }
        }
        resolve({ answers, answered: readOutcome(states.values()).answered });
      };
      const check = () => {
        const { answered, settled } = tally(states.values());
        if (settled >= relays.length) finish();
        else if (answered >= needed) {
          // On every relay, the others are waited for one timeout more at most (SPEC.md §13).
          if (!everyRelay) finish();
          else grace ??= setTimeout(finish, this.#options.timeoutMs);
        }
      };
      check();
      for (const relay of asked) {
        const read = paged
          ? this.#pages(relay, filter, authKey, keep, stop.signal, sent.get(relay))
          : this.#query(relay, filter, authKey, keep, stop.signal).then(keptOf);
        read.then(
          (events) => {
            if (done) return;
            answers.set(relay, events);
            states.set(relay, "complete");
            check();
          },
          () => {
            if (done) return;
            states.set(relay, "failed");
            check();
          }
        );
      }
    });
  }

  /**
   * A complete read of `filter` on every relay of `relays` at once (SPEC.md, "Complete reads"):
   * pages of COMPLETE_READ_LIMIT events, the next one from the oldest second of the last, until a
   * page is not full. Resolves as soon as a majority of the relays read completely (the others'
   * reads are dropped), or once every relay answered, stopped incomplete or failed: the events of
   * each relay that answered, whether a majority answered and whether a majority read completely
   * (readOutcome). Never rejects.
   */
  queryComplete(
    relays: readonly string[],
    filter: RelayFilter,
    authKey: Uint8Array,
    { keep, everyRelay = false }: { keep: Keep; everyRelay?: boolean }
  ): Promise<CompleteAnswers> {
    return new Promise((resolve) => {
      const needed = majority(relays.length);
      const answers = new Map<string, unknown[]>();
      const stop = new AbortController();
      // The call done, the read ends with it: its relays are asked nothing more (SPEC.md §13).
      const end = () => stop.abort();
      this.#reads.signal.addEventListener("abort", end);
      if (this.#reads.signal.aborted) stop.abort();
      // On every relay: those that failed in this call count as failed at once.
      const asked = everyRelay ? relays.filter((relay) => !this.#failed.has(relay)) : relays;
      /** What each relay's read is. */
      const states = new Map<string, RelayState>(
        relays.map((relay) => [relay, asked.includes(relay) ? "reading" : "failed"])
      );
      let done = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      /** What each relay sent so far: on every relay, a read cut short keeps its pages. */
      const sent = new Map(asked.map((relay) => [relay, [] as unknown[]]));
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        this.#reads.signal.removeEventListener("abort", end);
        stop.abort();
        if (everyRelay) {
          // Still reading: its pages are kept, but it has not answered (SPEC.md §13).
          for (const [relay, events] of sent) {
            if (states.get(relay) === "reading" && events.length > 0) answers.set(relay, events);
          }
        }
        resolve({ answers, ...readOutcome(states.values()) });
      };
      const check = () => {
        const { complete, settled } = tally(states.values());
        if (settled >= relays.length) finish();
        // On every relay, no wait once a majority can no longer read completely: not complete.
        else if (everyRelay && complete + (relays.length - settled) < needed) finish();
        else if (complete >= needed) {
          // On every relay, the others are waited for one timeout more at most (SPEC.md §13).
          if (!everyRelay) finish();
          else grace ??= setTimeout(finish, this.#options.timeoutMs);
        }
      };
      check();
      for (const relay of asked) {
        this.#completePages(relay, filter, authKey, keep, stop.signal, sent.get(relay)).then(
          (read) => {
            if (done) return;
            answers.set(relay, read.events);
            states.set(relay, read.complete ? "complete" : "incomplete");
            check();
          },
          () => {
            if (done) return;
            states.set(relay, "failed");
            check();
          }
        );
      }
    });
  }

  /**
   * Publishes `event` to every relay of `relays`, in parallel. Resolves once `quorum` relays took
   * it (the others go on until `release`, each bounded by its timeout), rejects as soon as they no
   * longer can: the others' requests end then, as only a publication's relays past its majority
   * may go on (SPEC.md §13).
   */
  publishToQuorum(
    relays: readonly string[],
    event: NostrEvent,
    authKey: Uint8Array,
    quorum: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let taken = 0;
      let failures = 0;
      const stop = new AbortController();
      const settle = () => {
        if (taken >= quorum) resolve();
        else if (relays.length - failures < quorum) {
          stop.abort();
          reject(new Error(`Fewer than ${quorum} relays took the event`));
        }
      };
      settle();
      for (const relay of relays) {
        this.#publish(relay, event, authKey, stop.signal).then(
          () => {
            taken += 1;
            settle();
          },
          () => {
            failures += 1;
            settle();
          }
        );
      }
    });
  }

  /** Closes every connection now: their requests fail. */
  close(): void {
    this.#closed = true;
    this.#reads.abort();
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
  }

  /**
   * Closes every connection once the requests still running are over (a write to the relays past
   * the quorum), each bounded by its timeout. Nothing new may be asked of the pool, and a read
   * still running (its call failed meanwhile) ends at once.
   */
  release(): void {
    this.#closed = true;
    this.#reads.abort();
    if (this.#pending.size === 0) {
      this.close();
      return;
    }
    void Promise.allSettled([...this.#pending]).then(() => this.close());
  }

  /**
   * The stored events of `url` that match `filter`, page after page, as the merchant's app reads
   * them.
   */
  async #pages(
    url: string,
    filter: RelayFilter,
    authKey: Uint8Array,
    keep: Keep,
    signal: AbortSignal,
    /** Where its events go as its pages come: what it sent so far, should the read be cut. */
    events: unknown[] = []
  ): Promise<unknown[]> {
    return readPages(
      (until) =>
        this.#query(
          url,
          until === undefined ? filter : { ...filter, until },
          authKey,
          keep,
          signal
        ),
      filter.until,
      events,
      signal
    );
  }

  /**
   * The events of `url` that match `filter`, read completely if it can be: whether it was. Rejects
   * when its first page fails (the relay failed); a later failure ends the read incomplete.
   */
  async #completePages(
    url: string,
    filter: RelayFilter,
    authKey: Uint8Array,
    keep: Keep,
    signal: AbortSignal,
    /** Where its events go as its pages come: what it sent so far, should the read be cut. */
    events: unknown[] = []
  ): Promise<{ events: unknown[]; complete: boolean }> {
    return readCompletely(
      (until) =>
        this.#query(
          url,
          { ...filter, limit: COMPLETE_READ_LIMIT, ...(until === undefined ? {} : { until }) },
          authKey,
          keep,
          signal
        ),
      filter.until,
      events,
      signal
    );
  }

  /**
   * The stored events of one relay that match `filter`, as it sent them: the entry of each (entryOf:
   * the event itself only when `keep` takes it), unchecked, the caller verifies them. At most
   * MAX_EVENTS_PER_QUERY. Authenticates when the relay asks (NIP-42).
   */
  #query(
    url: string,
    filter: RelayFilter,
    authKey: Uint8Array,
    keep: Keep,
    signal: AbortSignal
  ): Promise<Entry[]> {
    return this.#request(url, signal, async (connection, onEnd, live) => {
      const ask = () =>
        new Promise<{ events: Entry[]; closed: string | null }>((done) => {
          const subscription = bytesToHex(this.#random(8));
          const events: Entry[] = [];
          /** The ids of this query's events so far: the first event of each is the one read. */
          const read = new Set<string>();
          let open = true;
          const end = (closed: string | null, byRelay: boolean) => {
            if (!open) return;
            open = false;
            stop();
            // Over this connection, which stays open for the call's next requests.
            if (!byRelay) connection.send(["CLOSE", subscription]);
            done({ events, closed });
          };
          const stop = connection.listen((message) => {
            if (message[1] !== subscription) return;
            if (message[0] === "EVENT") {
              events.push(entryOf(message[2], keep, read));
              if (events.length >= MAX_EVENTS_PER_QUERY) end(null, false);
            } else if (message[0] === "EOSE") {
              end(null, false);
            } else if (message[0] === "CLOSED") {
              end(typeof message[2] === "string" ? message[2] : "", true);
            }
          });
          onEnd(() => {
            if (!open) return;
            open = false;
            stop();
            connection.send(["CLOSE", subscription]);
          });
          connection.send(["REQ", subscription, filter]);
        });
      let result = await ask();
      // A read that went on without this relay meanwhile asks it nothing more.
      if (
        result.closed?.startsWith(AUTH_REQUIRED) &&
        live() &&
        (await connection.authenticate(authKey, this.#options.now(), this.#random)) &&
        live()
      ) {
        result = await ask();
      }
      if (result.closed !== null) throw new Error(`${url} closed the query: ${result.closed}`);
      return result.events;
    });
  }

  /** Publishes `event` to one relay, authenticating when it asks (NIP-42). Rejects unless taken. */
  #publish(
    url: string,
    event: NostrEvent,
    authKey: Uint8Array,
    signal: AbortSignal
  ): Promise<void> {
    return this.#request(url, signal, async (connection, onEnd, live) => {
      const write = () =>
        new Promise<{ accepted: boolean; reason: string }>((done) => {
          const stop = connection.listen((message) => {
            if (message[0] !== "OK" || message[1] !== event.id) return;
            stop();
            done({
              accepted: message[2] === true,
              reason: typeof message[3] === "string" ? message[3] : ""
            });
          });
          onEnd(stop);
          connection.send(["EVENT", event]);
        });
      let answer = await write();
      // Past its time (or the pool closed), a publication writes nothing more either.
      if (
        !answer.accepted &&
        answer.reason.startsWith(AUTH_REQUIRED) &&
        live() &&
        (await connection.authenticate(authKey, this.#options.now(), this.#random)) &&
        live()
      ) {
        answer = await write();
      }
      if (!answer.accepted) throw new RelayRefusal(url, answer.reason);
    });
  }

  /**
   * Runs `operation` over the connection to `url` once it is open, within `timeoutMs`. Fails when
   * the connection ends, the time runs out, `signal` or the pool's signal aborts. `onEnd` registers
   * what the operation leaves behind (listeners, subscriptions), cleaned up when it settles; `live`
   * tells whether it has not settled yet: once it has, the operation starts nothing more (SPEC.md
   * §13: no authentication, no query again).
   */
  #request<T>(
    url: string,
    signal: AbortSignal | undefined,
    operation: (
      connection: Connection,
      onEnd: (cleanup: () => void) => void,
      live: () => boolean
    ) => Promise<T>
  ): Promise<T> {
    const request = new Promise<T>((resolve, reject) => {
      const cleanups: (() => void)[] = [];
      let settled = false;
      const settle = (outcome: { value: T } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const cleanup of cleanups.splice(0)) cleanup();
        if ("value" in outcome) resolve(outcome.value);
        else reject(outcome.error);
      };
      const fail = (error: unknown) => {
        this.#failed.add(url);
        settle({ error });
      };
      const timer = setTimeout(
        () => fail(new Error(`${url}: no answer in time`)),
        this.#options.timeoutMs
      );
      const abort = () => settle({ error: new Error(`${url}: aborted`) });
      for (const s of [this.#options.signal, signal]) {
        if (!s) continue;
        s.addEventListener("abort", abort);
        cleanups.push(() => s.removeEventListener("abort", abort));
        if (s.aborted) abort();
      }
      if (settled) return;
      let connection: Connection;
      try {
        connection = this.#connection(url);
      } catch (error) {
        fail(error);
        return;
      }
      cleanups.push(connection.onDeath((error) => fail(error)));
      if (settled) return;
      connection.opened
        .then(() => {
          if (settled) return undefined;
          return operation(
            connection,
            (cleanup) => {
              if (settled) cleanup();
              else cleanups.push(cleanup);
            },
            () => !settled
          ).then((value) => settle({ value }));
        })
        .catch((error: unknown) => settle({ error }));
    });
    this.#pending.add(request);
    const forget = () => this.#pending.delete(request);
    request.then(forget, forget);
    return request;
  }

  /** The pool's connection to `url`, opened at its first request. */
  #connection(url: string): Connection {
    if (this.#closed) throw new Error(`${url}: the pool is closed`);
    let connection = this.#connections.get(url);
    if (!connection) {
      let socket: WebSocketLike;
      try {
        socket = this.#options.createSocket(url);
      } catch (error) {
        throw new Error(`${url}: connection failed`, { cause: error });
      }
      connection = new Connection(url, socket);
      this.#connections.set(url, connection);
    }
    return connection;
  }
}
