/**
 * Local Nostr relays for tests (NIP-01, NIP-42), each a `ws` server on a free port of 127.0.0.1.
 * A relay keeps the newest event of each address, as strfry does, and can refuse writes, ask for
 * authentication, cap its answers or never answer at all. The package reaches them under `wss://`
 * names (the only relays a key or a channel may name) through `net.WebSocket`.
 */
import { createServer, type Server, type Socket } from "node:net";

import { WebSocket as WsWebSocket, WebSocketServer, type RawData } from "ws";

import { isValidEvent, type NostrEvent } from "../../src/nostr/event.js";

export type RelayBehaviour = {
  /** Refuses every event with this reason. */
  refuse?: string;
  /** Refuses the events it gives a reason for (a checkout link and not a declaration…). */
  refuseEvent?: (event: NostrEvent) => string | undefined;
  /** Accepts connections and never sends anything. */
  mute?: boolean;
  /** Asks every connection to authenticate (NIP-42) before reading or writing. */
  requireAuth?: boolean;
  /** Answers each authentication this many milliseconds late. */
  authDelayMs?: number;
  /** Sends at most this many events per query, the newest first (strfry: 500). */
  cap?: number;
  /** Never answers the queries it gives true for (no event, no EOSE): a relay that stalls there. */
  muteQuery?: (filter: Filter) => boolean;
  /** Answers each query this many milliseconds late (writes at once). */
  queryDelayMs?: number;
  /**
   * Answers a filter without `limit` oldest first, as nostr-rs-relay does (its SQLite query
   * builder: `ORDER BY e.created_at ASC` without a limit, `DESC LIMIT n` with one).
   */
  oldestFirstWithoutLimit?: boolean;
  /** Leaves out of its answers the events it gives true for: a hostile relay. */
  hide?: (event: NostrEvent) => boolean;
  /** Hears each event the relay took, once it keeps it (another server writing meanwhile…). */
  onEvent?: (event: NostrEvent, relay: LocalRelay) => void;
};

export type Filter = {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  "#d"?: string[];
  "#o"?: string[];
  since?: number;
  until?: number;
  limit?: number;
};

export class LocalRelay {
  readonly events: unknown[] = [];
  /** Every event a client sent, accepted or not. */
  readonly received: NostrEvent[] = [];
  /** Every filter a client asked. */
  readonly queries: Filter[] = [];
  /** The public keys that authenticated. */
  readonly authenticated: string[] = [];
  /** Subscriptions a client closed (NIP-01 CLOSE). */
  readonly closedSubscriptions: string[] = [];
  behaviour: RelayBehaviour;

  constructor(
    readonly server: WebSocketServer,
    behaviour: RelayBehaviour
  ) {
    this.behaviour = behaviour;
    server.on("connection", (socket) => this.#connect(socket));
  }

  get port(): number {
    return (this.server.address() as { port: number }).port;
  }

  /** Stores `value` as it is (an invalid event too: a relay is never trusted). */
  store(value: unknown) {
    this.events.push(value);
  }

  /** Takes `event` as a client's write: the newest of its address is kept. */
  take(event: NostrEvent) {
    this.#keep(event);
  }

  #connect(socket: WsWebSocket) {
    const challenge = globalThis.crypto.randomUUID();
    let authed: string | null = null;
    const send = (message: unknown[]) => socket.send(JSON.stringify(message));
    if (this.behaviour.requireAuth && !this.behaviour.mute) send(["AUTH", challenge]);
    socket.on("message", (data: RawData) => {
      if (this.behaviour.mute) return;
      let message: unknown;
      try {
        message = JSON.parse((data as Buffer).toString("utf8"));
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      const [type, ...rest] = message as [string, ...unknown[]];
      if (type === "AUTH") {
        const auth = rest[0];
        const ok =
          isValidEvent(auth) &&
          auth.kind === 22242 &&
          auth.tags.some(([name, value]) => name === "challenge" && value === challenge);
        if (ok) {
          authed = auth.pubkey;
          this.authenticated.push(auth.pubkey);
        }
        const accept = () => {
          if (socket.readyState !== WsWebSocket.OPEN) return;
          send(["OK", (auth as { id?: string } | null)?.id, ok, ok ? "" : "invalid: bad auth"]);
        };
        if (this.behaviour.authDelayMs) setTimeout(accept, this.behaviour.authDelayMs);
        else accept();
      } else if (type === "EVENT") {
        const event = rest[0];
        const { id, pubkey } = (event ?? {}) as { id?: string; pubkey?: string };
        if (isValidEvent(event)) this.received.push(event);
        if (this.behaviour.requireAuth && authed !== pubkey) {
          send(["OK", id, false, "auth-required: sign in first"]);
        } else if (this.behaviour.refuse) {
          send(["OK", id, false, this.behaviour.refuse]);
        } else if (isValidEvent(event) && this.behaviour.refuseEvent?.(event)) {
          send(["OK", id, false, this.behaviour.refuseEvent(event)]);
        } else if (!isValidEvent(event)) {
          send(["OK", id, false, "invalid: bad event"]);
        } else {
          this.#keep(event);
          this.behaviour.onEvent?.(event, this);
          send(["OK", event.id, true, ""]);
        }
      } else if (type === "REQ") {
        const [id, ...filters] = rest as [string, ...Filter[]];
        this.queries.push(...filters);
        if (this.behaviour.requireAuth && authed === null) {
          send(["CLOSED", id, "auth-required: sign in first"]);
          return;
        }
        if (filters.some((filter) => this.behaviour.muteQuery?.(filter))) return;
        const answer = () => {
          if (socket.readyState !== WsWebSocket.OPEN) return;
          for (const event of this.#match(filters)) send(["EVENT", id, event]);
          send(["EOSE", id]);
        };
        if (this.behaviour.queryDelayMs) setTimeout(answer, this.behaviour.queryDelayMs);
        else answer();
      } else if (type === "CLOSE") {
        this.closedSubscriptions.push(String(rest[0]));
      }
    });
  }

  /** Keeps the newest event of an address (kind 30000–39999), as relays do (NIP-01). */
  #keep(event: NostrEvent) {
    if (event.kind >= 30000 && event.kind < 40000) {
      const d = event.tags.find(([name]) => name === "d")?.[1] ?? "";
      const index = this.events.findIndex((other) => {
        const o = other as NostrEvent;
        return (
          o?.kind === event.kind &&
          o.pubkey === event.pubkey &&
          (o.tags?.find(([name]) => name === "d")?.[1] ?? "") === d
        );
      });
      if (index >= 0) {
        const old = this.events[index] as NostrEvent;
        // The newest kept; of one second, the lowest id (NIP-01).
        if (
          old.created_at > event.created_at ||
          (old.created_at === event.created_at && old.id <= event.id)
        ) {
          return;
        }
        this.events.splice(index, 1);
      }
    }
    this.events.push(event);
  }

  #match(filters: Filter[]): unknown[] {
    const found = this.events.filter((value) => {
      const event = value as Partial<NostrEvent>;
      if (this.behaviour.hide?.(value as NostrEvent)) return false;
      return filters.some(
        (filter) =>
          (!filter.ids || filter.ids.includes(event.id!)) &&
          (!filter.kinds || filter.kinds.includes(event.kind!)) &&
          (!filter.authors || filter.authors.includes(event.pubkey!)) &&
          (["d", "o"] as const).every((name) => {
            const values = filter[`#${name}`];
            return (
              !values ||
              (event.tags ?? []).some(
                (tag) => Array.isArray(tag) && tag[0] === name && values.includes(tag[1]!)
              )
            );
          }) &&
          (filter.since === undefined || (event.created_at ?? 0) >= filter.since) &&
          (filter.until === undefined || (event.created_at ?? 0) <= filter.until)
      );
    });
    found.sort(
      (a, b) =>
        ((b as NostrEvent).created_at ?? 0) - ((a as NostrEvent).created_at ?? 0) ||
        String((a as NostrEvent).id).localeCompare(String((b as NostrEvent).id))
    );
    if (
      this.behaviour.oldestFirstWithoutLimit &&
      filters.every((filter) => filter.limit === undefined)
    ) {
      found.reverse();
    }
    const limit = Math.min(
      ...filters.map((filter) => filter.limit ?? Infinity),
      this.behaviour.cap ?? Infinity
    );
    return found.slice(0, limit);
  }
}

