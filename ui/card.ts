import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext
} from "@modelcontextprotocol/ext-apps";

import {
  argumentsOf,
  baseOf,
  contextOfDraft,
  contextOfMade,
  draftOfArguments,
  documentLocale,
  dueRangeOf,
  formatDay,
  formatDecimal,
  formatMoney,
  hostOf,
  isLanguage,
  isTextLanguage,
  LANGUAGE_NAMES,
  languageOf,
  localeOf,
  missingFields,
  readAnswer,
  readMade,
  readPreview,
  RECIPIENT_FIELDS,
  splitTotal,
  TEXT_LANGUAGES,
  variantOf,
  type Draft,
  type Failure,
  type Made,
  type Preview,
  type Recipient,
  type TextLanguage
} from "./model.js";
import { fill, TEXTS, type Texts } from "./texts.js";

/*
 * The invoice card (src/mcp/card.ts): shown by the AI app for preview_invoice and create_invoice.
 *
 * - A preview: the invoice, its totals, a form for what is missing (the client's address…), and
 *   « Créer la facture », which calls create_invoice with the preview's previewedAt: the server
 *   makes it once since then, whatever the card is clicked, shown again or the model also asked
 *   (SPEC.md §16). The AI app asks no approval for the card's calls: the click is the user's
 *   confirmation of what the card shows, every line included (one click, no second one).
 * - An invoice made: its number, its payment link, its PDF (saved through the AI app).
 *
 * Every text it shows is set as text, never as HTML: the tools' answers are the model's words.
 * Every amount is the server's decimal text: the card computes none. It shows nothing it has not
 * read: a preview shown again asks the server first whether that invoice was made since.
 */

const PDF_FILE = /^[\p{L}\p{N}._-]{1,120}\.pdf$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

type View =
  | { kind: "loading" }
  | { kind: "message"; text: string; detail: string }
  | {
      kind: "draft";
      draft: Draft;
      /** The preview of `draft` as it stands, or null while it is not valid or not read. */
      preview: Preview | null;
      /** argumentsOf(draft) when `preview` was read: the button makes only what it shows. */
      previewed: string | null;
      problems: string[];
      failure: Failure | null;
      busy: "checking" | "making" | null;
      editing: boolean;
      /** What failed last: a preview (retried by checking again) or the making. */
      retry: "check" | "make" | null;
    }
  | {
      kind: "made";
      made: Made;
      /** The invoice's language and time zone, as it was made. */
      language: string | null;
      timeZone: string | null;
      /**
       * The PDF's language (as the app's DocumentLanguageChip): the invoice's at first, else the
       * card's, until the user picks another beside the button.
       */
      pdfLanguage: TextLanguage;
      note: string | null;
    };

const app = new App({ name: "sattle.me invoice card", version: "1" }, {}, { autoResize: true });

let view: View = { kind: "loading" };
let toolName = "";
let toolInput: Record<string, unknown> | null = null;
let locale: string | undefined;
let texts: Texts = TEXTS.en;
/** The card's language (setLanguage): the merchant's, said in the PDF's languages. */
let cardLanguage: TextLanguage = "en";
/** The last check sent: an older answer is dropped. */
let checks = 0;
let typing: ReturnType<typeof setTimeout> | undefined;

const root = document.getElementById("card") as HTMLElement;

// ——— The page ————————————————————————————————————————————————————————————————————————————————

type Child = Node | string | null | false;

/** An attribute (false or null: none; true: present), or a listener (onclick…). */
type Prop = string | boolean | null | undefined | ((event: Event) => void);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, Prop> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, "");
    else if (name === "class") element.className = value;
    else element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

function button(
  label: string,
  onclick: () => void,
  kind: "primary" | "secondary",
  disabled = false
) {
  return h("button", { type: "button", class: `button ${kind}`, onclick, disabled }, label);
}

function header(badge: string, done: boolean): HTMLElement {
  return h(
    "header",
    {},
    h("span", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), "sattle.me"),
    h("span", { class: "title" }, texts.invoice),
    badge === "" ? null : h("span", { class: done ? "badge done" : "badge" }, badge)
  );
}

function money(amount: string, currency: string): string {
  return formatMoney(amount, currency, locale);
}

