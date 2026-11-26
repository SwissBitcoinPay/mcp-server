import { createHash } from "node:crypto";

import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { Assistant } from "../assistant.js";
import { logo } from "../brand.js";
import { createMcpServer, listAllowedTools } from "../mcp/tools.js";
import { invoiceFileName, loadFonts } from "../pdf/invoice-pdf.js";
import { acceptedLanguages, preferredLocales } from "../pdf/region.js";
import { EXPORT_COLUMNS } from "../export/csv.js";
import type { ExportRequest } from "../export/export.js";
import { isLanguage } from "../protocol/constants.js";
import type { Language } from "../protocol/constants.js";
import type { Services } from "../protocol/context.js";
import { InvalidAssistantKeyError } from "../protocol/key.js";

import {
  ClientDocuments,
  type DocumentFetcher,
  fetchDocument,
  isDocumentClientId
} from "./cimd.js";
import { consentPage, infoPage, selfHostedHost } from "./consent.js";
import { SCOPE, SealedProvider } from "./provider.js";
import type { Sealer } from "./seal.js";

/*
 * The hosted server (SPEC.md §16): mcp.sattle.me, an MCP server over Streamable HTTP for any AI app
 * (Claude, ChatGPT…). OAuth 2.1 with dynamic client registration, the merchant's consent on
 * the server's own page, and the MCP endpoint stateless: each request makes its server and
 * transport, opens the key its token seals, and forgets both once answered. Nothing is stored.
 */

export type HostedOptions = {
  sealer: Sealer;
  /** The server's public origin: https://mcp.sattle.me. */
  publicUrl: URL;
  /** Redirect URIs a client may register, exactly; null: any that the rules allow (redirects.ts). */
  allowedRedirects: readonly string[] | null;
  services: () => Services;
  timeZone: string;
  language: Language;
  version: string;
  /** Unix seconds. */
  now?: () => number;
  /** Behind a reverse proxy: how many hops to trust for the client's address (rate limits). */
  trustProxy?: number;
  /** How clients' metadata documents are fetched (cimd.ts); tests replace it. */
  fetchClientDocument?: DocumentFetcher;
  /**
   * The token OpenAI's plugin portal asks the server to serve while it verifies the domain
   * (MCP_OPENAI_APPS_CHALLENGE, docs/HOSTING.md), or null: no such page.
   */
  openaiAppsChallenge?: string | null;
};

/** How long a link of invoice_pdf downloads its PDF (seconds). */
export const PDF_LINK_SECONDS = 15 * 60;

/** Claude's connectors' redirect URIs (support.claude.com, article 11503834). */
export const CLAUDE_REDIRECTS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback"
] as const;

/** The assistant key a verified token carries ("" when none). */
function tokenKey(req: Request): string {
  const key = req.auth?.extra?.key;
  return typeof key === "string" ? key : "";
}

/** The languages of the browser the merchant connected with, as its token seals them. */
function tokenPreferences(req: Request): string[] {
  const preferences = req.auth?.extra?.preferences;
  return preferredLocales(Array.isArray(preferences) ? preferences : []);
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/*
 * The last error handler: Express's own writes each error to the console, a body that fails to
 * parse included (a client's name, an address…), and its stack in the answer outside production.
 * Here, nothing of a request is written: a client's error (a body too large, not JSON…) is answered
 * with its status only; an error of the server's writes its kind, never its message.
 */
// Express knows an error handler by its four parameters, the last one unused here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function quietErrors(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = (error as { status?: unknown } | null)?.status;
  const clientError = typeof status === "number" && status >= 400 && status < 500;
  if (!clientError) {
    const kind = error instanceof Error ? error.name : typeof error;
    process.stderr.write(`sattle.me hosted assistant: internal error (${kind})\n`);
  }
  if (res.headersSent) {
    // Halfway through an answer: only cutting it is left.
    res.destroy();
    return;
  }
  res
    .status(clientError ? status : 500)
    .json({ error: clientError ? "invalid_request" : "server_error" });
}

