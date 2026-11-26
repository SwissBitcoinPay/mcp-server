/*
 * Every constant of the protocol, in one place: SPEC.md (spec/, "Constants") gives each of them,
 * and every implementation, in any language, uses these values. Those marked "never changes" are
 * fixed by data already published (keys, channels, declarations): changing one loses merchants'
 * sales or stops their integrations.
 */

/**
 * The beginning of every integration key (`sattleme` sattle.me, `ck` checkout key). Never
 * changes: a later format of the key takes another prefix (`sattleme_ck2_`).
 */
export const INTEGRATION_KEY_PREFIX = "sattleme_ck_";
/** Bytes of the team's public key and of the integration's key. */
export const KEY_BYTES = 32;

/** HKDF-SHA256 salts (UTF-8). Never change. */
export const INTEGRATION_SALT = "sattle.me/integration";
export const SALE_SALT = "sattle.me/sale";
export const DECLARATION_SALT = "sattle.me/registry-declaration";

/** HKDF-SHA256 `info` strings (UTF-8). Never change. */
export const CHANNEL_ADDRESS_INFO = "channel/address/v1";
export const CHANNEL_ENCRYPTION_INFO = "channel/encryption-key/v1";
export const TAKER_INFO = "taker/v1";
export const SALE_NOSTR_SECRET_INFO = "nostr-secret-key/v1";
export const saleInfo = (ref: string) => `sale/${ref}/v1`;
export const outerInfo = (address: string, author: string) => `outer/v1/${address}/${author}`;
/** Bytes of HMAC-SHA256(taker key, author) kept as the taker tag. */
export const TAKER_TAG_BYTES = 16;

/** NIP-78 application data: every record of the app. */
export const RECORD_KIND = 30078;
/** NIP-42 authentication. */
export const AUTH_KIND = 22242;
/** A record's plaintext is padded with spaces to a multiple of this many bytes. */
export const RECORD_BLOCK_BYTES = 256;

export const CHANNEL_RECORD_TYPE = "team-channel";
export const CHANNEL_VERSION = 1;
/** At most this many moves of the merchant's relays are followed. */
export const MAX_RELAY_MOVES = 3;
/** Longest business name, in Unicode code points. */
export const MAX_BUSINESS_NAME_LENGTH = 200;

export const DECLARATION_RECORD_TYPE = "registry-declaration";
export const DECLARATION_VERSION = 1;
/** The currency of a sale declared in sats: its `minor` is the sats, its `digits` 0. */
export const SATS_CURRENCY = "SAT";
/** Most decimals a declared price may have. */
export const MAX_DECLARED_DIGITS = 8;
/** Largest amount in minor units (2^53 − 1: a JSON number every reader holds exactly). */
export const MAX_MINOR_UNITS = 9_007_199_254_740_991n;

/**
 * Checkout links (SPEC.md, "Checkout links"): a URL of the merchant's web app that shows the
 * customer the invoice, checks its payment and sends the customer back once it is paid. The salt
 * and `info` strings never change: the merchant's web app derives the same keys.
 */
export const CHECKOUT_SALT = "sattle.me/checkout";
export const CHECKOUT_ADDRESS_INFO = "address/v1";
export const CHECKOUT_ENCRYPTION_INFO = "encryption-key/v1";
export const CHECKOUT_RECORD_TYPE = "checkout";
export const CHECKOUT_VERSION = 1;
/** The first part of a checkout link's fragment: a link of this version. Never changes. */
export const CHECKOUT_MARKER = "c";
/** The page of the merchant's web app that reads checkout links. */
export const CHECKOUT_PATH = "/pay";
/** A checkout link's record lives this long after its invoice's end (NIP-40): a week. */
export const CHECKOUT_LIFE_SECONDS = 604_800;
/** Longest redirect URL, in characters (ASCII only). */
export const MAX_REDIRECT_URL_LENGTH = 2048;
/** Longest scheme of an app's redirect URL. */
export const MAX_REDIRECT_SCHEME_LENGTH = 32;
/**
 * Schemes a redirect URL never has: the browser's own, files and scripts; other browsers (they
 * open any web page given in the rest of the link, whose host the page would not show: a web page
 * is an https URL); other transports; any Android activity; payments (a second invoice right
 * after the first); calls and messages; installing software or running system tools. `https`
 * follows its own rule.
 */