function render(): void {
  // The form stays in place across renders, never taken out of the page: the field being typed
  // in keeps its focus and caret.
  const form = root.querySelector("form");
  const nodes = content(form);
  const at = form === null ? -1 : nodes.indexOf(form);
  if (form === null || at === -1) {
    root.replaceChildren(...nodes);
    return;
  }
  for (const child of Array.from(root.childNodes)) if (child !== form) child.remove();
  form.before(...nodes.slice(0, at));
  form.after(...nodes.slice(at + 1));
}

function content(form: HTMLFormElement | null): Node[] {
  switch (view.kind) {
    case "loading":
      return [header("", false), h("p", { class: "muted", role: "status" }, texts.checking)];
    case "message":
      return [
        header("", false),
        h("p", { class: "error", role: "alert" }, view.text),
        view.detail === "" ? null : h("p", { class: "muted" }, view.detail)
      ].filter((node): node is HTMLElement => node !== null);
    case "made":
      return madeContent(view);
    case "draft":
      return draftContent(view, form);
  }
}

function recipientBlock(recipient: Recipient): HTMLElement {
  const place = [
    `${recipient.postalCode} ${recipient.city}`.trim(),
    recipient.country.toUpperCase()
  ]
    .filter((part) => part !== "")
    .join(", ");
  return h(
    "div",
    { class: "recipient" },
    h("strong", {}, recipient.name),
    recipient.street === "" ? null : h("span", {}, recipient.street),
    place === "" ? null : h("span", {}, place),
    recipient.reference === "" ? null : h("span", { class: "muted" }, recipient.reference)
  );
}

function linesBlock(draft: Draft, currency: string | null): HTMLElement {
  // Every line: the button makes what the card shows.
  return h(
    "ul",
    { class: "lines" },
    ...draft.lines.map((line) => {
      const quantity = formatDecimal(line.quantity, locale, true);
      const price =
        currency === null ? formatDecimal(line.unitPrice, locale) : money(line.unitPrice, currency);
      return h(
        "li",
        {},
        h("span", { class: "line-name" }, line.description),
        h("span", { class: "line-price" }, `${quantity} × ${price}`)
      );
    })
  );
}

/** What else the invoice prints or does: its conditions, legal notice, where the payer goes after. */
function detailsBlock(draft: Draft): HTMLElement | null {
  const rows: [string, string][] = [];
  if (draft.terms.trim() !== "") rows.push([texts.terms, draft.terms]);
  if (draft.legal.trim() !== "") rows.push([texts.legal, draft.legal]);
  if (draft.redirectUrl !== null) rows.push([texts.redirect, hostOf(draft.redirectUrl)]);
  if (rows.length === 0) return null;
  return h(
    "dl",
    { class: "details" },
    ...rows.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])
  );
}

function totalsBlock(preview: Preview): HTMLElement {
  const rows: [string, string, boolean][] = [
    [texts.net, money(preview.net, preview.currency), false]
  ];
  for (const group of preview.vat) {
    if (group.vat === "0" || /^0(\.0+)?$/.test(group.vat)) continue;
    rows.push([
      fill(texts.vat, { rate: formatDecimal(group.rate, locale, true) }),
      money(group.vat, preview.currency),
      false
    ]);
  }
  rows.push([texts.total, money(preview.total, preview.currency), true]);
  return h(
    "dl",
    { class: "totals" },
    ...rows.flatMap(([label, value, strong]) => [
      h("dt", { class: strong ? "strong" : "" }, label),
      h("dd", { class: strong ? "strong" : "" }, value)
    ])
  );
}

function field(
  name: keyof Recipient | "dueDate",
  label: string,
  value: string,
  missing: boolean,
  extra: Record<string, Prop> = {}
): HTMLElement {
  const id = `field-${name}`;
  return h(
    "div",
    { class: missing ? "field missing" : "field" },
    h("label", { for: id }, label),
    h("input", {
      id,
      name,
      value,
      "aria-invalid": missing ? "true" : "false",
      oninput: onInput,
      ...extra
    })
  );
}

function formOf(
  draft: Draft,
  preview: Preview | null,
  missing: (keyof Recipient)[],
  problems: readonly string[]
) {
  const range = preview?.dueDates ?? dueRangeOf(problems);
  return h(
    "form",
    { class: "form", onsubmit: (event: Event) => event.preventDefault() },
    ...RECIPIENT_FIELDS.map((name) =>
      field(
        name,
        texts.fields[name],
        draft.recipient[name],
        missing.includes(name),
        name === "country"
          ? { maxlength: "2", autocapitalize: "characters", autocomplete: "country", size: "2" }
          : name === "postalCode"
            ? { autocomplete: "postal-code", maxlength: "120" }
            : { maxlength: "120" }
      )
    ),
    field("dueDate", texts.dueDate, draft.dueDate, dueOff(problems), {
      type: "date",
      ...(range ? { min: range.first, max: range.last } : {})
    })
  );
}

