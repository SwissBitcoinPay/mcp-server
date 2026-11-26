import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The sattle.me logo, as AI apps show the server: the app's own icon (the « s. » of the brand kit,
 * sattleme/app assets/images/icon.png at 512 px, the size Claude Desktop recommends for a bundle)
 * and its favicon (48 px).
 *
 * MCP (2025-11-25) lets a server name icons in its information: the favicon inline (a data URI,
 * nothing to fetch) and the icon at the hosted server's address. The hosted server also serves
 * both (/icon.png, /favicon.ico), the bundle's manifest names the icon (manifest.json).
 */

/** The hosted server's address, where the local server's icon is too. */
export const HOSTED_ORIGIN = "https://mcp.sattle.me";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The assets folder, at the package's root: one folder up from src/, two from dist/src/. */
function assetsDir(): string {
  for (const dir of [join(HERE, "..", "assets"), join(HERE, "..", "..", "assets")]) {
    if (existsSync(join(dir, "icon.png"))) return dir;
  }
  throw new Error("The logo is missing");
}

let images: { icon: Buffer; favicon: Buffer } | null = null;

/** The logo's files (PNG): the 512 px icon and the 48 px favicon. */
export function logo(): { icon: Buffer; favicon: Buffer } {
  if (!images) {
    const dir = assetsDir();
    images = {
      icon: readFileSync(join(dir, "icon.png")),
      favicon: readFileSync(join(dir, "favicon.png"))
    };
  }
  return images;
}

/** The icons of the server's information (MCP `Implementation.icons`), the large one at `origin`. */
export function serverIcons(origin: string) {
  return [
    {
      src: `data:image/png;base64,${logo().favicon.toString("base64")}`,
      mimeType: "image/png",
      sizes: ["48x48"]
    },
    { src: `${origin}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }
  ];
}
