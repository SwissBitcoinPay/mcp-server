import { readFileSync } from "node:fs";

import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { depositAddress } from "../vendor/checkout-node/test/helpers/chain.js";

import { Assistant } from "../src/assistant.js";
import { CARD_MIME_TYPE, CARD_URI, cardHtml } from "../src/mcp/card.js";
import { createMcpServer, listAllowedTools, previewedAtOf } from "../src/mcp/tools.js";
import { pointHour } from "../src/protocol/points.js";

import { World } from "./helpers/world.js";

/*
 * The invoice card (src/mcp/card.ts) as the AI app reaches it: the tools that show it, its page,
 * the preview's second (previewedAt) and the invoice made once since then (SPEC.md §16), against
 * the test merchant (local relays, fake services).
 */

let world: World;
let client: Client;

const invoiceArgs = {
  recipient: {
    name: "Dupont SA",
    street: "Gare 12",
    postalCode: "1003",
    city: "Lausanne",
    country: "ch"
  },
  lines: [
    { description: "Conseil (jours)", quantity: "3", unitPrice: "1200" },
    { description: "Débours", unitPrice: "12.50", vatRate: "0" }
  ],
  dueDate: "2026-12-03",
  timeZone: "Europe/Zurich"
};

type Result = { isError?: boolean; content: { type: string; text?: string }[] };

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  return { ...result, value: JSON.parse(result.content[0]!.text!) as Record<string, unknown> };
}