/**
 * Whether the server refused the due date (out of the range it allows now). An empty one is not
 * off: the server gives the default (30 days after today), which the next check fills in.
 */
function dueOff(problems: readonly string[]): boolean {
  return problems.some((problem) => problem.startsWith("dueDate"));
}

function draftContent(v: Extract<View, { kind: "draft" }>, kept: HTMLFormElement | null): Node[] {
  const { draft, preview } = v;
  const missing = missingFields(draft.recipient);
  const noDue = dueOff(v.problems);
  // Making, the card shows what is made, as text: nothing changes it then.
  const making = v.busy === "making";
  const showForm = !making && (v.editing || missing.length > 0 || noDue);
  const nodes: Node[] = [header(texts.toMake, false)];
  nodes.push(
    h(
      "div",
      { class: "section-head" },
      h("span", { class: "label" }, texts.recipient),
      missing.length > 0 || making
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "link",
              "aria-expanded": v.editing ? "true" : "false",
              onclick: () => update({ editing: !v.editing })
            },
            v.editing ? texts.editDone : texts.edit
          )
    )
  );
  if (missing.length > 0) nodes.push(h("p", { class: "callout" }, texts.missing));
  nodes.push(
    showForm
      ? (kept ?? formOf(draft, preview, missing, v.problems))
      : recipientBlock(draft.recipient)
  );
  if (showForm && kept) {
    markMissing(kept, missing, noDue);
    showDefaultDue(kept, draft);
  }
  nodes.push(linesBlock(draft, preview?.currency ?? null));
  const details = detailsBlock(draft);
  if (details) nodes.push(details);
  if (preview) {
    nodes.push(totalsBlock(preview));
    if (!showForm) {
      nodes.push(
        h(
          "p",
          { class: "due" },
          `${texts.dueDate} `,
          h("strong", {}, formatDay(draft.dueDate, locale))
        )
      );
    }
  }
  const note = noteOf(v);
  if (note) nodes.push(note);
  nodes.push(actionsOf(v, missing));
  return nodes;
}

function markMissing(form: HTMLFormElement, missing: (keyof Recipient)[], noDue: boolean): void {
  for (const element of Array.from(form.querySelectorAll<HTMLInputElement>("input"))) {
    const name = element.name as keyof Recipient | "dueDate";
    const off = name === "dueDate" ? noDue : missing.includes(name);
    element.setAttribute("aria-invalid", off ? "true" : "false");
    element.parentElement?.classList.toggle("missing", off);
  }
}

/**
 * The due date the server gave a draft whose field was left empty (the default, 30 days after
 * today), written in the field the form keeps: the user sees the date the button makes.
 */
function showDefaultDue(form: HTMLFormElement, draft: Draft): void {
  const input = form.querySelector<HTMLInputElement>("input[name=dueDate]");
  if (input && input.value === "" && draft.dueDate !== "" && document.activeElement !== input) {
    input.value = draft.dueDate;
  }
}

function noteOf(v: Extract<View, { kind: "draft" }>): HTMLElement | null {
  if (v.busy === "checking") return h("p", { class: "muted", role: "status" }, texts.checking);
  if (v.busy === "making") return h("p", { class: "muted", role: "status" }, texts.making);
  if (v.preview && !v.preview.canInvoice)
    return h("p", { class: "error", role: "alert" }, texts.cannotInvoice);
  if (v.problems.length > 0) {
    // What the server says is off: the recipient's fields show it; the rest is the model's.
    const others = v.problems.filter((p) => !/^(recipient|dueDate)\b/.test(p));
    const range = dueRangeOf(v.problems);
    if (others.length === 0) {
      return range === null
        ? null
        : h(
            "p",
            { class: "error", role: "alert" },
            fill(texts.dueRange, {
              first: formatDay(range.first, locale),
              last: formatDay(range.last, locale)
            })
          );
    }
    return h(
      "div",
      { class: "error", role: "alert" },
      h("p", {}, texts.invalid),
      h("p", { class: "muted" }, others.join(", ")),
      h("p", {}, texts.fixInChat)
    );
  }
  if (v.failure) {
    return h(
      "div",
      { class: "error", role: "alert" },
      h("p", {}, v.retry === "make" ? texts.makeFailed : texts.readFailed),
      v.failure.message === "" ? null : h("p", { class: "muted" }, v.failure.message),
      v.retry === "make" ? h("p", {}, texts.retrySafe) : null
    );
  }
  return null;
}