export const REFUSED_REDIRECT_SCHEMES: ReadonlySet<string> = new Set([
  "about",
  "blob",
  "chrome",
  "chrome-extension",
  "content",
  "data",
  "file",
  "filesystem",
  "javascript",
  "moz-extension",
  "resource",
  "safari-extension",
  "vbscript",
  "view-source",
  "brave",
  "com-apple-mobilesafari-tab",
  "ddgquicklink",
  "firefox",
  "firefox-focus",
  "googlechrome",
  "googlechrome-x-callback",
  "googlechromes",
  "microsoft-edge",
  "microsoft-edge-http",
  "microsoft-edge-https",
  "onionbrowser",
  "onionbrowsers",
  "opera-http",
  "opera-https",
  "x-safari-http",
  "x-safari-https",
  "ftp",
  "http",
  "ws",
  "wss",
  "android-app",
  "intent",
  "bitcoin",
  "keyauth",
  "lightning",
  "liquidnetwork",
  "lnurl",
  "lnurlc",
  "lnurlp",
  "lnurlw",
  "callto",
  "facetime",
  "facetime-audio",
  "mailto",
  "sip",
  "sms",
  "tel",
  "itms-services",
  "ms-msdt",
  "search-ms"
]);

/** Most relays a list holds, and the longest relay address (`wss://` included). */
export const MAX_RELAYS = 10;
export const MAX_RELAY_URL_LENGTH = 120;
/** Longest host of a relay address, a checkout origin, a redirect URL or an https URL. */
export const MAX_HOST_LENGTH = 253;
/** Longest https URL (a pay URL, a callback, a verify URL), in characters (ASCII only). */
export const MAX_HTTPS_URL_LENGTH = 2048;

/** An order's reference: one order, one sale. */
export const REF_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
export const REF_RULE = "1 to 64 characters A-Z a-z 0-9 . _ : -";
/** Invoice durations, in seconds. */
export const MIN_DURATION_SECONDS = 60;
export const MAX_DURATION_SECONDS = 3600;
export const DEFAULT_DURATION_SECONDS = 900;
/** Longest note, in Unicode code points. */
export const MAX_NOTE_LENGTH = 100;

/**
 * After an invoice's end, a payment of its last seconds may still be reported (99 % within 103 s
 * over 575 payments measured, SPEC.md "Payment check"): until then, "not paid" is not final.
 */
export const GRACE_SECONDS = 120;
/** An invoice's date may be this far from the server's clock (synchronized by NTP). */
export const CLOCK_TOLERANCE_SECONDS = 300;
/** The LUD-21 refusal that means "never paid" once the grace period is over. */
export const NOT_FOUND_REASON = "Not found";

/** A dated price older than this is refused; one dated further than CLOCK_TOLERANCE ahead too. */
export const MAX_RATE_AGE_SECONDS = 3600;
/** Longest price text a rate source may give. */
export const MAX_PRICE_LENGTH = 64;
/** Largest exponent (either sign) of a price written in exponent notation. */
export const MAX_PRICE_EXPONENT = 64;

/** Most events read from one relay for one query, and most pages of a paged read. */
export const MAX_EVENTS_PER_QUERY = 1000;
export const MAX_PAGES = 20;
/**
 * The `limit` of each page of a complete read (SPEC.md, "Complete reads": the leases of deposit
 * addresses, which anybody may write at): a page of fewer events is the relay's last.
 */
export const COMPLETE_READ_LIMIT = 100;
/**
 * The User-Agent of every HTTP request: the same in every implementation and version (CoinGecko
 * refuses a request without one; one naming a language or a version would help single it out).
 */