beforeEach(async () => {
  world = await new World().start();
  world.publishChannel(world.channelValue(world.now - 100), world.now - 100);
  world.publishLot([depositAddress("card 1"), depositAddress("card 2")], world.now - 90);
  world.setPoints("CHF", pointHour(world.now) - 48 * 3600, pointHour(world.now) + 3600, 80_000);
  const assistant = new Assistant(world.keyText, () => world.services());
  const server = createMcpServer(
    { assistant: () => assistant, timeZone: "Europe/Zurich", language: "fr", pdfDirectory: null },
    "0.0.0-test"
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  listAllowedTools(server, serverSide, () => assistant.permissions());
});

afterEach(async () => {
  await client.close();
  await world.stop();
});

describe("the invoice card", () => {
  it("is shown by preview_invoice and create_invoice, as the extension and its SDK name it", async () => {
    expect(CARD_MIME_TYPE).toBe(RESOURCE_MIME_TYPE);
    const { tools } = await client.listTools();
    const meta = Object.fromEntries(tools.map((tool) => [tool.name, tool._meta]));
    for (const name of ["preview_invoice", "create_invoice"]) {
      expect(meta[name]).toEqual({
        ui: { resourceUri: CARD_URI },
        [RESOURCE_URI_META_KEY]: CARD_URI
      });
    }
    // Its own tool, which the model does not see; the others show no card.
    expect(meta.invoice_card_pdf).toEqual({ ui: { visibility: ["app"] } });
    for (const name of ["business_profile", "list_invoices", "invoice_status", "invoice_pdf"]) {
      expect(meta[name]).toBeUndefined();
    }
  });

  it("is one page that reaches nothing: no domain declared, nothing loaded from elsewhere", async () => {
    const { resources } = await client.listResources();
    expect(resources).toContainEqual(
      expect.objectContaining({ uri: CARD_URI, mimeType: CARD_MIME_TYPE })
    );
    const read = await client.readResource({ uri: CARD_URI });
    expect(read.contents).toHaveLength(1);
    const [page] = read.contents as {
      uri: string;
      mimeType: string;
      text: string;
      _meta: unknown;
    }[];
    expect(page).toMatchObject({ uri: CARD_URI, mimeType: CARD_MIME_TYPE });
    // No csp: the AI app gives the extension's strictest policy (connect-src 'none').
    expect(page!._meta).toEqual({ ui: { prefersBorder: true } });
    const html = page!.text;
    expect(html).toBe(cardHtml());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script[^>]*\bsrc=|<link\b|<iframe\b|@import|url\(\s*["']?https?:/i);
    // One script, inline, whose text never ends the element early.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(html).toContain('url("data:image/png;base64,');
    expect(html).not.toContain("__SCRIPT__");
    expect(html).not.toContain("__LOGO__");
  });

  it("takes from a preview all it makes the invoice with, and its second", async () => {
    const { value } = await call("preview_invoice", invoiceArgs);
    expect(value).toMatchObject({
      total: "3904.10",
      terms: "",
      legal: "",
      redirectUrl: null,
      language: "fr",
      timeZone: "Europe/Zurich",
      dueDates: { first: "2026-11-04", last: "2027-08-03" },
      previewedAt: new Date(world.now * 1000).toISOString()
    });
    // None like it was made in the last 24 hours.
    expect(value.alreadyMade).toBeNull();
    // Its recipient and lines are create_invoice's arguments as they are.
    const made = await call("create_invoice", {
      recipient: value.recipient,
      lines: value.lines,
      dueDate: value.dueDate,
      terms: value.terms,
      legal: value.legal,
      language: value.language,
      timeZone: value.timeZone,
      expectedTotal: value.total,
      previewedAt: value.previewedAt
    });
    expect(made.isError).toBeUndefined();
    expect(made.value).toMatchObject({ number: "2026-0001", alreadyMade: false });
  });

  it("is told the second of a preview that is not valid, to complete it", async () => {
    const { isError, value } = await call("preview_invoice", {
      ...invoiceArgs,
      recipient: { ...invoiceArgs.recipient, street: " ", city: "" }
    });
    expect(isError).toBe(true);
    expect(value).toMatchObject({
      error: "invalid_invoice",
      details: ["recipient"],
      previewedAt: new Date(world.now * 1000).toISOString()
    });
    // Completed later, it keeps that second.
    world.now += 120;
    const completed = await call("preview_invoice", {
      ...invoiceArgs,
      previewedAt: value.previewedAt
    });
    expect(completed.value).toMatchObject({
      previewedAt: new Date((world.now - 120) * 1000).toISOString(),
      alreadyMade: null
    });
  });
});

describe("an invoice made once (SPEC.md §16)", () => {
  async function preview(args: Record<string, unknown> = invoiceArgs) {
    return (await call("preview_invoice", args)).value;
  }

  it("is made once, whatever the card is clicked: the second click gives it back", async () => {
    const { previewedAt, total } = await preview();
    world.now += 30;
    const first = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt
    });
    expect(first.value).toMatchObject({ number: "2026-0001", alreadyMade: false });
    world.now += 600;
    const again = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt
    });
    expect(again.isError).toBeUndefined();
    expect(again.value).toMatchObject({
      id: first.value.id,
      number: "2026-0001",
      paymentLink: first.value.paymentLink,
      alreadyMade: true
    });
    const listed = await call("list_invoices", {});
    expect(listed.value).toMatchObject({ count: 1 });
    // And a card shown again (the conversation opened again) sees it made.
    const shown = await preview({ ...invoiceArgs, previewedAt });
    expect(shown.alreadyMade).toMatchObject({ id: first.value.id, number: "2026-0001" });
  });

  it("is given back when the model made it after the card did, with the preview's second", async () => {
    const { previewedAt, total } = await preview();
    const byCard = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt
    });
    // The model, told « make it » in the conversation, with the same preview.
    const byModel = await call("create_invoice", {
      ...invoiceArgs,
      recipient: { ...invoiceArgs.recipient, name: "  Dupont SA ", country: "CH" },
      expectedTotal: total,
      previewedAt
    });
    expect(byModel.value).toMatchObject({ id: byCard.value.id, alreadyMade: true });
  });

  it("is given back whatever the address, reference or due date the user completed", async () => {
    const { previewedAt, total } = await preview();
    const first = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt
    });
    for (const completed of [
      { ...invoiceArgs, recipient: { ...invoiceArgs.recipient, reference: "PO-7" } },
      { ...invoiceArgs, recipient: { ...invoiceArgs.recipient, street: "Gare 12a" } },
      { ...invoiceArgs, dueDate: "2026-12-04" }
    ]) {
      const again = await call("create_invoice", {
        ...completed,
        expectedTotal: total,
        previewedAt
      });
      expect(again.value).toMatchObject({ id: first.value.id, alreadyMade: true });
    }
    expect((await call("list_invoices", {})).value).toMatchObject({ count: 1 });
  });

  it("makes another invoice for another name, other lines or other texts", async () => {
    const { previewedAt, total } = await preview();
    await call("create_invoice", { ...invoiceArgs, expectedTotal: total, previewedAt });
    const otherName = await call("create_invoice", {
      ...invoiceArgs,
      recipient: { ...invoiceArgs.recipient, name: "Dupont Fils SA" },
      expectedTotal: total,
      previewedAt
    });
    expect(otherName.value).toMatchObject({ number: "2026-0002", alreadyMade: false });
    const otherTerms = await call("create_invoice", {
      ...invoiceArgs,
      terms: "30 jours net",
      expectedTotal: total,
      previewedAt
    });
    expect(otherTerms.value).toMatchObject({ number: "2026-0003", alreadyMade: false });
    const otherLines = await call("create_invoice", {
      ...invoiceArgs,
      lines: [invoiceArgs.lines[0]!],
      expectedTotal: "3891.60",
      previewedAt
    });
    expect(otherLines.value).toMatchObject({ number: "2026-0004", alreadyMade: false });
  });

  it("is given back to the model that previews it anew after the card made it", async () => {
    const card = await preview();
    const byCard = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: card.total,
      previewedAt: card.previewedAt
    });
    // The user says « make it » in the conversation: the model previews again, then makes it.
    world.now += 600;
    const anew = await preview();
    expect(anew.previewedAt).not.toBe(card.previewedAt);
    expect(anew.alreadyMade).toMatchObject({ id: byCard.value.id, number: "2026-0001" });
    const byModel = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: anew.total,
      previewedAt: anew.previewedAt
    });
    expect(byModel.value).toMatchObject({ id: byCard.value.id, alreadyMade: true });
    // Or without previewedAt, as before the card: the last 24 hours count too.
    const plain = await call("create_invoice", { ...invoiceArgs, expectedTotal: anew.total });
    expect(plain.value).toMatchObject({ id: byCard.value.id, alreadyMade: true });
    expect((await call("list_invoices", {})).value).toMatchObject({ count: 1 });
  });

  it("makes another one like it when the user asks for it, or a day later", async () => {
    const { previewedAt, total } = await preview();
    const first = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt
    });
    const repeated = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt,
      repeat: true
    });
    expect(repeated.value).toMatchObject({ number: "2026-0002", alreadyMade: false });
    // A day and a second later, a new preview: those are out of its window.
    world.now += 86_401;
    world.setPoints("CHF", pointHour(world.now) - 3600, pointHour(world.now) + 3600, 80_000);
    const tomorrow = await preview();
    expect(tomorrow.alreadyMade).toBeNull();
    const made = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt: tomorrow.previewedAt
    });
    expect(made.value).toMatchObject({ number: "2026-0003", alreadyMade: false });
    // But the card of the first preview, shown again, still sees the first one made since.
    const shown = await preview({ ...invoiceArgs, previewedAt });
    expect(shown.alreadyMade).toMatchObject({ number: "2026-0003" });
    expect(first.value.number).toBe("2026-0001");
  });

  it("is told made to a card shown again, even as an invoice not valid now", async () => {
    // The model previewed it without the address; the card completed it and made it.
    const incomplete = {
      ...invoiceArgs,
      recipient: { ...invoiceArgs.recipient, street: "", city: "" }
    };
    const first = await call("preview_invoice", incomplete);
    expect(first.value).toMatchObject({ error: "invalid_invoice" });
    const previewedAt = first.value.previewedAt;
    const made = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: "3904.10",
      previewedAt
    });
    // Shown again weeks later: the due date has passed, the stored arguments lack the address.
    world.now += 40 * 86_400;
    const shown = await call("preview_invoice", { ...incomplete, previewedAt });
    expect(shown.isError).toBeUndefined();
    expect(shown.value.alreadyMade).toMatchObject({ id: made.value.id, number: "2026-0001" });
    // A preview that cannot be like an invoice made (no name) is told what is off, no relay read.
    const noName = await call("preview_invoice", {
      ...incomplete,
      recipient: { ...incomplete.recipient, name: "" },
      previewedAt
    });
    expect(noName.value).toMatchObject({
      error: "invalid_invoice",
      details: ["recipient", "dueDate: from 2026-12-14 to 2027-09-13"]
    });
  });

  it("makes nothing when the relays cannot tell whether it was made", async () => {
    const { previewedAt, total } = await preview();
    // Two relays of three never answer a read of the assistant's invoices.
    const author = world.keys.invoices.nostr.publicKey;
    for (const relay of world.relays.slice(0, 2)) {
      world.net.get(relay).behaviour = {
        muteQuery: (filter) => filter.authors?.includes(author) === true
      };
    }
    const refused = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt
    });
    expect(refused.isError).toBe(true);
    expect(refused.value).toMatchObject({ error: "network" });
    const shown = await call("preview_invoice", { ...invoiceArgs, previewedAt });
    expect(shown.value).toMatchObject({ error: "network", previewedAt });
    for (const relay of world.relays) world.net.get(relay).behaviour = {};
    expect((await call("list_invoices", {})).value).toMatchObject({ count: 0 });
  });

  it("takes only a previewedAt this server gives: UTC, a time that exists, not ahead", () => {
    const now = world.now;
    const at = (text: string) => previewedAtOf(text, now);
    expect(at(new Date(now * 1000).toISOString())).toBe(now);
    expect(at("2026-11-03T10:19:59Z")).toBe(now - 1);
    expect(at(" 2026-11-03T10:20:00.000Z ")).toBe(now);
    for (const wrong of [
      "",
      "2026-11-03",
      "2026-11-03T10:20:00",
      "2026-11-03T10:20:00+01:00",
      "2026-02-30T10:00:00Z",
      "2026-11-03T24:00:00Z",
      "1999-12-31T23:59:59Z",
      new Date((now + 301) * 1000).toISOString(),
      "1793701200"
    ]) {
      expect(() => at(wrong), wrong).toThrow(/previewedAt/);
    }
  });

  it("is refused with a previewedAt this server did not give, before anything is taken", async () => {
    const { total } = await preview();
    const refused = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt: "yesterday"
    });
    expect(refused.value).toMatchObject({
      error: "invalid_invoice",
      details: ["previewedAt: as preview_invoice gave it"]
    });
    expect((await call("list_invoices", {})).value).toMatchObject({ count: 0 });
  });
});

