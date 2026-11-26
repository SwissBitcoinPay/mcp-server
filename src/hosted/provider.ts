import { createHash } from "node:crypto";

import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  ServerError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { preferredLocales } from "../pdf/region.js";

import { ClientDocumentError, type ClientDocuments, isDocumentClientId } from "./cimd.js";
import { consentPage, selfHostedHost } from "./consent.js";
import { redirectsAllowed } from "./redirects.js";
import type { Sealer } from "./seal.js";

/*
 * The hosted server's OAuth 2.1 (SPEC.md §16, §17), with nothing stored: a registered client is its
 * client_id (its metadata, sealed), the merchant's consent is a page of the server's own where the
 * merchant gives the assistant key once, and the key then travels sealed inside the authorization
 * code and the tokens, which only this server opens. PKCE (S256) is checked by the SDK's token
 * endpoint; a code is used once (remembered until it expires).
 *
 * Any MCP client may register (Claude, ChatGPT, an IDE…), with redirect URIs as OAuth allows them
 * (redirects.ts): anyone can register a client, so the consent page shows where the code goes, for
 * the merchant to check, and the server may be limited to listed redirect URIs.
 */

export const ACCESS_SECONDS = 3600;
export const REFRESH_SECONDS = 30 * 86_400;
const CODE_SECONDS = 120;
const CONSENT_SECONDS = 15 * 60;
const CLIENT_SECONDS = 365 * 86_400;
export const SCOPE = "invoices";

export type ProviderOptions = {
  sealer: Sealer;
  /** The MCP endpoint's URL: the resource every token is for (RFC 8707). */
  resource: URL;
  /** Redirect URIs a client may register, exactly; null: any that the rules allow. */
  allowedRedirects: readonly string[] | null;
  /** The clients whose client_id is their metadata document's URL (cimd.ts). */
  documents: ClientDocuments;
  /** Unix seconds. */
  now: () => number;
};

/** A client's metadata, as its client_id seals it: what the endpoints read of it. */
type SealedClient = {
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  client_name?: string;
  issued: number;
};