function actionsOf(v: Extract<View, { kind: "draft" }>, missing: (keyof Recipient)[]): HTMLElement {
  if (v.retry !== null && v.busy === null) {
    return h(
      "div",
      { class: "actions" },
      button(texts.retry, () => void (v.retry === "make" ? make() : check()), "primary")
    );
  }
  const ready =
    v.busy === null &&
    v.preview !== null &&
    v.preview.canInvoice &&
    v.problems.length === 0 &&
    missing.length === 0 &&
    v.previewed === JSON.stringify(argumentsOf(v.draft));
  return h(
    "div",
    { class: "actions" },
    button(texts.make, () => void make(), "primary", !ready)
  );
}

function madeContent(v: Extract<View, { kind: "made" }>): Node[] {
  const { made } = v;
  const { amount, currency } = splitTotal(made.total);
  const caps = app.getHostCapabilities();
  const title = fill(made.alreadyMade ? texts.alreadyTitle : texts.madeTitle, {
    number: made.number
  });
  return [
    header(texts.made, true),
    h("p", { class: "made-title" }, title),
    h(
      "dl",
      { class: "totals" },
      h("dt", {}, texts.recipient),
      h("dd", {}, made.recipient),
      h("dt", {}, texts.dueDate),
      h("dd", {}, formatDay(made.dueDate, locale)),
      h("dt", { class: "strong" }, texts.total),
      h("dd", { class: "strong" }, money(amount, currency))
    ),
    h(
      "p",
      { class: "link-line" },
      h("span", { class: "label" }, texts.paymentLink),
      h("span", { class: "url" }, made.paymentLink)
    ),
    v.note === null ? null : h("p", { class: "muted", role: "status" }, v.note),
    caps?.downloadFile ? null : h("p", { class: "muted" }, texts.noPdf),
    h(
      "div",
      { class: "actions" },
      caps?.downloadFile
        ? h(
            "span",
            { class: "split" },
            button(texts.pdf, () => void savePdf(), "primary"),
            h("span", { class: "split-line", "aria-hidden": "true" }),
            languageChoice(v.pdfLanguage)
          )
        : null,
      caps?.openLinks
        ? button(texts.openLink, () => void app.openLink({ url: made.paymentLink }), "secondary")
        : null
    )
  ].filter((node): node is HTMLElement => node !== null);
}

/**
 * The PDF's language at the end of its button: its code (« FR », « DE-CH ») and a chevron, over
 * which the browser's own list of the languages, each by its own name (a native select: the AI
 * app's page gives it its keyboard, screen readers and phones' pickers).
 */
function languageChoice(language: TextLanguage): HTMLElement {
  return h(
    "label",
    { class: "split-choice" },
    h("span", { "aria-hidden": "true" }, language.toUpperCase()),
    h("span", { class: "split-chevron", "aria-hidden": "true" }),
    h(
      "select",
      {
        "aria-label": fill(texts.pdfLanguage, { language: LANGUAGE_NAMES[language] }),
        onchange: (event) => pickPdfLanguage((event.target as HTMLSelectElement).value)
      },
      ...TEXT_LANGUAGES.map((option) =>
        h(
          "option",
          { value: option, selected: option === language },
          option === cardLanguage
            ? `${LANGUAGE_NAMES[option]} · ${texts.yourLanguage}`
            : LANGUAGE_NAMES[option]
        )
      )
    )
  );
}

// ——— What the user does ——————————————————————————————————————————————————————————————————————

function pickPdfLanguage(value: string): void {
  if (view.kind !== "made" || !isTextLanguage(value)) return;
  view = { ...view, pdfLanguage: value, note: null };
  render();
  // Drawn again: the choice keeps the keyboard's focus.
  root.querySelector<HTMLSelectElement>(".split-choice select")?.focus();
}

function update(changes: Partial<Extract<View, { kind: "draft" }>>): void {
  if (view.kind !== "draft") return;
  view = { ...view, ...changes };
  render();
}

