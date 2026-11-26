import type { Response } from "express";

import { HOSTED_ORIGIN } from "../brand.js";

import { redirectTarget } from "./redirects.js";

/*
 * The consent page of the hosted server (SPEC.md §16): where the merchant connects an AI app to its
 * assistant by pasting the assistant key, once. The page is the server's own (never the model's),
 * shows where it sends the merchant back (what proves which app asks: its name is only what it
 * says), runs no script, and every text it shows is escaped.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/*
 * The pages' look: the merchant's app's (sattleme/app: src/theme/tokens.ts and src/components/ui/),
 * the « Swiss Bitcoin Pay » design system with the brand kit's ink and font. Cream page, a white
 * card; one filled button per page, orange with a white label in its umber
 * ring (« Connecter »); the others white pills, as the app's own « Ajouter à Claude » and « Ouvrir
 * ChatGPT » (NewIntegrationSheet.tsx); fields as its TextField; notices as its Callout. Plus Jakarta
 * Sans is the server's own files (the invoices' PDF's, the brand kit's), drawn one weight heavier
 * than the design says, as the app does (src/theme/typography.ts): Medium for text, Bold for labels,
 * ExtraBold for titles and buttons.
 */
const STYLE = `<style>
  @font-face { font-family: "Plus Jakarta Sans"; src: url("/fonts/plus-jakarta-sans-medium.ttf") format("truetype"); font-weight: 400 500; font-display: swap; }
  @font-face { font-family: "Plus Jakarta Sans"; src: url("/fonts/plus-jakarta-sans-bold.ttf") format("truetype"); font-weight: 600; font-display: swap; }
  @font-face { font-family: "Plus Jakarta Sans"; src: url("/fonts/plus-jakarta-sans-extrabold.ttf") format("truetype"); font-weight: 700 800; font-display: swap; }
  :root { color-scheme: light; }
  body { margin: 0; padding: 0 16px; font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 500; line-height: 1.5; background: #FAF6EE; color: #0B1A33; }
  main { max-width: 30rem; margin: 3rem auto; padding: 1.5rem; background: #FFFFFF; border-radius: 22px; box-shadow: 0 2px 14px 0 rgba(11, 26, 51, 0.07); }
  .logo { display: block; margin: 0 0 0.75rem -8px; }
  h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; margin: 0 0 1rem; }
  p { line-height: 1.5; }
  .where { background: #F2ECE0; padding: 16px; border-radius: 16px; }
  label { display: block; font-size: 12.5px; font-weight: 600; color: #6E675E; margin: 1.25rem 0 9px; }
  input { box-sizing: border-box; width: 100%; height: 56px; padding: 0 18px; font: inherit; font-weight: 700; color: #0B1A33; background: #FFFFFF; border: 1.5px solid rgba(11, 26, 51, 0.14); border-radius: 16px; }
  input::placeholder { color: #6E675E; font-weight: 500; }
  button, .add { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; margin-top: 1.25rem; min-height: 56px; padding: 9px 26px; font: inherit; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; text-align: center; text-decoration: none; border: 1.5px solid; border-radius: 999px; cursor: pointer; }
  button { background: #F7931A; border-color: #8F5300; color: #FFFFFF; text-shadow: 0 1px 0 rgba(143, 83, 0, 0.55); box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.3); }
  button:hover { background: #E08414; }
  button:active { background: #E08414; box-shadow: inset 0 2px 4px 0 rgba(143, 83, 0, 0.4); }
  .add { background: #FFFFFF; border-color: rgba(11, 26, 51, 0.14); color: #0B1A33; text-shadow: 0 1px 0 #FFFFFF; box-shadow: inset 0 1px 0 0 #FFFFFF, 0 1px 2px 0 rgba(11, 26, 51, 0.07); }
  .add:hover { background: #FBF8F2; border-color: rgba(11, 26, 51, 0.35); }
  .add:active { background: #F7F2E9; box-shadow: inset 0 2px 4px 0 rgba(11, 26, 51, 0.12); }
  button:focus-visible, .add:focus-visible, input:focus-visible { border-color: #F7931A; }
  a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid #8F5300; outline-offset: 2px; box-shadow: 0 0 0 4px #F5E7D2; }
  .error { background: #F5DEDA; color: #8C2F26; padding: 16px; border-radius: 16px; font-size: 13.5px; font-weight: 600; }
  .operator { background: #F5EBCB; color: #7A5A00; padding: 16px; border-radius: 16px; font-size: 13.5px; }
  small { display: block; margin-top: 1rem; color: #6E675E; font-size: 13.5px; line-height: 1.5; }
  .version { margin-top: 0.5rem; font-size: 12.5px; }
  .add + small { margin-top: 0.5rem; }
  small a { color: #8F5300; font-weight: 600; }
  small a:hover { color: #5E3600; }
  .address { background: #F2ECE0; padding: 16px 18px; border-radius: 16px; font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 14px; overflow-wrap: anywhere; user-select: all; }
</style>`;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

