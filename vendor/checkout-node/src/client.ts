import { readChannel } from "./channel.js";
import { checkoutValue, newCheckoutLink, type CheckoutValue } from "./checkout.js";
import { declarationEvent, registryOf, type DeclaredPrice } from "./declaration.js";
import { restKeys, restRecordAddress, saleOf, type Registry, type Sale } from "./derive.js";
import {
  CheckoutUnavailableError,
  InvalidInvoiceError,
  InvalidOptionError,
  InvalidOrderError,
  InvoicePendingError,
  NetworkError,
  OrderPaidError,
  SattlemeError
} from "./errors.js";
import type { HttpOptions } from "./http.js";
import { parseIntegrationKey, type IntegrationKey } from "./key.js";
import type { Bolt11 } from "./lightning/bolt11.js";
import {
  checkInvoice,
  fetchPayRequest,
  requestInvoice,
  sendableSats,
  verifyPayment,
  type InvoiceAnswer,
  type LightningInvoice
} from "./lnurl.js";
import type { NostrEvent } from "./nostr/event.js";
import { RelayPool, majority, type WebSocketFactory, type WebSocketLike } from "./nostr/relay.js";
import { paymentUri } from "./onchain/address.js";
import {
  addressTransactions,
  Explorer,
  paysTo,
  type ExplorerTx,
  type NodeFailures
} from "./onchain/explorer.js";
import {
  isLeased,
  leaseConfirmed,
  leaseEvent,
  readLeases,
  withdrawalEvent,
  type LeaseRead,
  type LeaseRecord,
  type LeaseTerms
} from "./onchain/lease.js";
import {
  publishRestRecord,
  readRestRecords,
  restRecordEvent,
  restToAsk,
  sendable,
  type RestAsk,
  type RestInvoice
} from "./onchain/rest.js";
import { publishAcceptance } from "./onchain/acceptance.js";
import { readLot } from "./onchain/lot.js";
import { merchantAcceptanceKeys, readMerchantAcceptance } from "./onchain/merchant-acceptance.js";
import { methodsWith, paymentMethods } from "./onchain/methods.js";
import { recordNodeFor, type BitcoinNode } from "./onchain/node.js";
import {
  checkOnchainPart,
  combineParts,
  restSummary,
  type LightningPart,
  type OnchainPart,
  type RestPart,
  type Settled
} from "./onchain/payment.js";
import { watchAddress } from "./onchain/watch.js";
import {
  publishWitness,
  readNamedAddresses,
  readOrderWitnesses,
  seenOf,
  witnessAddress
} from "./onchain/witness.js";
import {
  checkMilliseconds,
  checkOrder,
  checkRef,
  checkStoredInvoice,
  rateSourceOption,
  type CheckedOrder,
  type Order,
  type StoredInvoice
} from "./order.js";
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  GRACE_SECONDS,
  MAX_ADDRESS_TRIES,
  MAX_INTERVAL_MS,
  MAX_PARALLEL_PAYMENT_CHECKS,
  MAX_SATS,
  MAX_TIMEOUT_MS,
  MAX_WITNESS_INPUTS,
  MIN_INTERVAL_MS,
  MIN_REST_SECONDS,
  MIN_TIMEOUT_MS,
  ONCHAIN_CHECK_INTERVAL_MS,
  SATS_CURRENCY
} from "./protocol.js";
import { secureRandomBytes, type RandomBytes } from "./random.js";
import { fetchFirstRate, minorToSats, type RateSource } from "./rates.js";
import {
  heldBy,
  mayStillBePaid,
  pendingOutcome,
  readSaleDeclarations,
  restKeyOf,
  type SaleDeclaration,
  type SaleRecords
} from "./sales.js";
import { isObject } from "./text.js";
import type {
  DeclaredInvoice,
  Invoice,
  InvoiceToCheck,
  Logger,
  Merchant,
  PaymentStatus,
  RateInfo
} from "./types.js";
import { nodeWebSocket } from "./websocket.js";

export type SattlemeOptions = {
  /** The integration's secret key ("Integrations" in the app): from the environment or a vault. */
  key: string;
  /**
   * Where invoices priced in a currency get their rate: `"coingecko"`, `"mempool"`, `"opennode"`,
   * `"coinbase"`, `"kraken"`, your own function, or a list of them asked in order, the next one
   * only when the previous one gives no price. Optional: DEFAULT_RATE_SOURCES by default. Each
   * order may give its own.
   */
  rateSource?: RateSource | readonly RateSource[];
  /**
   * Optional: CoinGecko's Demo API key, sent to CoinGecko only: 1 or more visible ASCII characters
   * (an empty string is invalid, not absent). Without it, its keyless API.
   */
  coingeckoApiKey?: string;
  /** The fetch implementation: the global one by default. */
  fetch?: typeof fetch;
  /**
   * The WebSocket class for the relays and the explorer's WebSocket (mempool.space's, or the
   * merchant's Bitcoin node's, `ws://` or `wss://`): the `ws` package's by default under Node (it caps a message at 1 MiB and bounds the handshake, which the WHATWG WebSocket
   * cannot). Bun and Deno may pass their global `WebSocket`.
   */
  WebSocket?: new (url: string) => WebSocketLike;
  /** Per relay request, connection included: 100 to 60 000 ms, 10 000 by default. */
  relayTimeoutMs?: number;
  /**
   * Per HTTP request (Lightning address, rate sources, the explorer: mempool.space or the
   * merchant's Bitcoin node, BlockCypher), body included: 100 to 60 000 ms, 10 000 by default.
   */
  httpTimeoutMs?: number;
  /** Where warnings go: `console` by default. Never given a secret. */
  logger?: Logger;
  /** The clock, in milliseconds: `Date.now` by default. For tests. */
  now?: () => number;
  /** Random bytes: `crypto.getRandomValues` by default. For reproducible tests only. */
  random?: RandomBytes;
};

export type CallOptions = { signal?: AbortSignal };

export type WaitOptions = CallOptions & {
  /** Between two checks: 250 to 60 000 ms, 2000 by default. */
  intervalMs?: number;
  /** Hears each status. */
  onStatus?: (status: PaymentStatus) => void;
};

/** What the server needs of the merchant, read with the key alone (the integration's channel). */
type MerchantChannel = {
  businessName: string;
  /** Never given to the integrator. */
  lightningAddress: string;
  registry: Registry;
  /** The account's relays: where declarations, leases, witnesses and checkout links go. */
  relays: readonly string[];
  /** The merchant's web app for checkout links, null when its app gives none. */
  checkoutOrigin: string | null;
  /**
   * The merchant's tolerance of on-chain underpayments (basis points, SPEC.md, "The merchant's
   * tolerance"): a new order's lease keeps it. Never in what the integrator or the customer gets.
   */
  tolerance: number;
  /**
   * The merchant's Bitcoin node (SPEC.md §31), null for mempool.space: the pages of checkout links
   * read it too when its `payers` is true.
   */
  bitcoinNode: BitcoinNode | null;
  /** The explorer the call reads: the node with its fallback, else mempool.space. */
  explorer: Explorer;
};

/**
 * What the reads of the explorer of one call share (SPEC.md §31, "in the same call"): when the
 * node failed, and, for waitForPayment, who hears the node each channel read names (its WebSocket
 * follows it).
 */
type CallExplorer = { failures: NodeFailures; onNode?: (node: BitcoinNode | null) => void };

/**
 * A shop's server for one sattle.me integration: makes the invoice of each order (a
 * Lightning invoice, a deposit address of the merchant's wallet, or both), declares it in the
 * merchant's registry, checks its payment (SPEC.md, "Client"). Made for a server that
 * lives for one call (it starts, makes an invoice, stops): nothing is kept between calls, each
 * call reads the merchant (a removal stops the next invoice) and closes its connections, there is
 * nothing to close.
 */
export class Sattleme {
  readonly #access: IntegrationKey;
  readonly #rateSources: readonly RateSource[];
  readonly #coingeckoApiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #createSocket: WebSocketFactory;
  readonly #relayTimeoutMs: number;
  readonly #httpTimeoutMs: number;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #random: RandomBytes;
  /** One invoice at a time per order, in this process. */
  readonly #orders = new Map<string, Promise<unknown>>();
  /** One invoice of the rest at a time per invoice (`ref/address`), in this process. */
  readonly #restAsks = new Map<string, Promise<unknown>>();