function onInput(event: Event): void {
  if (view.kind !== "draft" || view.busy === "making") return;
  const input = event.target as HTMLInputElement;
  const draft = { ...view.draft, recipient: { ...view.draft.recipient } };
  if (input.name === "dueDate") draft.dueDate = input.value;
  else if ((RECIPIENT_FIELDS as readonly string[]).includes(input.name)) {
    const name = input.name as keyof Recipient;
    draft.recipient[name] = name === "country" ? input.value.toUpperCase() : input.value;
  }
  view = { ...view, draft, retry: null, failure: null, problems: [] };
  render();
  clearTimeout(typing);
  // Checked once the user pauses: each check reads the merchant's relays.
  typing = setTimeout(() => {
    if (view.kind === "draft" && missingFields(view.draft.recipient).length === 0) void check(true);
  }, 700);
}

/** Asks the server for the preview of the draft as it stands, and whether it was made since. */
async function check(edited = false): Promise<void> {
  if (view.kind !== "draft") return;
  const mine = ++checks;
  const args = argumentsOf(view.draft);
  update({ busy: "checking", failure: null, retry: null });
  let answer;
  try {
    answer = readAnswer(await app.callServerTool({ name: "preview_invoice", arguments: args }));
  } catch {
    answer = readAnswer(null);
  }
  if (mine !== checks || view.kind !== "draft") return;
  if (!answer.ok) {
    const failure = answer.failure;
    const draft =
      failure.previewedAt !== null && view.draft.previewedAt === null
        ? { ...view.draft, previewedAt: failure.previewedAt }
        : view.draft;
    if (failure.error === "invalid_invoice") {
      update({
        draft,
        preview: null,
        previewed: null,
        problems: failure.details,
        busy: null,
        // What the user completes in the card opens its form.
        editing: view.editing || failure.details.some((p) => /^(recipient|dueDate)\b/.test(p))
      });
    } else {
      update({ draft, preview: null, previewed: null, failure, busy: null, retry: "check" });
    }
    return;
  }
  const preview = readPreview(answer.value);
  if (preview === null) {
    update({ busy: null, failure: unreadable(), retry: "check" });
    return;
  }
  if (preview.alreadyMade) {
    showMade(preview.alreadyMade, preview.draft.language, preview.draft.timeZone);
    return;
  }
  const previewed = JSON.stringify(argumentsOf(preview.draft));
  // The draft the server read back (trimmed, the country in capitals) unless the user typed since.
  const unchanged = JSON.stringify(argumentsOf(view.draft)) === JSON.stringify(args);
  update({
    draft: unchanged ? preview.draft : view.draft,
    preview,
    previewed,
    problems: [],
    busy: null
  });
  if (edited) void tellModel(contextOfDraft(preview));
}

/** Makes the invoice the card shows: once since its first preview, whatever is clicked. */
async function make(): Promise<void> {
  if (view.kind !== "draft" || view.preview === null || view.draft.previewedAt === null) return;
  const args = {
    ...argumentsOf(view.draft),
    expectedTotal: view.preview.total
  };
  if (JSON.stringify(argumentsOf(view.draft)) !== view.previewed) return;
  update({ busy: "making", failure: null, retry: null });
  let answer;
  try {
    answer = readAnswer(await app.callServerTool({ name: "create_invoice", arguments: args }));
  } catch {
    answer = readAnswer(null);
  }
  if (view.kind !== "draft") return;
  if (!answer.ok) {
    if (answer.failure.error === "invalid_invoice") {
      update({ busy: null, preview: null, previewed: null, problems: answer.failure.details });
    } else {
      update({ busy: null, failure: answer.failure, retry: "make" });
    }
    return;
  }
  const made = readMade(answer.value);
  if (made === null) {
    // Made, maybe, but not readable: never « not made ». Making again gives it back.
    update({ busy: null, failure: unreadable(), retry: "make" });
    return;
  }
  showMade(made, view.draft.language, view.draft.timeZone);
  void tellModel(contextOfMade(made));
}

async function savePdf(): Promise<void> {
  if (view.kind !== "made") return;
  const { made, pdfLanguage, timeZone } = view;
  const note = (text: string | null) => {
    if (view.kind === "made") {
      view = { ...view, note: text };
      render();
    }
  };
  note(texts.checking);
  try {
    const answer = readAnswer(
      await app.callServerTool({
        name: "invoice_card_pdf",
        arguments: {
          reference: made.id,
          language: baseOf(pdfLanguage),
          ...(timeZone === null ? {} : { timeZone }),
          // Its locale: the language picked in the AI app's region, the merchant's (« en-CH »),
          // German's variant its own (« de-CH », « de-DE »).
          locale: documentLocale(pdfLanguage, locale)
        }
      })
    );
    const value = answer.ok ? (answer.value as Record<string, unknown>) : null;
    const file = typeof value?.file === "string" ? value.file : "";
    const base64 = typeof value?.base64 === "string" ? value.base64 : "";
    if (!PDF_FILE.test(file) || value?.mimeType !== "application/pdf" || !BASE64.test(base64)) {
      note(texts.pdfFailed);
      return;
    }
    const saved = await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: { uri: `file:///${file}`, mimeType: "application/pdf", blob: base64 }
        }
      ]
    });
    note(saved.isError ? texts.pdfFailed : null);
  } catch {
    note(texts.pdfFailed);
  }
}