export type ConsentView = {
  /** The sealed request the form sends back. */
  request: string;
  clientName: string;
  /**
   * The host that proves which app asks (a client ID metadata document's, cimd.ts: claude.ai,
   * chatgpt.com); null for a registered client, whose name is only what it says.
   */
  verifiedHost: string | null;
  redirectUri: string;
  /** Why the key given was refused, shown above the field. */
  error: string | null;
  /** A self-hosted server's host (selfHostedHost); null on sattle.me's own. */
  selfHosted: string | null;
};

/**
 * Who runs this server, as its pages say it: null when it is sattle.me's own (https://mcp.sattle.me),
 * else its host. Anyone may run this code (docs/SELF-HOSTING.md): its pages then never let a
 * merchant believe sattle.me runs it, since whoever does sees the key and the invoices.
 */
export function selfHostedHost(publicUrl: URL): string | null {
  return publicUrl.origin === HOSTED_ORIGIN ? null : publicUrl.host;
}

/** On a self-hosted server: who runs it, and what it sees. */
function operatorNotice(selfHosted: string): string {
  return `<p class="operator" role="note"><strong>Ce serveur n'est pas géré par sattle.me.</strong> Il est hébergé par son propriétaire, à l'adresse <strong>${escapeHtml(selfHosted)}</strong>. Il voit la clé de l'assistant et vos factures (noms et adresses de vos clients, montants) le temps de chaque demande. Ne l'utilisez que si vous faites confiance à qui l'héberge.</p>`;
}

/**
 * The strict headers of the page: no script, its images and fonts from here, the form posts here
 * (and its answer goes on to the client's redirect, which a browser checks against form-action
 * too), no frame.
 */
export function pageHeaders(res: Response, redirectUri: string | null): void {
  const target = redirectUri === null ? null : redirectTarget(redirectUri);
  const origin = target ? ` ${target.formAction}` : "";
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; form-action 'self'${origin}; frame-ancestors 'none'; base-uri 'none'`
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

/** ChatGPT's page where a custom MCP server is added (developers.openai.com, "Connect and test your plugin"). */
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";

/**
 * Claude's links that open its « Add custom connector » dialog with the connector's name and
 * address filled in, for the merchant's own account and, by an organization's owner, for the whole
 * organization (claude.com/docs/connectors/building/directory-vs-custom, « Custom connector install
 * link »). They only fill the form: the merchant checks the values and confirms in Claude.
 */
export function claudeInstallLinks(name: string, address: string): { user: string; admin: string } {
  const query = `?modal=add-custom-connector&connectorName=${encodeURIComponent(name)}&connectorUrl=${encodeURIComponent(address)}`;
  return {
    user: `https://claude.ai/customize/connectors${query}`,
    admin: `https://claude.ai/admin-settings/connectors${query}`
  };
}

/**
 * The page of the server's address opened in a browser: what it is for, how to add it to an AI app
 * (Claude's dialog filled in by a link, ChatGPT's page and its steps, the address itself for any
 * other), and the version it runs (the release's, docs/RELEASING.md), nothing asked. Its links only
 * lead the merchant to the AI app, which asks the merchant to confirm. `publicUrl`'s host is the
 * domain an AI app's code sandbox must be allowed to reach for the model to work with the PDFs and
 * exports itself, which only the merchant can allow (SPEC.md §16).
 */