  constructor(options: SattlemeOptions) {
    if (!isObject(options)) throw new InvalidOptionError("options", "expected { key, … }");
    this.#access = parseIntegrationKey(options.key);
    this.#rateSources = rateSourceOption(options.rateSource);
    // Visible ASCII: its HTTP header carries it as it is.
    if (
      options.coingeckoApiKey !== undefined &&
      (typeof options.coingeckoApiKey !== "string" ||
        !/^[\x21-\x7e]+$/.test(options.coingeckoApiKey))
    ) {
      throw new InvalidOptionError("coingeckoApiKey", "1 or more visible ASCII characters");
    }
    this.#coingeckoApiKey = options.coingeckoApiKey;
    this.#fetch = optionalFunction(options.fetch, "fetch") ?? globalThis.fetch.bind(globalThis);
    this.#relayTimeoutMs = checkMilliseconds(
      options.relayTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "relayTimeoutMs"
    );
    this.#httpTimeoutMs = checkMilliseconds(
      options.httpTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "httpTimeoutMs"
    );
    const Socket = optionalFunction(options.WebSocket, "WebSocket");
    this.#createSocket = Socket
      ? (url) => new Socket(url)
      : (url) => nodeWebSocket(url, this.#relayTimeoutMs);
    if (options.logger !== undefined && typeof options.logger?.warn !== "function") {
      throw new InvalidOptionError("logger", "an object with a warn(message) function");
    }
    this.#logger = options.logger ?? console;
    this.#now = optionalFunction(options.now, "now") ?? Date.now;
    this.#random = optionalFunction(options.random, "random") ?? secureRandomBytes;
  }

  /** The integration key's relays and team: no secret. */
  toJSON() {
    return { teamPublicKey: this.#access.teamPublicKey, relays: this.#access.relays };
  }

  /**
   * The merchant: its business's name, the bounds of its Lightning address in sats, and how many
   * deposit addresses the integration's lot holds. Throws RevokedError when the merchant removed
   * the integration. Never its Lightning address.
   */
  async merchant({ signal }: CallOptions = {}): Promise<Merchant> {
    return this.#withRelays(signal, async (pool, signal) => {
      const merchant = await this.#channel(pool, signal);
      const payRequest = fetchPayRequest(merchant.lightningAddress, this.#http(signal));
      payRequest.catch(ignore);
      const lot = await this.#lot(pool, merchant, signal);
      const { min, max } = sendableSats(await payRequest);
      return {
        businessName: merchant.businessName,
        minSats: min.toString(),
        maxSats: max.toString(),
        onchainAddresses: lot.length
      };
    });
  }

  /**
   * The invoice of an order: a Lightning invoice asked to the merchant's Lightning address and
   * checked, when its amount is within the address's bounds; a deposit address of the merchant's
   * wallet leased from the integration's lot, from 1 000 sats (or both). Then the invoice is
   * declared in the merchant's registry on a majority of its relays. Only then may it be shown.
   * Store the result with the order.
   *
   * One order, one invoice at a time: throws InvoicePendingError (with that invoice) while an
   * earlier invoice of the same `ref` may still be paid (or its on-chain payment is being
   * confirmed), OrderPaidError when one was paid. OnchainUnavailableError when the order can only
   * be paid on-chain and no address could be leased.
   *
   * With `checkout: true`, the invoice also gets a checkout link (`checkoutUrl`): a page of the
   * merchant's web app that shows it to the customer, checks its payment and, once it is paid,
   * sends the customer to `redirectUrl`. It is published on a majority of the merchant's relays
   * before the invoice is declared. Throws CheckoutUnavailableError when the merchant's app gives
   * no web app for it.
   */
  async createInvoice(order: Order, options: CallOptions = {}): Promise<Invoice> {
    const checked = checkOrder(order, this.#rateSources);
    // One at a time per order in this process: two calls for one `ref` would both pass the check
    // of its earlier invoices.
    const previous = this.#orders.get(checked.ref) ?? Promise.resolve();
    const run = previous.catch(ignore).then(() => this.#createInvoice(checked, options));
    const settled = run.catch(ignore);
    this.#orders.set(checked.ref, settled);
    void settled.then(() => {
      if (this.#orders.get(checked.ref) === settled) this.#orders.delete(checked.ref);
    });
    return run;
  }

  async #createInvoice(order: CheckedOrder, { signal }: CallOptions): Promise<Invoice> {
    return this.#withRelays(signal, async (pool, signal) => {
      const merchant = await this.#channel(pool, signal);
      if (order.checkout && merchant.checkoutOrigin === null) throw new CheckoutUnavailableError();
      const sale = saleOf(this.#access.key, merchant.registry, order.ref);
      const http = this.#http(signal);
      // Asked while the registry is read: the Lightning address and the rate need nothing of it.
      const payRequest = fetchPayRequest(merchant.lightningAddress, http);
      const quote =
        order.fiat && order.rateSources
          ? fetchFirstRate(
              order.rateSources,
              order.fiat.currency,
              { ...http, coingeckoApiKey: this.#coingeckoApiKey },
              () => this.#seconds(),
              this.#logger
            )
          : null;
      // Awaited below, unless the registry's check fails first.
      payRequest.catch(ignore);
      quote?.catch(ignore);
      await this.#checkEarlierInvoices(pool, sale, merchant, order, signal);
      const pay = await payRequest;

      let sats: bigint;
      let rate: RateInfo | null = null;
      if (order.fiat) {
        const { price, info } = await quote!;
        sats = minorToSats(BigInt(order.fiat.minor), order.fiat.digits, price);
        rate = info;
        if (sats > MAX_SATS) {
          throw new InvalidOrderError("fiat", `${sats} sats is more than 21 million bitcoins`);
        }
      } else {
        sats = order.sats!;
      }
      const { lightning, onchain } = paymentMethods(
        sats,
        sendableSats(pay),
        order.fiat ? "fiat" : "sats"
      );

      let answer: InvoiceAnswer | null = null;
      let decoded: Bolt11 | null = null;
      if (lightning) {
        answer = await requestInvoice(
          pay,
          { sats, expirySeconds: order.durationSeconds, comment: order.label },
          http
        );
        decoded = checkInvoice(answer, {
          pay,
          sats,
          durationSeconds: order.durationSeconds,
          now: this.#seconds()
        });
      }
      const leasedAt = this.#seconds();
      const createdAt = decoded ? decoded.timestamp : leasedAt;
      const expiresAt = decoded
        ? decoded.timestamp + decoded.expirySeconds
        : leasedAt + order.durationSeconds;
      const price: DeclaredPrice = order.fiat
        ? {
            minor: Number(order.fiat.minor),
            digits: order.fiat.digits,
            currency: order.fiat.currency
          }
        : { minor: Number(sats), digits: 0, currency: SATS_CURRENCY };

      let event: NostrEvent | null = null;
      if (answer && decoded) {
        try {
          event = declarationEvent({
            sale,
            invoice: answer.pr,
            verifyUrl: answer.verify,
            paymentHash: decoded.paymentHash,
            price,
            note: order.label,
            createdAt: this.#seconds(),
            random: this.#random
          });
        } catch (error) {
          // A valid invoice too long for a NIP-44 plaintext (65 535 bytes) cannot be declared.
          throw new InvalidInvoiceError("The invoice is too large to be declared", {
            cause: error
          });
        }
      }

      // What the lease of an address holds, with on-chain.
      const terms: Omit<LeaseTerms, "address"> = {
        sats,
        invoice: answer?.pr ?? null,
        verifyUrl: answer?.verify ?? null,
        createdAt,
        expiresAt,
        price,
        note: order.label,
        // The order's for good: every check judges its payment with it.
        tolerance: merchant.tolerance
      };
      if (onchain) {
        // The lease holds the invoice too, sealed twice: a lease that does not fit a NIP-44
        // plaintext fails now, before anything is published (SPEC.md §17 step 6). The real one
        // differs from this one by its address alone, of one length for every deposit address.
        try {
          leaseEvent({
            sale,
            terms: { ...terms, address: SIZED_ADDRESS, confirmed: false },
            createdAt: leasedAt,
            // Never published: its size alone counts, the client's random bytes are left alone.
            random: (length) => new Uint8Array(length)
          });
        } catch (error) {
          throw new InvalidInvoiceError("The invoice is too large for the lease of an address", {
            cause: error
          });
        }
      }

      // The address before the link and the declaration: when the lease fails, nothing is
      // published.
      let lease: Leased | null = null;
      if (onchain) {
        const leased = await this.#leaseAddress(
          pool,
          merchant,
          sale,
          terms,
          // Without an invoice, the lease's date is the Invoice's.
          decoded ? null : leasedAt,
          signal
        );
        methodsWith({ lightning, onchain }, leased);
        if (leased.status === "leased") lease = leased;
        else if (leased.status === "explorer_failed") {
          this.#logger.warn(
            `@sattleme/checkout: no deposit address leased, the explorer did not answer (${leased.error.message}): Lightning only`
          );
        }
      }
      const onchainAddress = lease?.address ?? null;

      // On a failure below, the lease stays: it holds its address until its end (a withdrawal on
      // some relays only would leave them disagreeing), and was confirmed: §21 may hand it out.
      let checkoutUrl: string | null = null;
      // The link before the declaration: when the link fails, nothing is declared and the order
      // gets a new invoice at once; when the declaration fails, the link's URL was never given
      // and its keys are gone, so nobody can open it.
      if (order.checkout) {
        checkoutUrl = await this.#publishCheckout(
          pool,
          merchant,
          checkoutValue({
            businessName: merchant.businessName,
            invoice: answer?.pr ?? null,
            verifyUrl: answer?.verify ?? null,
            onchainAddress,
            sats,
            createdAt,
            expiresAt,
            fiat: order.fiat ? price : null,
            note: order.label,
            redirectUrl: order.redirectUrl,
            rest:
              onchainAddress === null
                ? null
                : restKeys(this.#access.key, order.ref, onchainAddress, expiresAt),
            bitcoinNode: recordNodeFor(merchant.bitcoinNode)
          }),
          expiresAt,
          signal
        );
      }
      if (event) await this.#declare(pool, event, sale, merchant, signal);

      return {
        ref: order.ref,
        bolt11: answer?.pr ?? null,
        paymentHash: decoded?.paymentHash ?? null,
        verifyUrl: answer?.verify ?? null,
        onchainAddress,
        paymentUri: paymentUri(onchainAddress, sats, answer?.pr ?? null),
        sats: sats.toString(),
        fiat: order.fiat,
        rate,
        note: order.label,
        createdAt,
        expiresAt,
        checkoutUrl,
        redirectUrl: order.checkout ? order.redirectUrl : null
      };
    });
  }

  /**
   * Leases a deposit address of the integration's lot for `sale` (SPEC.md, "Leasing an address"):
   * the lot and its leases read; of its free addresses, in a random order, at most 3 tried, one at
   * a time: one the explorer shows paid already is skipped (its witness none published, so that the
   * merchant's app takes it out of the lot), the explorer read with its fallback (SPEC.md §31: the
   * merchant's Bitcoin node with `"none"` and down, no address); else the lease is published on a majority, the
   * address's leases read again, and the lease confirmed then marked, or withdrawn when the read is
   * not complete or another author's leases it too (the later of two servers sees both). A lease
   * once confirmed is never withdrawn. `leasedAt`: the lease's date when it is the Invoice's (an
   * order paid on-chain only). Throws NetworkError when the relays fail.
   */
  async #leaseAddress(
    pool: RelayPool,
    merchant: MerchantChannel,
    sale: Sale,
    terms: Omit<LeaseTerms, "address">,
    leasedAt: number | null,
    signal?: AbortSignal
  ): Promise<Leased | { status: "none" } | { status: "explorer_failed"; error: SattlemeError }> {
    const lot = await this.#lot(pool, merchant, signal);
    if (lot.length === 0) return { status: "none" };
    const relays = merchant.relays;
    // The leases, complete or not (the confirmation decides), and the addresses a witness names.
    const [leases, named] = await Promise.all([
      readLeases(pool, merchant.registry.key, lot, relays, {
        now: this.#seconds(),
        random: this.#random,
        signal
      }),
      readNamedAddresses(pool, seenOf(this.#access.key), lot, relays, {
        random: this.#random,
        signal
      })
    ]);
    if (!leases.answered) {
      throw new NetworkError("Fewer than a majority of the merchant's relays answered");
    }
    if ([...leases.records.values()].some((records) => records.some(isNewerLease))) {
      this.#logger.warn(
        "@sattleme/checkout: a lease of the integration's addresses has a newer format than this " +
          "version of @sattleme/checkout: update it"
      );
    }
    const now = this.#seconds();
    // Not where the read shows a record of the sale (its signature checked): an earlier call of
    // the order tried it, and a new lease could be of the second of its withdrawal, and either
    // replace the other.
    const free = shuffle(
      lot.filter((address) => {
        const records = leases.records.get(address)!;
        return (
          !named.has(address) &&
          !isLeased(records, now) &&
          !records.some((record) => record.event.pubkey === sale.author && record.signed())
        );
      }),
      this.#random
    );
    for (const address of free.slice(0, MAX_ADDRESS_TRIES)) {
      let txs: ExplorerTx[];
      try {
        txs = await merchant.explorer.read(this.#http(signal), (base, http) =>
          addressTransactions(base, address, http)
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (!(error instanceof NetworkError)) throw error;
        return { status: "explorer_failed", error };
      }
      const paid = txs.filter((tx) => paysTo(tx, address) > 0n);
      if (paid.length > 0) {
        // Paid on-chain already: of no order, for good.
        await this.#publishWitnessesOfNone(pool, merchant, address, paid, signal);
        continue;
      }
      // Published unconfirmed: it holds the address, never gives the invoice one.
      const event = leaseEvent({
        sale,
        terms: { ...terms, address, confirmed: false },
        createdAt: leasedAt ?? this.#seconds(),
        random: this.#random
      });
      let again: LeaseRead;
      try {
        await this.#publishLeaseRecord(pool, relays, event, sale, signal);
        // On every relay, each until its timeout: a relay that hides a lease cannot hide it while
        // one that holds it answers in time (SPEC.md §13, §27).
        again = await readLeases(pool, merchant.registry.key, [address], relays, {
          now: this.#seconds(),
          random: this.#random,
          signal,
          everyRelay: true
        });
      } catch (error) {
        // On some relays only (or the call cancelled): withdrawn, never the order's.
        await this.#withdraw(pool, relays, sale, address, event, signal);
        throw error;
      }
      const records = again.records.get(address)!;
      const confirmed = leaseConfirmed(again, address, event, this.#seconds());
      if (!confirmed) {
        // Another server leased it at once (the later reader sees both), the read could not be
        // complete, or fewer than a majority answered: withdrawn (safe on some relays only: the
        // address was never the order's), unless the read shows another record of the sale there
        // whose signature checks out, even from fewer than a majority: another call of the order
        // made it at once (its lock failed, SPEC.md §17), and it is not this call's to end.
        const another = records.some(
          (record) =>
            record.event.pubkey === sale.author && record.event.id !== event.id && record.signed()
        );
        if (!another) await this.#withdraw(pool, relays, sale, address, event, signal);
        if (!again.answered) {
          throw new NetworkError("Fewer than a majority of the merchant's relays answered");
        }
        // The next one.
        continue;
      }
      // Confirmed: never withdrawn from now on, whatever fails (a withdrawal on some relays only
      // would leave them disagreeing on an address that may be the order's). Marked confirmed:
      // from now on the address is the order's, its invoice's in §21 too.
      const marked = leaseEvent({
        sale,
        terms: { ...terms, address, confirmed: true },
        createdAt: Math.max(this.#seconds(), event.created_at + 1),
        random: this.#random
      });
      await this.#publishLeaseRecord(pool, relays, marked, sale, signal);
      return { status: "leased", address, event: marked };
    }
    return { status: "none" };
  }

  /**
   * Withdraws `lease`, the lease of `address` by `sale` that was not confirmed: its withdrawal, a
   * second after it (so that it replaces the lease, and no later record of the sale), published on
   * the merchant's `relays`; a failure only logged (the lease then holds its address until its end,
   * and never gives its invoice one).
   */
  async #withdraw(
    pool: RelayPool,
    relays: readonly string[],
    sale: Sale,
    address: string,
    lease: NostrEvent,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) return;
    const event = withdrawalEvent({
      sale,
      address,
      createdAt: lease.created_at + 1,
      random: this.#random
    });
    try {
      await pool.publishToQuorum(relays, event, sale.secretKey, majority(relays.length));
    } catch {
      if (signal?.aborted) return;
      this.#logger.warn(
        "@sattleme/checkout: a lease that was not confirmed could not be withdrawn; it " +
          "holds its deposit address until its end"
      );
    }
  }

  /** Publishes a lease record on a majority of the merchant's `relays`, else NetworkError. */
  async #publishLeaseRecord(
    pool: RelayPool,
    relays: readonly string[],
    event: NostrEvent,
    sale: Sale,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await pool.publishToQuorum(relays, event, sale.secretKey, majority(relays.length));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new NetworkError(
        "Fewer than a majority of the merchant's relays took the lease of a deposit address: " +
          "try again",
        { cause: error }
      );
    }
  }

  /** Publishes a witness none of each transaction of `txs` paying `address`, failures logged. */
  async #publishWitnessesOfNone(
    pool: RelayPool,
    merchant: MerchantChannel,
    address: string,
    txs: readonly ExplorerTx[],
    signal?: AbortSignal
  ): Promise<void> {
    const seen = seenOf(this.#access.key);
    await Promise.all(
      txs.map(async (tx) => {
        try {
          await publishWitness(
            pool,
            seen,
            {
              address,
              txid: tx.txid,
              sale: null,
              sats: paysTo(tx, address),
              inputs: tx.coins.slice(0, MAX_WITNESS_INPUTS),
              replacement: false,
              expiresAt: null
            },
            merchant.relays,
            { createdAt: this.#seconds(), random: this.#random, signal }
          );
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
          this.#logger.warn(
            `@sattleme/checkout: the witness of a paid address was not published: ${error.message}`
          );
        }
      })
    );
  }

  /** The integration's lot of deposit addresses, read on the merchant's relays. */
  #lot(pool: RelayPool, merchant: MerchantChannel, signal?: AbortSignal): Promise<string[]> {
    return readLot(pool, this.#access, merchant.relays, {
      signal,
      random: this.#random,
      logger: this.#logger
    });
  }

  /**
   * Publishes a new checkout link holding `value` on a majority of the merchant's relays, and gives
   * its URL. The author's secret answers the relays' authentication, then is dropped with the
   * link: nobody can change it afterwards. NetworkError when fewer than a majority took it.
   */
  async #publishCheckout(
    pool: RelayPool,
    merchant: MerchantChannel,
    value: CheckoutValue,
    expiresAt: number,
    signal?: AbortSignal
  ): Promise<string> {
    let link;
    try {
      link = newCheckoutLink({
        origin: merchant.checkoutOrigin!,
        relays: merchant.relays,
        value,
        expiresAt,
        createdAt: this.#seconds(),
        random: this.#random
      });
    } catch (error) {
      throw new InvalidInvoiceError("The invoice is too large for a checkout link", {
        cause: error
      });
    }
    try {
      await pool.publishToQuorum(
        merchant.relays,
        link.event,
        link.secretKey,
        majority(merchant.relays.length)
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new NetworkError(
        "Fewer than a majority of the merchant's relays took the checkout link: try again",
        { cause: error }
      );
    }
    return link.url;
  }

  /**
   * Refuses a new invoice for the sale while an earlier one may still be paid (until its end plus
   * 120 s, or while its on-chain payment is being confirmed or undecided), or when one was paid:
   * read in the registry, so that it holds even when the shop lost what it stored.
   */
  async #checkEarlierInvoices(
    pool: RelayPool,
    sale: Sale,
    merchant: MerchantChannel,
    order: CheckedOrder,
    signal?: AbortSignal
  ) {
    const records = await this.#declared(pool, sale, merchant, signal);
    const earlier = records.invoices;
    // A few at a time; a paid invoice wins over a service that did not answer about another one.
    const check = (invoices: readonly SaleDeclaration[]) =>
      settleEach(invoices, MAX_PARALLEL_PAYMENT_CHECKS, async ({ invoice }) => {
        const stored = storedOf(invoice);
        return statusOf(
          stored,
          await this.#check(stored, signal, { pool, merchant, records }),
          this.#seconds()
        );
      });
    const mayBePaid = mayStillBePaid(
      earlier.map(({ invoice }) => invoice),
      this.#seconds()
    ).map((index) => earlier[index]!);
    if (mayBePaid.length > 0) {
      // Their payments checked, even of one alone: an invoice already paid is never handed out
      // again. Several: an earlier createInvoice failed once a minority of the relays took its last
      // record, and a later one made another invoice and showed it; the sale's records are read on
      // every relay at the same time, and the one shown is the one a majority holds.
      const [statuses, everywhere] = await Promise.all([
        check(mayBePaid),
        mayBePaid.length > 1
          ? settle(this.#declared(pool, sale, merchant, signal, { everyRelay: true }))
          : null
      ]);
      if (signal?.aborted) throw signal.reason;
      const held = heldBy(
        mayBePaid,
        everywhere?.ok ? everywhere.value.sentBy : null,
        merchant.relays.length
      );
      const outcome = pendingOutcome(statuses, held);
      if ("paid" in outcome) {
        const status = statuses[outcome.paid] as PromiseFulfilledResult<
          Extract<PaymentStatus, { state: "paid" }>
        >;
        throw new OrderPaidError(mayBePaid[outcome.paid]!.invoice, status.value);
      }
      if ("failed" in outcome) throw (statuses[outcome.failed] as PromiseRejectedResult).reason;
      // Fewer than a majority answered the read again: after a payment and an error.
      if ("unread" in outcome) {
        throw everywhere?.ok === false
          ? everywhere.error
          : new NetworkError("Fewer than a majority of the merchant's relays answered");
      }
      const open = mayBePaid[outcome.handOut]!;
      // Its createInvoice may have failed with fewer than a majority of the relays holding its
      // declaration or its lease ("do not show this invoice"): published again before it is
      // handed out. Its lease, with an address, was confirmed (SPEC.md, "Leasing an address"):
      // the address is the order's.
      if (open.event) await this.#declare(pool, open.event, sale, merchant, signal);
      if (open.lease) await this.#publishLease(pool, open.lease, sale, merchant, signal);
      const { invoice } = open;
      // A new link to it, for a shop that lost the one it stored (or never got it): links only
      // show the invoice, several of them change nothing.
      const checkoutUrl = order.checkout
        ? await this.#publishCheckout(
            pool,
            merchant,
            checkoutValue({
              businessName: merchant.businessName,
              invoice: invoice.bolt11,
              verifyUrl: invoice.verifyUrl,
              onchainAddress: invoice.onchainAddress,
              sats: BigInt(invoice.sats),
              createdAt: invoice.createdAt,
              expiresAt: invoice.expiresAt,
              fiat: invoice.fiat
                ? {
                    minor: Number(invoice.fiat.minor),
                    digits: invoice.fiat.digits,
                    currency: invoice.fiat.currency
                  }
                : null,
              note: invoice.note,
              redirectUrl: order.redirectUrl,
              rest:
                invoice.onchainAddress === null
                  ? null
                  : restKeys(
                      this.#access.key,
                      order.ref,
                      invoice.onchainAddress,
                      invoice.expiresAt
                    ),
              bitcoinNode: recordNodeFor(merchant.bitcoinNode)
            }),
            invoice.expiresAt,
            signal
          )
        : null;
      throw new InvoicePendingError(invoice, checkoutUrl);
    }
    const statuses = await check(earlier);
    if (signal?.aborted) throw signal.reason;
    for (const [index, status] of statuses.entries()) {
      if (status.status === "fulfilled" && status.value.state === "paid") {
        throw new OrderPaidError(earlier[index]!.invoice, status.value);
      }
    }
    // An on-chain payment being confirmed, or a transaction undecided: its time to be paid is over,
    // nothing is published again, and no new link (the shop keeps the one it got, whose page goes
    // on following the payment).
    const pending = statuses.findIndex(
      (status) =>
        status.status === "fulfilled" &&
        (status.value.state === "unconfirmed" || status.value.state === "open")
    );
    if (pending >= 0) throw new InvoicePendingError(earlier[pending]!.invoice, null);
    const failed = statuses.find((status) => status.status === "rejected");
    if (failed) throw failed.reason;
  }

  /** Publishes a declaration on a majority of the merchant's relays, else NetworkError. */
  async #declare(
    pool: RelayPool,
    event: NostrEvent,
    sale: Sale,
    merchant: MerchantChannel,
    signal?: AbortSignal
  ) {
    try {
      await pool.publishToQuorum(
        merchant.relays,
        event,
        sale.secretKey,
        majority(merchant.relays.length)
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new NetworkError(
        "Fewer than a majority of the merchant's relays took the invoice's declaration: do not " +
          "show this invoice, try again",
        { cause: error }
      );
    }
  }

  /** Publishes a lease again on a majority of the merchant's relays, else NetworkError. */
  async #publishLease(
    pool: RelayPool,
    event: NostrEvent,
    sale: Sale,
    merchant: MerchantChannel,
    signal?: AbortSignal
  ) {
    try {
      await pool.publishToQuorum(
        merchant.relays,
        event,
        sale.secretKey,
        majority(merchant.relays.length)
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new NetworkError(
        "Fewer than a majority of the merchant's relays took the invoice's lease: do not show " +
          "this invoice, try again",
        { cause: error }
      );
    }
  }

  /**
   * Where the payment of an invoice is, checked: its Lightning part from the merchant's Lightning
   * address (LUD-21), its on-chain part from the explorer (mempool.space, or the merchant's Bitcoin
   * node with its fallback, SPEC.md §31) and the witnesses of its order, and the Lightning invoices
   * of the rest of an on-chain underpayment, all at once. `open` (not paid yet,
   * 120 s after its end included; `received` above 0 for an on-chain underpayment, whose `rest` is
   * still payable), `unconfirmed` (enough received in time, its on-chain part not 3 confirmations
   * deep yet), `paid` (in Lightning, with the preimage, the proof of payment; on-chain; or mixed:
   * on-chain and invoices of the rest), or `expired`, for good (but for a merchant's acceptance
   * a relay that holds it failed to give, SPEC.md §3). Underpaid on-chain, it asks the
   * merchant's Lightning address for an invoice of the rest, declares it and publishes it for the
   * order's checkout links (`rest.bolt11`; a failure is logged, the next check asks again). It
   * never opens the explorer's WebSocket. Throws NetworkError (retry) when a service does not
   * answer (the merchant's node with `fallback` `"none"` included: never `expired` for want of an
   * answer), InvalidInvoiceError when an answer is not about this invoice or its preimage is wrong.
   */
  async getStatus(invoice: InvoiceToCheck, options: CallOptions = {}): Promise<PaymentStatus> {
    const stored = checkStoredInvoice(invoice);
    return statusOf(stored, await this.#check(stored, options.signal), this.#seconds());
  }

  /**
   * Every part of `stored` checked at once (SPEC.md, "The on-chain payment"): its Lightning part,
   * and with an address its on-chain part and its rest part, read on the merchant's relays (over
   * `relays` when given, with the sale's records when already read; else over the connections of a
   * call of its own); an invoice of the rest asked when the status calls for one. A part that
   * fails is its error, never thrown; a cancellation is.
   */
  async #check(
    stored: StoredInvoice,
    signal?: AbortSignal,
    relays?: { pool: RelayPool; merchant: MerchantChannel; records?: SaleRecords },
    logger: Logger = this.#logger,
    call?: CallExplorer
  ): Promise<Parts> {
    const lightning: Promise<Settled<LightningPart> | null> = stored.lightning
      ? settle(verifyPayment(stored.lightning, this.#http(signal), this.#seconds()))
      : Promise.resolve(null);
    if (!stored.onchainAddress) {
      const parts: Parts = { lightning: await lightning, onchain: null, rests: null };
      if (signal?.aborted) throw signal.reason;
      return parts;
    }
    const run = (
      scope: { pool: RelayPool; merchant: MerchantChannel; records?: SaleRecords },
      call = signal
    ) => this.#addressParts(stored, scope, lightning, call, logger);
    try {
      return relays
        ? await run(relays)
        : await this.#withRelays(signal, async (pool, signal) => {
            const merchant = await this.#channel(pool, signal, logger, call?.failures);
            call?.onNode?.(merchant.bitcoinNode);
            return run({ pool, merchant }, signal);
          });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // The relays or the channel failed: the address's parts cannot be told.
      const failed: Settled<OnchainPart> = { ok: false, error };
      return { lightning: await lightning, onchain: failed, rests: null };
    }
  }

  /**
   * The on-chain part and the rest part of `stored` (it has an address and a reference), at once:
   * the sale's records (its rest invoices, its lease) read while the explorer is asked; then, when
   * the status is open with a rest and no invoice of it, one asked (#askRest); and the records of
   * its rest invoices published again where no relay holds them.
   */
  async #addressParts(
    stored: StoredInvoice,
    {
      pool,
      merchant,
      records
    }: { pool: RelayPool; merchant: MerchantChannel; records?: SaleRecords },
    lightningCheck: Promise<Settled<LightningPart> | null>,
    signal: AbortSignal | undefined,
    logger: Logger
  ): Promise<Parts> {
    const address = stored.onchainAddress!;
    const ref = stored.ref!;
    const sale = saleOf(this.#access.key, merchant.registry, ref);
    const http = this.#http(signal);
    const read = records
      ? Promise.resolve(records)
      : this.#declared(pool, sale, merchant, signal, { logger });
    const restCheck: Promise<Settled<RestPart>> = settle(
      read.then(async (found) => {
        // This invoice's own: another invoice of the order may have leased the address before.
        const invoices = found.rests.get(restKeyOf(address, stored.expiresAt)) ?? [];
        // One whose declaration may be on a minority of the relays only (its publication failed):
        // on a majority before it counts, is shown or recorded, else the rest part fails (network).
        for (const { paymentHash } of invoices) {
          const event = found.unsureRests.get(paymentHash);
          if (event) await this.#declare(pool, event, sale, merchant, signal);
        }
        const results = await Promise.all(
          invoices.map((invoice) =>
            settle(verifyPayment(lightningOf(invoice), http, this.#seconds()))
          )
        );
        return { invoices, results };
      })
    );
    // The order's tolerance, its lease's (the invoice's own terms): without the records, or another
    // lease of the address, none.
    const tolerance = read.then(
      (found) => {
        const terms = found.leases.get(address)?.terms;
        return terms && terms.sats === stored.sats && terms.expiresAt === stored.expiresAt
          ? terms.tolerance
          : 0;
      },
      () => 0
    );
    const seen = seenOf(this.#access.key);
    // The merchant's acceptance of this invoice: the team's record, read on every relay.
    const accepted = merchantAcceptanceKeys(
      this.#access.key,
      this.#access.teamPublicKey,
      sale.author,
      address,
      stored.expiresAt
    );
    const checkOnchain = (paidByRests: Promise<bigint>) =>
      checkOnchainPart({
        address,
        sats: stored.sats,
        expiresAt: stored.expiresAt,
        sale: sale.author,
        clock: () => this.#seconds(),
        explorer: merchant.explorer,
        http,
        readWitnesses: (options) =>
          readOrderWitnesses(pool, seen, address, sale.author, stored.expiresAt, merchant.relays, {
            random: this.#random,
            signal,
            everyRelay: options?.everyRelay ?? false
          }),
        witnessAddress: (txid, of) => witnessAddress(seen.addressKey, address, txid, of),
        publish: (witness) =>
          publishWitness(pool, seen, witness, merchant.relays, {
            createdAt: this.#seconds(),
            random: this.#random,
            signal
          }),
        logger,
        paidByRests,
        tolerance,
        readMerchantAcceptance: () =>
          readMerchantAcceptance(
            pool,
            accepted,
            { sats: stored.sats, expiresAt: stored.expiresAt },
            merchant.relays,
            { random: this.#random, signal }
          )
      });
    const onchainCheck = settle(
      // A rest invoice that failed counts as not paid: the on-chain part then needs more.
      checkOnchain(restCheck.then((rest) => (rest.ok ? restSummary(rest.value).paid : 0n)))
    );
    const [lightning, firstOnchain, restResult] = await Promise.all([
      lightningCheck,
      onchainCheck,
      restCheck
    ]);
    if (signal?.aborted) throw signal.reason;
    // The sale's records unread: whether a rest invoice was paid cannot be told.
    let rests: RestPart = restResult.ok
      ? restResult.value
      : { invoices: [], results: [], error: restResult.error };
    let onchain = firstOnchain;
    const parts: Parts = { lightning, onchain, rests };
    if (!restResult.ok) return parts;
    const found = await read;
    const now = this.#seconds();
    let status: PaymentStatus | null;
    try {
      status = statusOf(stored, parts, now);
    } catch {
      // A part failed: the status is its error, nothing is asked.
      status = null;
    }
    const lease = found.leases.get(address)?.terms ?? null;
    const ask =
      status?.state === "open"
        ? restToAsk({
            rest: status.rest,
            sats: stored.sats,
            expiresAt: stored.expiresAt,
            now,
            lease: lease && { sats: lease.sats, expiresAt: lease.expiresAt }
          })
        : null;
    /** The rest invoices whose rest record a majority took in this check. */
    const recorded = new Set<string>();
    if (ask && lease) {
      const asked = await this.#askRest(stored, ask, lease, rests.invoices, {
        pool,
        merchant,
        sale,
        signal,
        logger
      });
      if (asked) {
        if (asked.recorded) recorded.add(asked.invoice.paymentHash);
        rests = {
          invoices: [...rests.invoices, asked.invoice],
          results: [...rests.results, asked.result]
        };
        // Asked meanwhile by another check and paid already: less is due on-chain.
        if (isPaid(asked.result)) {
          onchain = await settle(checkOnchain(Promise.resolve(restSummary(rests).paid)));
          if (signal?.aborted) throw signal.reason;
        }
      }
    }
    if (rests.invoices.length > 0 && now < stored.expiresAt + GRACE_SECONDS) {
      const unrecorded = await this.#publishMissingRests(
        stored,
        rests.invoices,
        recorded,
        pool,
        merchant,
        signal,
        logger
      );
      rests = { ...rests, unrecorded };
    }
    await this.#publishAcceptance(
      stored,
      { lightning, onchain, rests },
      pool,
      merchant,
      signal,
      logger
    );
    return { lightning, onchain, rests };
  }

  /**
   * When the order's tolerance or the merchant's acceptance accepted less than its amount (the
   * status `parts` give is being confirmed, or paid on-chain), has the pages of its checkout links
   * know it (SPEC.md, "Acceptance records"): unless a majority of the merchant's relays hold what
   * it received, or less, publishes an acceptance record of it. A failure is logged, never the
   * check's: the next check publishes it again. Never the tolerance itself.
   */
  async #publishAcceptance(
    stored: StoredInvoice,
    parts: Parts,
    pool: RelayPool,
    merchant: MerchantChannel,
    signal: AbortSignal | undefined,
    logger: Logger
  ): Promise<void> {
    let status: PaymentStatus;
    try {
      status = statusOf(stored, parts, this.#seconds());
    } catch {
      // A part failed: nothing is accepted.
      return;
    }
    const keys = () =>
      restKeys(this.#access.key, stored.ref!, stored.onchainAddress!, stored.expiresAt);
    try {
      await publishAcceptance(pool, status, stored, keys, merchant.relays, {
        clock: () => this.#seconds(),
        random: this.#random,
        signal,
        logger
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!(error instanceof NetworkError)) throw error;
      logger.warn(
        `@sattleme/checkout: the acceptance record of a payment was not published (${error.message}); published again at the next check`
      );
    }
  }

  /**
   * Asks the merchant's Lightning address for an invoice of the rest `ask` gives, declares it with
   * `rest` (the price and note of the sale's `lease` of the address) on a majority of the
   * merchant's relays, then publishes its rest record (SPEC.md, "Asking for a rest invoice"). One
   * at a time per invoice in this process; another check's invoice of the same rest, declared
   * meanwhile, is taken instead. Null when none could be made: outside the address's sendable sats,
   * or a failure, logged as a warning (the next check asks again).
   */
  async #askRest(
    stored: StoredInvoice,
    ask: RestAsk,
    lease: LeaseTerms,
    known: readonly RestInvoice[],
    {
      pool,
      merchant,
      sale,
      signal,
      logger
    }: {
      pool: RelayPool;
      merchant: MerchantChannel;
      sale: Sale;
      signal?: AbortSignal | undefined;
      logger: Logger;
    }
  ): Promise<{
    invoice: RestInvoice;
    result: Settled<LightningPart>;
    /** Whether a majority took its rest record in this call. */
    recorded: boolean;
  } | null> {
    const address = stored.onchainAddress!;
    const key = `${sale.ref}/${address}`;
    const previous = this.#restAsks.get(key) ?? Promise.resolve();
    const run = previous.catch(ignore).then(async () => {
      if (signal?.aborted) throw signal.reason;
      const http = this.#http(signal);
      try {
        // Another check may have asked for it meanwhile.
        const again = await this.#declared(pool, sale, merchant, signal);
        const before = new Set(known.map(({ paymentHash }) => paymentHash));
        const meanwhile = (again.rests.get(restKeyOf(address, stored.expiresAt)) ?? []).find(
          (invoice) =>
            !before.has(invoice.paymentHash) &&
            invoice.sats === ask.sats &&
            this.#seconds() < invoice.expiresAt
        );
        if (meanwhile) {
          // On a majority, as any rest invoice found (a failure is logged below).
          const event = again.unsureRests.get(meanwhile.paymentHash);
          if (event) await this.#declare(pool, event, sale, merchant, signal);
          // Checked as any rest invoice: it may have been paid already.
          const result = await settle(verifyPayment(lightningOf(meanwhile), http, this.#seconds()));
          return { invoice: meanwhile, result, recorded: false };
        }
        const pay = await fetchPayRequest(merchant.lightningAddress, http);
        if (!sendable(ask.sats, sendableSats(pay))) return null;
        const now = this.#seconds();
        const expirySeconds = stored.expiresAt - now;
        if (expirySeconds < MIN_REST_SECONDS) return null;
        const answer = await requestInvoice(
          pay,
          { sats: ask.sats, expirySeconds, comment: lease.note },
          http
        );
        const decoded = checkInvoice(answer, {
          pay,
          sats: ask.sats,
          durationSeconds: expirySeconds,
          now: this.#seconds()
        });
        let event: NostrEvent;
        try {
          event = declarationEvent({
            sale,
            invoice: answer.pr,
            verifyUrl: answer.verify,
            paymentHash: decoded.paymentHash,
            price: lease.price,
            note: lease.note,
            createdAt: this.#seconds(),
            rest: { address, expiresAt: stored.expiresAt },
            random: this.#random
          });
        } catch (error) {
          throw new InvalidInvoiceError("The invoice is too large to be declared", {
            cause: error
          });
        }
        await this.#declare(pool, event, sale, merchant, signal);
        const invoice: RestInvoice = {
          bolt11: answer.pr,
          paymentHash: decoded.paymentHash,
          verifyUrl: answer.verify,
          sats: ask.sats,
          createdAt: decoded.timestamp,
          expiresAt: decoded.timestamp + decoded.expirySeconds
        };
        // Declared: it may be shown. Its record, for the checkout links' pages.
        const recorded = await this.#publishRest(stored, invoice, pool, merchant, signal, logger);
        const result: Settled<LightningPart> = { ok: true, value: { state: "open" } };
        return { invoice, result, recorded };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (!(error instanceof SattlemeError)) throw error;
        logger.warn(
          `@sattleme/checkout: no Lightning invoice of the rest of an underpayment (${error.message}); asked again at the next check`
        );
        return null;
      }
    });
    const settled = run.catch(ignore);
    this.#restAsks.set(key, settled);
    void settled.then(() => {
      if (this.#restAsks.get(key) === settled) this.#restAsks.delete(key);
    });
    return run;
  }

  /** Publishes the rest record of `invoice` on a majority; a failure only logged. */
  async #publishRest(
    stored: StoredInvoice,
    invoice: RestInvoice,
    pool: RelayPool,
    merchant: MerchantChannel,
    signal: AbortSignal | undefined,
    logger: Logger
  ): Promise<boolean> {
    const keys = restKeys(this.#access.key, stored.ref!, stored.onchainAddress!, stored.expiresAt);
    try {
      await publishRestRecord(
        pool,
        restRecordEvent({
          keys,
          invoice,
          expiresAt: stored.expiresAt,
          createdAt: this.#seconds(),
          random: this.#random
        }),
        keys,
        merchant.relays,
        signal
      );
      return true;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!(error instanceof NetworkError)) throw error;
      logger.warn(
        `@sattleme/checkout: the record of an invoice of the rest was not published (${error.message}); published again at the next check`
      );
      return false;
    }
  }

  /**
   * Publishes again the rest records of `invoices` that fewer than a majority of the relays sent
   * (their first publication may have failed), so that the checkout links' pages see each of them.
   * Gives the payment hashes of those still not known on a majority: neither sent by a majority nor
   * taken by one in this check (`recorded`, or published again here); when fewer than a majority
   * answered, all of them but `recorded`. Those are never the status's `bolt11`: the next check
   * tries again.
   */
  async #publishMissingRests(
    stored: StoredInvoice,
    invoices: readonly RestInvoice[],
    recorded: ReadonlySet<string>,
    pool: RelayPool,
    merchant: MerchantChannel,
    signal: AbortSignal | undefined,
    logger: Logger
  ): Promise<Set<string>> {
    const keys = restKeys(this.#access.key, stored.ref!, stored.onchainAddress!, stored.expiresAt);
    const read = await readRestRecords(
      pool,
      keys,
      { sats: stored.sats, createdAt: Number.MIN_SAFE_INTEGER, expiresAt: stored.expiresAt },
      merchant.relays,
      { random: this.#random, signal }
    );
    const unknown = invoices.filter(({ paymentHash }) => !recorded.has(paymentHash));
    // Not read: whether the page can see the others is not known.
    if (read === null) return new Set(unknown.map(({ paymentHash }) => paymentHash));
    if (read.newer.size > 0) {
      logger.warn(
        "@sattleme/checkout: a record of an invoice of the rest has a newer format than this " +
          "version of @sattleme/checkout: update it"
      );
    }
    const unrecorded = new Set<string>();
    for (const invoice of unknown) {
      if (read.held.has(invoice.paymentHash)) continue;
      // A record of a newer format at its address: a newer version recorded it, and it is never
      // written over (SPEC.md §12).
      if (read.newer.has(restRecordAddress(keys.key, invoice.paymentHash))) continue;
      if (!(await this.#publishRest(stored, invoice, pool, merchant, signal, logger))) {
        unrecorded.add(invoice.paymentHash);
      }
    }
    return unrecorded;
  }

  /**
   * Checks the payment until it is `paid` or `expired`: its Lightning part, and the invoices of the
   * rest of an on-chain underpayment, every `intervalMs`; its on-chain part (with an address) each
   * time the explorer's WebSocket (mempool.space's, or the merchant's Bitcoin node's with its
   * fallback) says something changed for the address, every 60 s at least, and at once when an
   * invoice of the rest is paid. Network errors are retried (one that each check
   * meets again logged once, and again only after it stopped), `onStatus` hears each status.
   * Rejects with `signal`'s reason when it aborts, and with any error that is not a network
   * one. An on-chain payment takes about 30 minutes to be `paid` once `unconfirmed`: a server that
   * cannot wait that long checks again later with getStatus.
   */
  async waitForPayment(
    invoice: InvoiceToCheck,
    { intervalMs, signal, onStatus }: WaitOptions = {}
  ): Promise<Extract<PaymentStatus, { state: "paid" | "expired" }>> {
    const interval = checkMilliseconds(
      intervalMs,
      DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS,
      MAX_INTERVAL_MS,
      "intervalMs"
    );
    optionalFunction(onStatus, "onStatus");
    const stored = checkStoredInvoice(invoice);
    // A failure each check meets again is logged once, and again only after it stopped (§23).
    const warnings = onceWarnings(this.#logger);
    if (stored.onchainAddress) {
      return this.#waitWithAddress(stored, interval, signal, onStatus, warnings);
    }
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      try {
        const parts = await this.#check(stored, signal, undefined, warnings.logger);
        const status = statusOf(stored, parts, this.#seconds());
        onStatus?.(status);
        if (status.state === "paid" || status.state === "expired") return status;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (!(error instanceof NetworkError)) throw error;
        warnings.failed(error);
      }
      warnings.checked();
      await sleep(interval, signal);
    }
  }

  /**
   * waitForPayment of an invoice with an address: each status combines the last result of each
   * part. A full check (#check: every part, an invoice of the rest asked when needed) at each
   * change the explorer's WebSocket pushes and every 60 s; between them, the Lightning invoice and
   * the rest invoices the last full check found, every `interval`.
   */
  #waitWithAddress(
    stored: StoredInvoice,
    interval: number,
    signal: AbortSignal | undefined,
    onStatus: WaitOptions["onStatus"],
    warnings: OnceWarnings
  ): Promise<Extract<PaymentStatus, { state: "paid" | "expired" }>> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      /** The last result of each part; undefined until it was checked once. */
      let lightning: Settled<LightningPart> | null | undefined = stored.lightning
        ? undefined
        : null;
      let onchain: Settled<OnchainPart> | null | undefined;
      let rests: RestPart | null = null;
      let done = false;
      let lightningTimer: ReturnType<typeof setTimeout> | null = null;
      let onchainTimer: ReturnType<typeof setTimeout> | null = null;
      let checking = false;
      let again = false;
      let lightningChecking = false;
      /** Full checks started, the last one that ended, and the first one a status must wait for. */
      let started = 0;
      let ended = 0;
      let waitFor = 0;
      /** The checks this call started, stopped once it ends: none runs on after it (SPEC.md §23). */
      const stop = new AbortController();
      /**
       * The explorer's WebSocket: of the node the last channel read names (SPEC.md §31), with its
       * fallback, opened once a check read the channel (before, whether mempool.space may be asked
       * is not known), and opened again when the channel names another node. The node's failures
       * are the call's, shared by its checks and its WebSocket.
       */
      const failures: NodeFailures = new Map();
      let watcher: { close: () => void } | null = null;
      let watched: string | null = null;
      const call: CallExplorer = {
        failures,
        onNode: (node) => {
          const key = node ? `${node.fallback} ${node.url}` : "mempool";
          if (done || key === watched) return;
          watcher?.close();
          watched = key;
          const explorer = new Explorer(node, failures, () => this.#now());
          watcher = watchAddress(
            this.#createSocket,
            explorer,
            stored.onchainAddress!,
            checkOnchain
          );
        }
      };
      const running = new Set<Promise<unknown>>();
      const track = <T>(promise: Promise<T>): Promise<T> => {
        running.add(promise);
        const forget = () => running.delete(promise);
        promise.then(forget, forget);
        return promise;
      };

      const finish = (outcome: () => void) => {
        if (done) return;
        done = true;
        if (lightningTimer !== null) clearTimeout(lightningTimer);
        if (onchainTimer !== null) clearTimeout(onchainTimer);
        watcher?.close();
        signal?.removeEventListener("abort", abort);
        stop.abort();
        // Settled once every check it started has stopped.
        void Promise.allSettled([...running]).then(outcome);
      };
      const abort = () => finish(() => reject(signal!.reason));
      const report = () => {
        if (done || lightning === undefined || onchain === undefined) return;
        // A rest invoice was paid after the last full check began: its on-chain part was judged
        // against what was due then, never combined with it (it might read underpaid for good).
        if (ended < waitFor) return;
        let status: PaymentStatus;
        try {
          status = statusOf(stored, { lightning, onchain, rests }, this.#seconds());
          onStatus?.(status);
        } catch (error) {
          if (!(error instanceof NetworkError)) finish(() => reject(error));
          else warnings.failed(error);
          return;
        }
        if (status.state === "paid" || status.state === "expired") {
          finish(() => resolve(status));
        }
      };
      /** Whether a Lightning invoice (the order's, or one of the rest) may still change. */
      const lightningPending = () => {
        const own = lightning === undefined || (lightning !== null && !isFinal(lightning));
        return own || (rests?.results.some((result) => !isFinal(result)) ?? false);
      };
      const scheduleLightning = (delay: number) => {
        if (done || lightningTimer !== null || lightningChecking || !lightningPending()) return;
        lightningTimer = setTimeout(checkLightning, delay);
      };
      const checkLightning = () => {
        lightningTimer = null;
        lightningChecking = true;
        const known = rests;
        void track(
          Promise.all([
            stored.lightning &&
            (lightning === undefined || (lightning !== null && !isFinal(lightning)))
              ? settle(verifyPayment(stored.lightning, this.#http(stop.signal), this.#seconds()))
              : Promise.resolve(lightning),
            Promise.all(
              (known?.invoices ?? []).map((invoice, index) =>
                isFinal(known!.results[index]!)
                  ? Promise.resolve(known!.results[index]!)
                  : settle(
                      verifyPayment(lightningOf(invoice), this.#http(stop.signal), this.#seconds())
                    )
              )
            )
          ])
        ).then(([own, results]) => {
          lightningChecking = false;
          if (done) return;
          if (own !== undefined) lightning = own;
          let paid = false;
          // A full check may have found other rest invoices meanwhile: its results stand.
          if (known && rests === known) {
            paid = results.some(
              (result, index) => isPaid(result) && !isPaid(known.results[index]!)
            );
            rests = { ...known, results };
          }
          // Paid by a rest invoice: what is due on-chain changed, a full check tells the status.
          if (paid) {
            waitFor = started + 1;
            checkOnchain();
          } else {
            report();
          }
          scheduleLightning(interval);
        });
      };
      const checkOnchain = () => {
        if (done) return;
        if (checking) {
          again = true;
          return;
        }
        checking = true;
        started += 1;
        const mine = started;
        // Every 60 s at least: a socket may go quiet without closing.
        if (onchainTimer !== null) clearTimeout(onchainTimer);
        onchainTimer = setTimeout(checkOnchain, ONCHAIN_CHECK_INTERVAL_MS);
        void track(this.#check(stored, stop.signal, undefined, warnings.logger, call)).then(
          (parts) => {
            checking = false;
            if (done) return;
            ended = mine;
            onchain = parts.onchain;
            rests = parts.rests;
            if (parts.lightning !== null) lightning = parts.lightning;
            report();
            // A full check ended: what it, and the checks of the Lightning invoices since the last
            // one, no longer met has stopped.
            warnings.checked();
            scheduleLightning(interval);
            if (again) {
              again = false;
              checkOnchain();
            }
          },
          (error: unknown) => {
            // A cancellation, or this call's end: `abort` or `finish` ended it.
            checking = false;
            if (!stop.signal.aborted) finish(() => reject(error));
          }
        );
      };

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      checkOnchain();
    });
  }

  /**
   * The invoices declared for the order `ref` in the merchant's registry, oldest first: to find an
   * order's invoice again after a failure. Read on a majority of the merchant's relays (any
   * declaration and lease was published on one); throws NetworkError when fewer answered.
   */
  async findInvoices(ref: string, { signal }: CallOptions = {}): Promise<DeclaredInvoice[]> {
    checkRef(ref);
    return this.#withRelays(signal, async (pool, signal) => {
      const merchant = await this.#channel(pool, signal);
      const sale = saleOf(this.#access.key, merchant.registry, ref);
      const declared = await this.#declared(pool, sale, merchant, signal);
      return declared.invoices.map(({ invoice }) => invoice);
    });
  }

  #declared(
    pool: RelayPool,
    sale: Sale,
    merchant: MerchantChannel,
    signal?: AbortSignal,
    { everyRelay = false, logger = this.#logger }: { everyRelay?: boolean; logger?: Logger } = {}
  ): Promise<SaleRecords> {
    return readSaleDeclarations(pool, sale, merchant.relays, { signal, logger, everyRelay });
  }

  /**
   * The integration's channel, read on the connections of `pool`, with the explorer of the call:
   * its node's failures in `failures` (a new call's own by default).
   */
  async #channel(
    pool: RelayPool,
    signal?: AbortSignal,
    logger: Logger = this.#logger,
    failures: NodeFailures = new Map()
  ): Promise<MerchantChannel> {
    const { channel } = await readChannel(pool, this.#access, {
      signal,
      random: this.#random,
      logger
    });
    return {
      businessName: channel.businessName,
      lightningAddress: channel.lightningAddress,
      registry: registryOf(channel.registryKey, channel.registryReader),
      relays: channel.relays ?? this.#access.relays,
      checkoutOrigin: channel.checkoutOrigin,
      tolerance: channel.tolerance,
      bitcoinNode: channel.bitcoinNode,
      explorer: new Explorer(channel.bitcoinNode, failures, () => this.#now())
    };
  }

  /**
   * Runs `run` with the relays of one call: one connection per relay, closed once the call is
   * done (a write still running past the quorum first ends, bounded by its timeout).
   */
  /**
   * Runs `run` over a pool of its own, with a signal of the call: aborted with `signal`, and once
   * `run` settled. What the call started ends when it returns: its HTTP requests by that signal, its
   * reads by the pool's release; only a publication's relays past its majority go on, each bounded
   * by its timeout (SPEC.md §13).
   */
  async #withRelays<T>(
    signal: AbortSignal | undefined,
    run: (pool: RelayPool, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const pool = new RelayPool({
      createSocket: this.#createSocket,
      timeoutMs: this.#relayTimeoutMs,
      signal,
      random: this.#random,
      now: () => this.#seconds()
    });
    const call = new AbortController();
    try {
      return await run(pool, signal ? AbortSignal.any([signal, call.signal]) : call.signal);
    } finally {
      call.abort();
      pool.release();
    }
  }

  #http(signal?: AbortSignal): HttpOptions {
    return { fetch: this.#fetch, timeoutMs: this.#httpTimeoutMs, signal };
  }

  #seconds(): number {
    return Math.floor(this.#now() / 1000);
  }
}

/** A deposit address leased for an order, with its lease. */
type Leased = { status: "leased"; address: string; event: NostrEvent };

/** The last result of each part of an invoice (null: it has none). */
type Parts = {
  lightning: Settled<LightningPart> | null;
  onchain: Settled<OnchainPart> | null;
  rests: RestPart | null;
};

/**
 * A record of a newer format at an address's lease: update the package. Its signature is not
 * checked (a record that holds never is): only a holder of the registry key seals one.
 */
function isNewerLease(record: LeaseRecord): boolean {
  return record.outside.kind === "newer";
}

/** The status of `stored` from its parts, at `now` (Unix seconds); throws a part's error. */
function statusOf(stored: StoredInvoice, parts: Parts, now: number): PaymentStatus {
  return combineParts(
    { sats: stored.sats, expiresAt: stored.expiresAt, address: stored.onchainAddress },
    now,
    parts.lightning,
    parts.onchain,
    parts.rests
  );
}

/** What the Lightning part of a payment check needs of a rest invoice. */
function lightningOf(invoice: RestInvoice): LightningInvoice {
  return {
    bolt11: invoice.bolt11,
    paymentHash: invoice.paymentHash,
    verifyUrl: invoice.verifyUrl,
    expiresAt: invoice.expiresAt
  };
}

/** Whether a Lightning part is final: paid, or expired for good. */
function isFinal(result: Settled<LightningPart>): boolean {
  return result.ok && result.value.state !== "open";
}

function isPaid(result: Settled<LightningPart>): boolean {
  return result.ok && result.value.state === "paid";
}

/** What a payment check asks of a declared invoice. */
function storedOf(invoice: DeclaredInvoice): StoredInvoice {
  return {
    ref: invoice.ref,
    lightning:
      invoice.bolt11 === null
        ? null
        : {
            bolt11: invoice.bolt11,
            paymentHash: invoice.paymentHash!,
            verifyUrl: invoice.verifyUrl!,
            expiresAt: invoice.expiresAt
          },
    onchainAddress: invoice.onchainAddress,
    sats: BigInt(invoice.sats),
    expiresAt: invoice.expiresAt
  };
}

/**
 * The warnings of the checks of one waitForPayment (SPEC.md §23): a warning each check meets again
 * (an explorer or a Lightning address that does not answer, a rest invoice that cannot be asked, a
 * witness that cannot be published) is logged once, and again only once a check went without it.
 */
type OnceWarnings = {
  logger: Logger;
  /** Warns of a check that failed (NetworkError): it is checked again. */
  failed: (error: NetworkError) => void;
  /** A check ended: a warning it did not meet stopped. */
  checked: () => void;
};

function onceWarnings(logger: Logger): OnceWarnings {
  let before = new Set<string>();
  let now = new Set<string>();
  const once: Logger = {
    warn: (message: string) => {
      if (!before.has(message) && !now.has(message)) logger.warn(message);
      now.add(message);
    }
  };
  return {
    logger: once,
    failed: (error) =>
      once.warn(`@sattleme/checkout: the payment check failed (${error.message}); checked again`),
    checked: () => {
      before = now;
      now = new Set();
    }
  };
}

/** The outcome of `promise`, never rejected. */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

/**
 * `items` in a random order, from the CSPRNG (so that two servers rarely try the same address
 * first): Fisher–Yates, each draw without bias.
 */
function shuffle<T>(items: readonly T[], random: RandomBytes): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const bound = i + 1;
    // The largest multiple of `bound` within 2^32: draws at or above it are drawn again.
    const limit = 2 ** 32 - (2 ** 32 % bound);
    let draw: number;
    do {
      const bytes = random(4);
      draw = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    } while (draw >= limit);
    const j = draw % bound;
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

/** Does nothing: the handler of a promise awaited later. */
const ignore = () => {};

/** A text of a deposit address's length (`bc1p` and 58 more): a lease's size before its address. */
const SIZED_ADDRESS = `bc1p${"q".repeat(58)}`;

/** `value` when it is a function, undefined when absent; InvalidOptionError otherwise. */
function optionalFunction<T>(value: T | undefined, name: string): T | undefined {
  if (value !== undefined && typeof value !== "function") {
    throw new InvalidOptionError(name, "a function");
  }
  return value;
}

/** `run` on every item, `limit` at a time: the outcome of each, in order (never rejects). */
async function settleEach<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await run(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