export function createHostedApp(options: HostedOptions) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  // The MCP endpoint is the origin itself (https://mcp.sattle.me): the address merchants paste.
  const mcpUrl = new URL("/", options.publicUrl);
  // Anyone may run this server: its pages say when sattle.me does not (consent.ts).
  const selfHosted = selfHostedHost(options.publicUrl);
  const provider = new SealedProvider({
    sealer: options.sealer,
    resource: mcpUrl,
    allowedRedirects: options.allowedRedirects,
    documents: new ClientDocuments({
      fetch: options.fetchClientDocument ?? fetchDocument,
      now,
      allowedRedirects: options.allowedRedirects,
      own: [options.publicUrl.href, mcpUrl.origin]
    }),
    now
  });
  const issuer = options.publicUrl.href;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy ?? 0);

  // The resource's metadata (RFC 9728) names it without a trailing slash, as MCP clients write the
  // address (MCP authorization, "Canonical Server URI": the form without one, for interoperability).
  // The SDK's own, mounted below at the same path and so never reached, would write `mcpUrl.href`,
  // with one.
  app.use(
    "/.well-known/oauth-protected-resource",
    metadataHandler({
      resource: mcpUrl.origin,
      authorization_servers: [options.publicUrl.href],
      scopes_supported: [SCOPE],
      resource_name: "sattle.me"
    })
  );
  // The authorization server's metadata (RFC 8414): the SDK's, plus clients' metadata documents
  // (cimd.ts), which Claude and ChatGPT then use instead of registering, and the issuer named in
  // every authorization response (RFC 9207: `iss`, which ChatGPT checks). The SDK's own, mounted
  // below at the same path, is never reached.
  app.use(
    "/.well-known/oauth-authorization-server",
    metadataHandler({
      ...createOAuthMetadata({ provider, issuerUrl: options.publicUrl, scopesSupported: [SCOPE] }),
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    })
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: options.publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "sattle.me",
      clientRegistrationOptions: { clientIdGeneration: false }
    })
  );

  // The merchant's consent: the key given once, checked against its channel, then the code.
  app.post(
    "/consent",
    rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const consent = options.sealer.open("consent", body.request, now());
      if (
        !consent ||
        typeof consent.clientId !== "string" ||
        typeof consent.redirectUri !== "string" ||
        typeof consent.codeChallenge !== "string"
      ) {
        res.status(400).type("text").send("This page expired: start again from your AI app.");
        return;
      }
      // A client's metadata document may be unreadable since the page showed (cimd.ts).
      const client = await Promise.resolve(provider.clientsStore.getClient(consent.clientId)).catch(
        () => undefined
      );
      if (
        !client ||
        !client.redirect_uris.some((uri) => redirectUriMatches(consent.redirectUri as string, uri))
      ) {
        res.status(400).type("text").send("Unknown client: start again from your AI app.");
        return;
      }
      const view = {
        request: body.request as string,
        clientName: client.client_name ?? "Une application sans nom",
        verifiedHost: isDocumentClientId(client.client_id) ? new URL(client.client_id).host : null,
        redirectUri: consent.redirectUri,
        selfHosted
      };
      const keyText = typeof body.key === "string" ? body.key.trim() : "";
      try {
        // The key must be an assistant's whose channel is active: a typo is said here, not later.
        await new Assistant(keyText, options.services).profile(options.timeZone);
      } catch (error) {
        const message =
          error instanceof InvalidAssistantKeyError
            ? "Ce n'est pas une clé d'assistant (sattleme_ak_…)."
            : (error as { code?: string }).code === "revoked"
              ? "Cet assistant a été retiré dans l'app : créez-en un autre."
              : "La clé n'a pas pu être vérifiée (réseau) : réessayez.";
        consentPage(res, { ...view, error: message });
        return;
      }
      const code = provider.codeFor(
        {
          clientId: consent.clientId,
          redirectUri: consent.redirectUri,
          codeChallenge: consent.codeChallenge
        },
        keyText,
        // The merchant's browser's languages: the region of its invoices (pdf/region.ts).
        acceptedLanguages(req.get("accept-language"))
      );
      const target = new URL(consent.redirectUri);
      target.searchParams.set("code", code);
      if (typeof consent.state === "string") target.searchParams.set("state", consent.state);
      target.searchParams.set("iss", issuer);
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, target.href);
    }
  );

  // The MCP endpoint: stateless, one server and transport per request.
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl
  });
  app.post(
    "/",
    rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }),
    express.json({ limit: "256kb" }),
    bearer,
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
      // Per key: its calls reach the merchant's relays and services.
      keyGenerator: (req) => keyHash(tokenKey(req))
    }),
    async (req: Request, res: Response) => {
      const key = tokenKey(req);
      const preferences = tokenPreferences(req);
      let assistant: Assistant;
      try {
        assistant = new Assistant(key, options.services);
      } catch {
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      const server = createMcpServer(
        {
          assistant: () => assistant,
          timeZone: options.timeZone,
          language: options.language,
          preferences,
          pdfDirectory: null,
          iconsOrigin: options.publicUrl.origin,
          pdfLink: (invoice, language, timeZone) => {
            const expiresAt = now() + PDF_LINK_SECONDS;
            const token = options.sealer.seal(
              "pdf",
              { key, id: invoice.id, language, timeZone, preferences },
              expiresAt
            );
            const name = encodeURIComponent(invoiceFileName(invoice, language));
            return { url: `${options.publicUrl.origin}/pdf/${token}/${name}`, expiresAt };
          },
          exportLink: (request, fileName) => {
            const expiresAt = now() + PDF_LINK_SECONDS;
            const token = options.sealer.seal("export", { key, request }, expiresAt);
            const name = encodeURIComponent(fileName);
            return { url: `${options.publicUrl.origin}/export/${token}/${name}`, expiresAt };
          }
        },
        options.version
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      // Only what the merchant allows this assistant is listed (SPEC.md §16): read for a
      // tools/list request alone, the others call their tool, which checks it.
      listAllowedTools(server, transport, () => assistant.permissions());
      await transport.handleRequest(req, res, req.body);
    }
  );
  const notAllowed = (_: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this server is stateless" },
      id: null
    });
  };
  // A browser opening the address (a merchant checking it) gets a page saying what it is for, how
  // to add it to an AI app (consent.ts) and the version it runs; an MCP client's GET (a stream)
  // gets 405, which the protocol allows.
  app.get("/", (req: Request, res: Response) => {
    if (req.accepts(["text/event-stream", "text/html"]) === "text/html")
      infoPage(res, selfHosted, options.version, options.publicUrl);
    else notAllowed(req, res);
  });
  app.delete("/", notAllowed);
  // An invoice's PDF by the link invoice_pdf gave: its token seals the key, the invoice, its
  // language, time zone and the merchant's preferred languages, for PDF_LINK_SECONDS. Made again
  // from the relays at each download (nothing is kept), so a link stops working as soon as the
  // merchant removes the assistant.
  app.get(
    "/pdf/:token/:name",
    downloadLimits(30, (req, res) => {
      const link = options.sealer.open("pdf", req.params.token, now());
      if (
        !link ||
        typeof link.key !== "string" ||
        typeof link.id !== "string" ||
        typeof link.timeZone !== "string" ||
        !isLanguage(link.language)
      ) {
        res
          .status(410)
          .type("text")
          .send("Ce lien a expiré : demandez à nouveau le PDF à votre assistant.");
        return null;
      }
      const opened: PdfLink = {
        key: link.key,
        id: link.id,
        language: link.language,
        timeZone: link.timeZone,
        preferences: preferredLocales(Array.isArray(link.preferences) ? link.preferences : [])
      };
      return opened;
    }),
    async (_req: Request, res: Response) => {
      const link = res.locals.link as PdfLink;
      try {
        const { invoice, pdf } = await new Assistant(link.key, options.services).pdf(
          link.id,
          link.language,
          link.timeZone,
          link.preferences
        );
        const name = invoiceFileName(invoice, link.language);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`
        );
        res.type("application/pdf").send(pdf);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "revoked") {
          res.status(403).type("text").send("Cet assistant a été retiré dans l'app sattle.me.");
        } else if (code === "unknown_invoice") {
          res.status(404).type("text").send("Cette facture est introuvable.");
        } else {
          res
            .status(503)
            .type("text")
            .send("La facture n'a pas pu être lue (réseau) : réessayez dans un instant.");
        }
      }
    }
  );

  // An export by the link export_transactions gave: its token seals the key and the request (its
  // period, format, language, locale, time zone), for PDF_LINK_SECONDS. Made again from the relays
  // at each download (nothing is kept): it stops as soon as the merchant withdraws the export or
  // removes the assistant.
  app.get(
    "/export/:token/:name",
    downloadLimits(10, (req, res) => {
      const link = options.sealer.open("export", req.params.token, now());
      const request = exportRequestOf(link?.request);
      if (!link || typeof link.key !== "string" || !request) {
        res
          .status(410)
          .type("text")
          .send("Ce lien a expiré : demandez à nouveau l'export à votre assistant.");
        return null;
      }
      const opened: ExportLink = { key: link.key, request };
      return opened;
    }),
    async (_req: Request, res: Response) => {
      const { key, request } = res.locals.link as ExportLink;
      try {
        const result = await new Assistant(key, options.services).exportTransactions(request);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${result.fileName.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`
        );
        res
          .type(result.mimeType === "text/csv" ? "text/csv; charset=utf-8" : "application/pdf")
          .send(result.bytes);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "revoked") {
          res.status(403).type("text").send("Cet assistant a été retiré dans l'app sattle.me.");
        } else if (code === "export_not_allowed") {
          res
            .status(403)
            .type("text")
            .send("L'export des transactions n'est plus autorisé pour cet assistant dans l'app.");
        } else {
          res
            .status(503)
            .type("text")
            .send("L'export n'a pas pu être fait (réseau) : réessayez dans un instant.");
        }
      }
    }
  );

  // The logo (brand.ts): the icon the server's information names, and the browsers' favicon.
  const image = (file: "icon" | "favicon") => (_: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(logo()[file]);
  };
  app.get("/icon.png", image("icon"));
  app.get("/favicon.png", image("favicon"));
  app.get("/favicon.ico", image("favicon"));
  // The pages' font (consent.ts): the brand kit's Plus Jakarta Sans, the files the invoices' PDF
  // embeds (assets/fonts/, its licence beside them).
  const font = (weight: "medium" | "bold" | "extraBold") => (_: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type("font/ttf").send(loadFonts()[weight]);
  };
  app.get("/fonts/plus-jakarta-sans-medium.ttf", font("medium"));
  app.get("/fonts/plus-jakarta-sans-bold.ttf", font("bold"));
  app.get("/fonts/plus-jakarta-sans-extrabold.ttf", font("extraBold"));
  app.get("/health", (_: Request, res: Response) => {
    res.json({ ok: true });
  });
  // OpenAI's domain verification of a plugin's MCP server (developers.openai.com, "Submit plugins"):
  // the exact token as plain text, nothing else, only while the host sets it.
  const challenge = options.openaiAppsChallenge ?? null;
  if (challenge) {
    app.get("/.well-known/openai-apps-challenge", (_: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.type("text/plain").send(challenge);
    });
  }
  app.use(quietErrors);
  return app;
}