function showMade(made: Made, language: string | null, timeZone: string | null): void {
  clearTimeout(typing);
  const pdfLanguage = isLanguage(language) ? variantOf(language, locale) : cardLanguage;
  view = { kind: "made", made, language, timeZone, pdfLanguage, note: null };
  render();
}

function unreadable(): Failure {
  return { error: "unreadable", message: texts.unreadable, details: [], previewedAt: null };
}

/** Tells the model what the card did, where the AI app takes it (it reads it at the next turn). */
async function tellModel(text: string): Promise<void> {
  if (!app.getHostCapabilities()?.updateModelContext) return;
  try {
    await app.updateModelContext({ content: [{ type: "text", text }] });
  } catch {
    // The AI app did not take it: the model still sees create_invoice's previewedAt rule.
  }
}

// ——— What the AI app gives ————————————————————————————————————————————————————————————————————

function applyContext(context: McpUiHostContext | undefined): void {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.locale) locale = localeOf(context.locale);
  if (context.toolInfo?.tool.name) toolName = context.toolInfo.tool.name;
}

function setLanguage(fallback: unknown): void {
  const language = languageOf(locale, isLanguage(fallback) ? fallback : null);
  texts = TEXTS[language];
  cardLanguage = language;
  document.documentElement.lang = language;
}

function onResult(result: unknown): void {
  const answer = readAnswer(result);
  if (answer.ok) {
    const made = readMade(answer.value);
    if (made) {
      const language = isLanguage(toolInput?.language) ? toolInput.language : null;
      const timeZone = typeof toolInput?.timeZone === "string" ? toolInput.timeZone : null;
      setLanguage(language);
      showMade(made, language, timeZone);
      return;
    }
    const preview = readPreview(answer.value);
    if (preview) {
      setLanguage(preview.draft.language);
      view = {
        kind: "draft",
        draft: preview.draft,
        preview: null,
        previewed: null,
        problems: [],
        failure: null,
        busy: null,
        editing: missingFields(preview.draft.recipient).length > 0,
        retry: null
      };
      // Shown again later (the conversation opened again), it may have been made since: the
      // server tells it before the button can be used.
      void check();
      return;
    }
    setLanguage(null);
    view = { kind: "message", text: texts.unreadable, detail: "" };
    render();
    return;
  }
  const { failure } = answer;
  // create_invoice's error is the model's to tell: the card completes only a preview.
  const made =
    toolName === "create_invoice" || (toolInput !== null && "expectedTotal" in toolInput);
  const draft = made ? null : draftOfArguments(toolInput, failure.previewedAt);
  setLanguage(draft?.language ?? null);
  if (draft && failure.error === "invalid_invoice") {
    const completes = missingFields(draft.recipient).length > 0 || dueOff(failure.details);
    view = {
      kind: "draft",
      draft,
      preview: null,
      previewed: null,
      problems: failure.details,
      failure: null,
      busy: null,
      // Opened for what is missing, it stays open while the user completes it.
      editing: completes,
      retry: null
    };
    render();
    // Shown again later (the conversation opened again), the user may have completed and made it
    // since: the server tells it first.
    if (draft.previewedAt !== null) void check();
    return;
  }
  view = {
    kind: "message",
    text: made ? texts.makeFailed : texts.readFailed,
    detail: failure.message
  };
  render();
}

app.ontoolinput = (params) => {
  toolInput = params.arguments ?? null;
};
app.ontoolresult = (params) => onResult(params);
app.onhostcontextchanged = (context) => {
  applyContext(context);
  render();
};

setLanguage(null);
render();
void app.connect().then(
  () => {
    applyContext(app.getHostContext());
    if (view.kind === "loading") setLanguage(null);
    render();
  },
  () => {
    view = { kind: "message", text: texts.unreadable, detail: "" };
    render();
  }
);