describe("the card's PDF", () => {
  it("is the invoice's PDF, in the answer, for the AI app to save", async () => {
    const { previewedAt, total } = await preview();
    const made = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt
    });
    const { isError, value } = await call("invoice_card_pdf", {
      reference: made.value.number,
      language: "de"
    });
    expect(isError).toBeUndefined();
    expect(value).toMatchObject({ file: "Rechnung-2026-0001.pdf", mimeType: "application/pdf" });
    const pdf = Buffer.from(value.base64 as string, "base64");
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Its answer holds a text only: Claude rejects a binary resource there.
    const raw = (await client.callTool({
      name: "invoice_card_pdf",
      arguments: { reference: made.value.id as string }
    })) as Result;
    expect(raw.content.map((part) => part.type)).toEqual(["text"]);
  });

  it("is written as the AI app's region writes it: the merchant's, which the card tells", async () => {
    const { previewedAt, total } = await preview();
    const made = await call("create_invoice", {
      ...invoiceArgs,
      expectedTotal: total,
      previewedAt
    });
    const pdf = vi.spyOn(Assistant.prototype, "pdf");
    try {
      await call("invoice_card_pdf", { reference: made.value.id, language: "de", locale: "de-CH" });
      expect(pdf.mock.lastCall?.[3]).toEqual(["de-CH"]);
      // What is no locale is left out: the merchant's other signals decide.
      await call("invoice_card_pdf", { reference: made.value.id, locale: "not a locale!" });
      expect(pdf.mock.lastCall?.[3]).toEqual([]);
    } finally {
      pdf.mockRestore();
    }
  });

  it("is refused for an invoice this assistant did not make", async () => {
    const { value } = await call("invoice_card_pdf", { reference: "2026-0042" });
    expect(value).toMatchObject({ error: "unknown_invoice" });
  });

  async function preview() {
    return (await call("preview_invoice", invoiceArgs)).value;
  }
});