type PdfLink = {
  key: string;
  id: string;
  language: Language;
  timeZone: string;
  /** The merchant's preferred languages: the region of the PDF (pdf/region.ts). */
  preferences: string[];
};
type ExportLink = { key: string; request: ExportRequest };

/**
 * The middlewares of a download link (/pdf/…, /export/…): its answer's headers, then its token
 * opened by `open` (which answers 410 itself and gives null when it is not a valid link), kept in
 * res.locals.link. Limited per assistant key (`perKey` a minute): the links are downloaded by the
 * merchant's browser and by the AI app's code sandbox, whose many users may share a few addresses,
 * so an address alone only gets a broad limit, enough to stop a flood of forged tokens.
 */
function downloadLimits(
  perKey: number,
  open: (req: Request, res: Response) => { key: string } | null
) {
  return [
    rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }),
    (req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const link = open(req, res);
      if (link === null) return;
      res.locals.link = link;
      next();
    },
    rateLimit({
      windowMs: 60_000,
      limit: perKey,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (_req, res) => keyHash((res.locals.link as { key: string }).key)
    })
  ];
}

/** The export request a link sealed, checked as the tool checks its arguments; null otherwise. */
function exportRequestOf(value: unknown): ExportRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string";
  if (!text(v.first) || !text(v.last) || (v.format !== "csv" && v.format !== "pdf")) return null;
  if (v.unit !== undefined && v.unit !== "fiat" && v.unit !== "btc") return null;
  for (const field of [v.language, v.locale, v.timeZone]) {
    if (field !== undefined && !text(field)) return null;
  }
  if (
    v.columns !== undefined &&
    (!Array.isArray(v.columns) ||
      !v.columns.every((column) => (EXPORT_COLUMNS as readonly unknown[]).includes(column)))
  ) {
    return null;
  }
  return v as ExportRequest;
}