/** Whether two resource URLs are the same, fragment and one trailing slash aside (as the SDK). */
export function sameResource(a: URL, b: URL): boolean {
  const plain = (url: URL) => {
    const copy = new URL(url.href);
    copy.hash = "";
    return copy.href.endsWith("/") ? copy.href.slice(0, -1) : copy.href;
  };
  return plain(a) === plain(b);
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

/**
 * A client whose client_id is its metadata document's URL (cimd.ts). Never redirected to on a
 * failure (the SDK answers it): invalid_client when its document cannot serve, a server error
 * while its server cannot be reached.
 */
async function documentClient(
  documents: ClientDocuments,
  clientId: string
): Promise<OAuthClientInformationFull> {
  try {
    return await documents.client(clientId);
  } catch (error) {
    if (error instanceof ClientDocumentError && !error.transient) {
      throw new InvalidClientError(`Client ID metadata document: ${error.message}`);
    }
    throw new ServerError("Client ID metadata document unreachable, try again");
  }
}

export class SealedProvider implements OAuthServerProvider {
  readonly #options: ProviderOptions;
  /** Codes redeemed, by hash, until they expire: a code works once. */
  readonly #redeemed = new Map<string, number>();

  constructor(options: ProviderOptions) {
    this.#options = options;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const { sealer, allowedRedirects, now, documents } = this.#options;
    return {
      getClient: (
        clientId: string
      ): OAuthClientInformationFull | undefined | Promise<OAuthClientInformationFull> => {
        if (isDocumentClientId(clientId)) return documentClient(documents, clientId);
        const value = sealer.open("client", clientId, now());
        if (!value || !Array.isArray(value.redirect_uris)) return undefined;
        const client = value as unknown as SealedClient;
        return {
          client_id: clientId,
          client_id_issued_at: client.issued,
          redirect_uris: client.redirect_uris,
          token_endpoint_auth_method: client.token_endpoint_auth_method,
          ...(client.client_secret ? { client_secret: client.client_secret } : {}),
          ...(client.client_secret_expires_at !== undefined
            ? { client_secret_expires_at: client.client_secret_expires_at }
            : {}),
          ...(client.client_name ? { client_name: client.client_name } : {}),
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: SCOPE
        };
      },
      registerClient: (client) => {
        const redirects = client.redirect_uris.map(String);
        if (!redirectsAllowed(redirects, allowedRedirects)) {
          throw new InvalidClientMetadataError(
            "Redirect URIs: 1 to 10, https, http on a loopback address, or an app's own scheme"
          );
        }
        const issued = now();
        const sealed: SealedClient = {
          redirect_uris: redirects,
          token_endpoint_auth_method: client.token_endpoint_auth_method ?? "client_secret_basic",
          ...(client.client_secret ? { client_secret: client.client_secret } : {}),
          ...(client.client_secret_expires_at !== undefined
            ? { client_secret_expires_at: client.client_secret_expires_at }
            : {}),
          ...(text(client.client_name, 100) ? { client_name: client.client_name } : {}),
          issued
        };
        const clientId = sealer.seal("client", sealed, issued + CLIENT_SECONDS);
        return { ...client, client_id: clientId, client_id_issued_at: issued };
      }
    };
  }

  /** The consent page: the merchant gives the assistant key there, never to the model. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    if (params.resource && !sameResource(params.resource, this.#options.resource)) {
      res.status(400).send("Unknown resource");
      return;
    }
    const request = this.#options.sealer.seal(
      "consent",
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        ...(params.state !== undefined ? { state: params.state } : {})
      },
      this.#options.now() + CONSENT_SECONDS
    );
    consentPage(res, {
      request,
      clientName: client.client_name ?? "Une application sans nom",
      verifiedHost: isDocumentClientId(client.client_id) ? new URL(client.client_id).host : null,
      redirectUri: params.redirectUri,
      error: null,
      selfHosted: selfHostedHost(this.#options.resource)
    });
    return Promise.resolve();
  }

  /**
   * The code of a consent the merchant gave with `keyText` (checked by the caller), from a browser
   * that prefers `preferences` (its Accept-Language): the tokens carry them, sealed, for the
   * region of the merchant's invoices (pdf/region.ts).
   */
  codeFor(
    consent: { clientId: string; redirectUri: string; codeChallenge: string },
    keyText: string,
    preferences: readonly string[] = []
  ): string {
    return this.#options.sealer.seal(
      "code",
      { ...consent, key: keyText, preferences: preferredLocales(preferences) },
      this.#options.now() + CODE_SECONDS
    );
  }

  #code(client: OAuthClientInformationFull, code: string) {
    const value = this.#options.sealer.open("code", code, this.#options.now());
    if (!value || value.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return value as {
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      key: string;
      preferences?: unknown;
    };
  }

  challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return Promise.resolve(this.#code(client, code).codeChallenge);
  }

  /**
   * `preferences`: what a sealed value holds of them, read as from outside (a token sealed by an
   * earlier release holds none).
   */
  #tokens(clientId: string, key: string, preferences: unknown): OAuthTokens {
    const now = this.#options.now();
    const resource = this.#options.resource.href;
    const preferred = preferredLocales(Array.isArray(preferences) ? preferences : []);
    return {
      access_token: this.#options.sealer.seal(
        "access",
        { clientId, key, resource, preferences: preferred, until: now + ACCESS_SECONDS },
        now + ACCESS_SECONDS
      ),
      token_type: "Bearer",
      expires_in: ACCESS_SECONDS,
      scope: SCOPE,
      refresh_token: this.#options.sealer.seal(
        "refresh",
        { clientId, key, resource, preferences: preferred },
        now + REFRESH_SECONDS
      )
    };
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const value = this.#code(client, code);
    if (redirectUri !== undefined && redirectUri !== value.redirectUri) {
      throw new InvalidGrantError("The redirect URI is not the authorization's");
    }
    if (resource && !sameResource(resource, this.#options.resource)) {
      throw new InvalidGrantError("Unknown resource");
    }
    const now = this.#options.now();
    for (const [hash, until] of this.#redeemed) if (until <= now) this.#redeemed.delete(hash);
    const hash = createHash("sha256").update(code).digest("hex");
    if (this.#redeemed.has(hash)) throw new InvalidGrantError("Authorization code already used");
    this.#redeemed.set(hash, now + CODE_SECONDS);
    return Promise.resolve(this.#tokens(client.client_id, value.key, value.preferences));
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const value = this.#options.sealer.open("refresh", refreshToken, this.#options.now());
    if (!value || value.clientId !== client.client_id || typeof value.key !== "string") {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !sameResource(resource, this.#options.resource)) {
      throw new InvalidGrantError("Unknown resource");
    }
    return Promise.resolve(this.#tokens(client.client_id, value.key, value.preferences));
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    const now = this.#options.now();
    const value = this.#options.sealer.open("access", token, now);
    if (!value || typeof value.key !== "string" || typeof value.clientId !== "string") {
      throw new InvalidTokenError("Invalid or expired token");
    }
    if (typeof value.until !== "number") throw new InvalidTokenError("Invalid or expired token");
    return Promise.resolve({
      token,
      clientId: value.clientId,
      scopes: [SCOPE],
      expiresAt: value.until,
      ...(typeof value.resource === "string" ? { resource: new URL(value.resource) } : {}),
      extra: {
        key: value.key,
        preferences: preferredLocales(Array.isArray(value.preferences) ? value.preferences : [])
      }
    });
  }
}