export function infoPage(
  res: Response,
  selfHosted: string | null,
  version: string,
  publicUrl: URL
): void {
  // The MCP endpoint, as merchants paste it: the origin, without a trailing slash (app.ts).
  const address = publicUrl.origin;
  // A self-hosted server's connector is named with its host, never as sattle.me's alone.
  const claude = claudeInstallLinks(
    selfHosted ? `sattle.me (${selfHosted})` : "sattle.me",
    address
  );
  const host = publicUrl.host;
  pageHeaders(res, null);
  res.status(200).type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>sattle.me · Assistant de facturation</title>
${STYLE}
</head>
<body>
<main>
  <img class="logo" src="/icon.png" alt="sattle.me" width="56" height="56">
  <h1>Assistant de facturation sattle.me</h1>
  <p>Ajoutez-le à votre application d'IA comme connecteur. L'application ouvre ensuite une page ${selfHosted ? "de ce serveur" : "sattle.me"} où vous collez la clé de l'assistant.</p>
  ${selfHosted ? operatorNotice(selfHosted) : ""}
  <a class="add" href="${escapeHtml(claude.user)}" target="_blank" rel="noopener noreferrer">Ajouter à Claude</a>
  <small>Claude ouvre l'ajout d'un connecteur personnalisé, nom et adresse remplis : vérifiez-les, puis ajoutez. Propriétaire d'une organisation Claude (Team, Enterprise) : <a href="${escapeHtml(claude.admin)}" target="_blank" rel="noopener noreferrer">l'ajouter pour toute l'organisation</a>.</small>
  <a class="add" href="${CHATGPT_PLUGINS_URL}" target="_blank" rel="noopener noreferrer">Ajouter à ChatGPT</a>
  <small>Sur la page Plugins de ChatGPT : le bouton +, ajouter un serveur MCP personnalisé, collez l'adresse ci-dessous, authentification OAuth, puis créez-le. Votre abonnement ou votre organisation ChatGPT doit le permettre.</small>
  <p>Dans une autre application d'IA, ajoutez un connecteur à cette adresse :</p>
  <p class="address">${escapeHtml(address)}</p>
  <p>Pour que votre IA travaille elle-même avec vos PDF et vos exports (les joindre à un e-mail, les classer, les convertir…), autorisez une fois le domaine <strong>${escapeHtml(host)}</strong> pour son exécution de code. Dans Claude : Paramètres › Capabilities ; dans une organisation Team ou Enterprise, c'est son propriétaire qui l'autorise. Sans cela, elle vous donne un lien de téléchargement.</p>
  <small>Créez l'assistant dans l'app sattle.me : Intégrations › Créer une intégration › Assistant IA.</small>
  <small class="version">Version ${escapeHtml(version)}</small>
</main>
</body>
</html>`);
}

export function consentPage(res: Response, view: ConsentView): void {
  const target = redirectTarget(view.redirectUri);
  const destination =
    target === null
      ? view.redirectUri
      : target.kind === "web"
        ? target.shown
        : target.kind === "loopback"
          ? `une application de cet ordinateur (${target.shown})`
          : `l'application ${target.shown}`;
  pageHeaders(res, view.redirectUri);
  res.status(view.error ? 400 : 200).type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>sattle.me · Connecter l'assistant</title>
${STYLE}
</head>
<body>
<main>
  <img class="logo" src="/icon.png" alt="sattle.me" width="56" height="56">
  <h1>Connecter votre assistant sattle.me</h1>
  ${
    view.verifiedHost
      ? `<p><strong>${escapeHtml(view.verifiedHost)}</strong> (« ${escapeHtml(view.clientName)} ») demande à utiliser votre assistant sattle.me, pour ce que vous lui avez permis dans l'app : vos factures, l'export de vos transactions, ou les deux.</p>
  <p class="where">Après votre accord, vous revenez sur : <strong>${escapeHtml(destination)}</strong>.<br>Continuez seulement si c'est depuis cette application d'IA que vous venez de connecter sattle.me.</p>`
      : `<p>« ${escapeHtml(view.clientName)} » demande à utiliser votre assistant sattle.me, pour ce que vous lui avez permis dans l'app : vos factures, l'export de vos transactions, ou les deux.</p>
  <p class="where">Après votre accord, vous revenez sur : <strong>${escapeHtml(destination)}</strong>.<br>Continuez seulement si c'est l'application d'IA depuis laquelle vous venez de connecter sattle.me (le nom ci-dessus est celui qu'elle déclare).</p>`
  }
  ${view.selfHosted ? operatorNotice(view.selfHosted) : ""}
  ${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ""}
  <form method="post" action="/consent">
    <input type="hidden" name="request" value="${escapeHtml(view.request)}">
    <label for="key">Clé de l'assistant</label>
    <input id="key" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="sattleme_ak_…" required>
    <button type="submit">Connecter</button>
  </form>
  <small>Créez l'assistant dans l'app sattle.me (Intégrations › Créer une intégration › Assistant IA) et collez sa clé ici, jamais dans la conversation. Elle ne dépense rien : chaque facture paie votre propre portefeuille. Retirez l'assistant dans l'app pour l'arrêter aussitôt.</small>
</main>
</body>
</html>`);
}