export const USER_AGENT = "sattleme-Checkout/1";
/** Largest message read from a relay, and largest HTTP answer body read. */
export const MAX_RELAY_MESSAGE_BYTES = 1 << 20;
export const MAX_HTTP_BODY_BYTES = 1 << 20;
/** Earlier invoices of an order checked at once (createInvoice). */
export const MAX_PARALLEL_PAYMENT_CHECKS = 4;

/** Per request timeouts, in milliseconds: the default and the bounds a caller may choose. */
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 60_000;
/** waitForPayment's interval, in milliseconds. */
export const DEFAULT_INTERVAL_MS = 2000;
export const MIN_INTERVAL_MS = 250;
export const MAX_INTERVAL_MS = 60_000;

/** Longest `x` (expiry) field of a BOLT11 invoice, in 5-bit words (35 bits, as its date). */
export const MAX_BOLT11_EXPIRY_WORDS = 7;
/** Largest BOLT11 amount: 21 million bitcoins, in millisatoshis. */
export const MAX_BOLT11_AMOUNT_MSAT = 2_100_000_000_000_000_000n;

/**
 * On-chain payments (SPEC.md, "On-chain payments"): an order also takes a Bitcoin transaction to a
 * deposit address of the merchant's wallet, leased from the lot the merchant's app gives the
 * integration. The types, salts and `info` strings never change: the merchant's app reads the
 * same records.
 */
/** Below this amount, an order is Lightning only. */
export const ONCHAIN_FLOOR_SATS = 1000n;
/** The largest amount of an order: 21 million bitcoins, in sats. */
export const MAX_SATS = 2_100_000_000_000_000n;
export const SATS_PER_BTC = 100_000_000n;
/** The version of a checkout link's record for an invoice with an address. */
export const CHECKOUT_ONCHAIN_VERSION = 2;

export const LOT_RECORD_TYPE = "integration-onchain-lot";
export const LOT_VERSION = 1;
export const LOT_ADDRESS_INFO = "onchain-lot/address/v1";
/** Most addresses a lot holds. */
export const MAX_LOT_ADDRESSES = 100;

export const LEASE_RECORD_TYPE = "registry-onchain";
export const LEASE_VERSION = 1;
/** What a deposit address's registry address is the HMAC of: this, then the address (UTF-8). */
export const LEASE_ADDRESS_PREFIX = "onchain/v1/";
/**
 * Leases read back this far: a lease ends at most 4 320 s after its `created_at` (a BOLT11 date up
 * to 300 s ahead, 3600 s, the grace period, the clock tolerance).
 */
export const LEASE_LOOKBACK_SECONDS = 7200;
/** Free addresses tried for one order. */
export const MAX_ADDRESS_TRIES = 3;

export const WITNESS_RECORD_TYPE = "integration-onchain-seen";
export const WITNESS_VERSION = 1;
export const SEEN_SECRET_INFO = "onchain-seen/nostr-secret-key/v1";
export const SEEN_ADDRESS_KEY_INFO = "onchain-seen/address-key/v1";
/**
 * The tag of a witness that names its order (its address and sale), and its address (the address
 * tag: every witness of an address is found by it, whatever its sale).
 */
export const ORDER_TAG = "o";
/** The coins of a transaction a witness keeps: its first 100. */
export const MAX_WITNESS_INPUTS = 100;
/** The `sale` a witness names when the transaction came at no lease's time. */
export const NO_SALE = "none";

/**
 * mempool.space (Esplora REST): the explorer, unless the channel names the merchant's Bitcoin node
 * (onchain/node.ts), and the node's fallback when it says `"mempool"`.
 */
export const MEMPOOL_URL = "https://mempool.space/api";
/** mempool.space's WebSocket, which waitForPayment watches an address on without a node. */
export const MEMPOOL_WEBSOCKET_URL = "wss://mempool.space/api/v1/ws";
/** When a transaction was received, asked only for one no check saw while its lease ran. */
export const BLOCKCYPHER_URL = "https://api.blockcypher.com/v1/btc/main";
/** Confirmations of an on-chain payment, on the explorer read. */
export const CONFIRMATIONS = 3;
/** A node URL (SPEC.md §31, "A node URL"): 200 characters at most. */
export const MAX_NODE_URL_LENGTH = 200;
/**
 * A node that failed a read less than this long ago, in the same call, is asked after mempool.space
 * (`fallback` `"mempool"`): a node that does not answer does not make each read wait for it.
 */