describe("the card's sources", () => {
  it("are built into the page the server serves", () => {
    const template = readFileSync(new URL("../ui/card.html", import.meta.url), "utf8");
    // The template's style, as written, is in the page.
    const style = /<style>[\s\S]*<\/style>/.exec(template)![0].replace("__LOGO__", "");
    expect(cardHtml().replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/, "")).toContain(style);
  });
});

describe("the card's look (the merchant's app, ui/card.html)", () => {
  const template = readFileSync(new URL("../ui/card.html", import.meta.url), "utf8");
  const style = /<style>([\s\S]*)<\/style>/.exec(template)![1]!;

  /** The custom properties of the first rule after `selector`, each as written. */
  function properties(selector: string): Map<string, string> {
    const at = style.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    const body = style.slice(style.indexOf("{", at) + 1, style.indexOf("}", at));
    const found = new Map<string, string>();
    for (const [, name, value] of body.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
      found.set(name!, value!.replace(/\s+/g, " ").trim());
    }
    return found;
  }

  /** A colour as written, or the fallback of the AI app's variable it reads first. */
  function colour(value: string | undefined): [number, number, number, number] {
    const written = /^var\( ?--[a-z-]+,\s*(.+?) ?\)$/.exec(value ?? "")?.[1] ?? value ?? "";
    const hex = /^#([0-9a-f]{6})$/i.exec(written);
    if (hex) {
      const n = Number.parseInt(hex[1]!, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(written);
    if (!rgba) throw new Error(`Not a colour: ${value}`);
    return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  }

  /** `top` drawn over the opaque `ground`. */
  function over(top: string, ground: string): string {
    const [r, g, b, a] = colour(top);
    const [R, G, B] = colour(ground);
    const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
    return `#${[mix(r, R), mix(g, G), mix(b, B)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }

  /** WCAG 2's contrast ratio of two opaque colours. */
  function contrast(a: string, b: string): number {
    const luminance = (value: string) => {
      const [r, g, b] = colour(value).map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  it("names no font file: the AI app's policy refuses one, even inline (font-src)", () => {
    // Under the extension's default policy (default-src 'none', no font-src), a data: font is
    // refused: the card names the brand's fonts and falls back to the AI app's.
    expect(style).not.toMatch(/@font-face/);
    const light = properties(":root");
    expect(light.get("--sans")).toMatch(/^"Plus Jakarta Sans", var\( ?--font-sans, /);
    expect(light.get("--mono")).toMatch(/^"JetBrains Mono", var\( ?--font-mono, /);
  });

  it("is dark alike whether the AI app or the device chose it", () => {
    const told = properties(':root[data-theme="dark"]');
    const device = properties(':root:not([data-theme="light"])');
    expect(told.size).toBeGreaterThan(10);
    expect(device).toEqual(told);
    // Every colour the light theme sets, the dark one sets too, but the brand's fills.
    const light = [...properties(":root").keys()].filter(
      (name) => !["--orange", "--orange-pressed", "--umber", "--sans", "--mono"].includes(name)
    );
    expect([...told.keys()].sort()).toEqual(light.sort());
  });

  it("is the app's in light, its texts readable (WCAG AA, 4.5:1) on every ground", () => {
    const p = properties(":root");
    // The app's tokens (sattleme/app, src/theme/tokens.ts), the brand kit's ink.
    expect(p.get("--text")).toBe("#0b1a33");
    expect(p.get("--orange")).toBe("#f7931a");
    expect(p.get("--umber")).toBe("#8f5300");
    // The AI app's page under the card: cream at most as dark as the app's.
    for (const ground of [p.get("--surface")!, "#faf6ee"]) {
      for (const text of ["--text", "--muted", "--accent-text", "--accent-text-hover"]) {
        expect(contrast(p.get(text)!, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const [text, ground] of [
      ["--muted", "--subtle"],
      ["--draft", "--draft-bg"],
      ["--success", "--success-bg"],
      ["--warning", "--warning-bg"],
      ["--danger", "--danger-bg"]
    ] as const) {
      expect(contrast(p.get(text)!, p.get(ground)!), `${text} on ${ground}`).toBeGreaterThanOrEqual(
        4.5
      );
    }
  });

  /** The declarations of the first rule for exactly `selector`, each as written. */
  function rule(selector: string): Map<string, string> {
    const at = style.search(
      new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`)
    );
    expect(at, selector).toBeGreaterThan(-1);
    const body = style.slice(style.indexOf("{", at) + 1, style.indexOf("}", at));
    const found = new Map<string, string>();
    for (const [, name, value] of body.matchAll(/([a-z-]+):\s*([^;]+);/g)) {
      found.set(name!, value!.replace(/\s+/g, " ").trim());
    }
    return found;
  }

  // A split button, as the app's DocumentLanguageButton.
  it("draws the PDF's button and its language as one filled button, split by a thin line", () => {
    // The button: the orange fill in its umber ring, its highlight.
    expect(Object.fromEntries(rule(".split"))).toMatchObject({
      border: "1.5px solid var(--umber)",
      "border-radius": "999px",
      background: "var(--orange)",
      "box-shadow": "inset 0 1px 0 0 rgba(255, 255, 255, 0.3)"
    });
    // Its action draws no ring of its own: the button's.
    expect(Object.fromEntries(rule(".split .button.primary"))).toMatchObject({
      border: "0",
      "border-radius": "999px 0 0 999px",
      background: "transparent"
    });
    // The line: the ring's umber at half, shorter than the button.
    expect(Object.fromEntries(rule(".split-line"))).toMatchObject({
      width: "1px",
      height: "24px",
      background: "rgba(143, 83, 0, 0.5)"
    });
    // The language in the label's type (not the code's mono), white, at least 56 px wide.
    const choice = rule(".split-choice");
    expect(Object.fromEntries(choice)).toMatchObject({
      "min-width": "56px",
      "border-radius": "0 999px 999px 0",
      color: "#ffffff",
      "font-size": rule(".button").get("font-size")!,
      "font-weight": rule(".button").get("font-weight")!
    });
    expect(choice.has("font-family")).toBe(false);
    // Each part pressed on its own, as the button's.
    expect(style).toMatch(
      /\.split \.button\.primary:active:not\(:disabled\),\s*\.split-choice:active \{\s*background: var\(--orange-pressed\);\s*box-shadow: inset 0 2px 4px 0 rgba\(143, 83, 0, 0\.4\);/
    );
    // Nothing left of the chip beside the button.
    expect(style).not.toMatch(/\.chip\b/);
  });

  it("shows the keyboard's focus on every ground, as an outline (forced colours keep it)", () => {
    // The halo alone is apricot on cream (about 1.1:1): the ring around it is what is seen.
    expect(style).toMatch(
      /\.button:focus-visible,\s*\.link:focus-visible,\s*\.field input:focus-visible,\s*\.split-choice:focus-within \{\s*outline: 2px solid var\(--focus-ring\);/
    );
    expect(style).not.toMatch(/outline:\s*none/);
    const light = properties(":root");
    for (const ground of [light.get("--surface")!, "#faf6ee", light.get("--subtle")!]) {
      expect(contrast(light.get("--focus-ring")!, ground)).toBeGreaterThanOrEqual(3);
    }
    const dark = properties(':root[data-theme="dark"]');
    for (const page of ["#262624", "#171717"]) {
      expect(contrast(dark.get("--focus-ring")!, page)).toBeGreaterThanOrEqual(3);
    }
  });

  it("is readable in dark on its own fallbacks, over a dark page", () => {
    const p = properties(':root[data-theme="dark"]');
    // Claude's dark page, and a darker one.
    for (const page of ["#262624", "#171717"]) {
      for (const [text, ground] of [
        ["--text", "--surface"],
        ["--muted", "--surface"],
        ["--muted", "--subtle"],
        ["--draft", "--draft-bg"],
        ["--success", "--success-bg"],
        ["--warning", "--warning-bg"],
        ["--danger", "--danger-bg"]
      ] as const) {
        const under = over(p.get(ground)!, page);
        expect(
          contrast(p.get(text)!, under),
          `${text} on ${ground} (${page})`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