/** Relays of a test, by their `wss://` name. */
export class RelayNet {
  readonly relays = new Map<string, LocalRelay>();
  /** Names that refuse connections (nothing listens). */
  readonly down = new Set<string>();
  /** How many connections each name got. */
  readonly connections = new Map<string, number>();
  /** Names served by a plain WebSocket server of a test (the explorer's WebSocket). */
  readonly servers = new Map<string, WebSocketServer>();
  /** Names whose server takes the TCP connection and never answers the WebSocket handshake. */
  readonly blackholes = new Map<string, { server: Server; sockets: Set<Socket> }>();

  async addBlackhole(url: string): Promise<void> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.blackholes.set(url, { server, sockets });
  }

  /** A plain WebSocket server reached at `url`: the test answers its clients itself. */
  async addServer(url: string): Promise<WebSocketServer> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    this.servers.set(url, server);
    return server;
  }

  async add(url: string, behaviour: RelayBehaviour = {}): Promise<LocalRelay> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const relay = new LocalRelay(server, behaviour);
    this.relays.set(url, relay);
    return relay;
  }

  /** Stops the relay of `url`: its name refuses connections from now on. */
  async remove(url: string): Promise<void> {
    const relay = this.get(url);
    this.relays.delete(url);
    for (const client of relay.server.clients) client.terminate();
    await new Promise<void>((resolve) => relay.server.close(() => resolve()));
  }

  get(url: string): LocalRelay {
    const relay = this.relays.get(url);
    if (!relay) throw new Error(`No relay ${url}`);
    return relay;
  }

  /** The WebSocket class the package gets: `wss://name` goes to the local relay of that name. */
  get WebSocket() {
    const net = this;
    return class extends WsWebSocket {
      constructor(url: string) {
        net.connections.set(url, (net.connections.get(url) ?? 0) + 1);
        const relay = net.relays.get(url);
        const hole = net.blackholes.get(url)?.server.address() as { port: number } | undefined;
        const server = net.servers.get(url)?.address() as { port: number } | undefined;
        const port = relay?.port ?? hole?.port ?? server?.port;
        // A port nothing listens on (port 9 is "discard", closed here): connection refused.
        super(port ? `ws://127.0.0.1:${port}` : "ws://127.0.0.1:9");
      }
    };
  }

  async close() {
    for (const server of this.servers.values()) {
      for (const client of server.clients) client.terminate();
      server.close();
    }
    for (const { server, sockets } of this.blackholes.values()) {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
    await Promise.all(
      [...this.relays.values()].map(
        (relay) =>
          new Promise<void>((resolve) => {
            for (const client of relay.server.clients) client.terminate();
            relay.server.close(() => resolve());
          })
      )
    );
  }
}