export const NODE_FAILED_RECENTLY_MS = 60_000;
/** The on-chain part is checked at least this often while waitForPayment waits. */
export const ONCHAIN_CHECK_INTERVAL_MS = 60_000;
/** The explorer's WebSocket, lost: connected again after this, doubled at each failure… */
export const RECONNECT_FIRST_MS = 1000;
/** …up to this. */
export const RECONNECT_MAX_MS = 30_000;

/**
 * The rest of an on-chain underpayment (SPEC.md, "The rest of an underpayment"): a Lightning
 * invoice of what is left to pay, asked by a payment check, declared with `rest` and shown to the
 * pages of the order's checkout links by a rest record. The type, the salts and the `info` strings
 * never change: the merchant's web app reads the same records.
 */
export const REST_RECORD_TYPE = "checkout-rest";
export const REST_VERSION = 1;
/**
 * HKDF `info` of the rest key and the rest secret of the invoice of the order `ref` with the
 * deposit address `address` and the end `expiresAt` (Unix seconds, decimal): an invoice's own, never
 * another invoice's of the order that leased the same address.
 */
export const restKeyInfo = (ref: string, address: string, expiresAt: number) =>
  `checkout-rest/${ref}/${address}/${expiresAt}/key/v1`;
export const restSecretInfo = (ref: string, address: string, expiresAt: number) =>
  `checkout-rest/${ref}/${address}/${expiresAt}/nostr-secret-key/v1`;
/** HKDF `info` (salt CHECKOUT_SALT) of a rest record's encryption key and of its address. */
export const REST_ENCRYPTION_INFO = "rest/encryption-key/v1";
export const restAddressInfo = (paymentHash: string) => `rest/address/${paymentHash}/v1`;
/** A rest invoice is asked only with this long left before the invoice's end. */
export const MIN_REST_SECONDS = 60;

/**
 * The merchant's tolerance of on-chain underpayments (SPEC.md, "The merchant's tolerance"): an
 * integer of basis points, from 0 to MAX_TOLERANCE (10 %); anything else is 0. An order whose
 * payment in time reaches its amount less that share is paid.
 */
export const MAX_TOLERANCE = 1000;
/** Basis points in a whole. */
export const TOLERANCE_SCALE = 10_000n;

/**
 * Acceptance records (SPEC.md, "Acceptance records"): they tell the pages of an order's checkout
 * links that the payment its tolerance accepted counts, never the tolerance. Sealed with the rest
 * encryption key, signed by the rest secret, at an address the rest key derives (salt
 * CHECKOUT_SALT). The type and the `info` string never change: the merchant's web app reads them.
 */
export const ACCEPTANCE_RECORD_TYPE = "checkout-accepted";
export const ACCEPTANCE_VERSION = 1;
export const ACCEPTANCE_ADDRESS_INFO = "rest/accepted/v1";

/**
 * The merchant's acceptance (SPEC.md, "The merchant's acceptance"): the merchant accepts by hand,
 * in its app, what an order underpaid on-chain received as paying it. A record of the team (never
 * the integration's: it opens one but cannot make one), sealed with the channel's key, at an
 * address the integration key derives (salt INTEGRATION_SALT) from the order's sale author, the
 * invoice's deposit address and its `expiresAt` (Unix seconds, decimal). The type and the `info`
 * string never change: the merchant's app writes the same records.
 */
export const MERCHANT_ACCEPTANCE_RECORD_TYPE = "integration-onchain-accepted";
export const MERCHANT_ACCEPTANCE_VERSION = 1;
export const merchantAcceptanceInfo = (sale: string, address: string, expiresAt: number) =>
  `onchain-accepted/${sale}/${address}/${expiresAt}/v1`;
