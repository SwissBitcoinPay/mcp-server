import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Before the tests: the invoice card, as npm run build writes it (dist/ui/invoice-card.html),
 * which the server serves from its sources too (src/mcp/card.ts).
 */
export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  execFileSync(process.execPath, [join(root, "scripts", "ui.mjs")], { cwd: root, stdio: "ignore" });
}
