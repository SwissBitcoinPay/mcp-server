/*
 * The words of an invoice's PDF in the languages of the merchant's app, as its translations write
 * them (src/i18n/locales/: invoices.pdf, invoices.lines, invoices.terms, businessNumbers), copied
 * verbatim; German in its two variants (« de », « de-CH »: de.ts and de-CH.ts). `{{number}}`,
 * `{{rate}}` and `{{base}}` are filled in.
 */

import type { TextLanguage } from "../protocol/constants.js";

export type PdfLabels = {
  invoice: string;
  date: string;
  due: string;
  reference: string;
  billedTo: string;
  pay: string;
  payHint: string;
  title: string;
  name: string;
  quantityShort: string;
  unitPriceShort: string;
  vat: string;
  amount: string;
  net: string;
  total: string;
  vatOn: string;
  conditions: string;
  legal: string;
  company: Record<"CH" | "FR" | "DE" | "IT" | "ES" | "PT" | "FI" | "other", string>;
  vatNumber: Record<"CH" | "EU" | "other", string>;
};

export const PDF_LABELS: Readonly<Record<TextLanguage, PdfLabels>> = {
  fr: {
    invoice: "Facture",
    date: "Date",
    due: "Échéance",
    reference: "Votre référence",
    billedTo: "Facturé à",
    pay: "Payer en bitcoin",
    payHint: "Scannez le code QR, ou ouvrez le lien.",
    title: "Facture {{number}}",
    name: "Désignation",
    quantityShort: "Qté",
    unitPriceShort: "Prix unit.",
    vat: "TVA",
    amount: "Montant",
    net: "Sous-total hors taxes",
    total: "Total",
    vatOn: "TVA {{rate}} sur {{base}}",
    conditions: "Conditions de paiement",
    legal: "Mentions légales",
    company: {
      CH: "Numéro IDE",
      FR: "Numéro SIRET",
      DE: "Numéro fiscal (Steuernummer)",
      IT: "Code fiscal (codice fiscale)",
      ES: "NIF",
      PT: "NIF",
      FI: "Identifiant d'entreprise (Y-tunnus)",
      other: "Numéro d'entreprise"
    },
    vatNumber: { CH: "Numéro TVA", EU: "Numéro de TVA intracommunautaire", other: "Numéro de TVA" }
  },
  en: {
    invoice: "Invoice",
    date: "Date",
    due: "Due date",
    reference: "Your reference",
    billedTo: "Billed to",
    pay: "Pay in bitcoin",
    payHint: "Scan the QR code, or open the link.",
    title: "Invoice {{number}}",
    name: "Description",
    quantityShort: "Qty",
    unitPriceShort: "Unit price",
    vat: "VAT",
    amount: "Amount",
    net: "Subtotal excl. VAT",
    total: "Total",
    vatOn: "VAT {{rate}} on {{base}}",
    conditions: "Payment terms",
    legal: "Legal notices",
    company: {
      CH: "UID number",
      FR: "SIRET number",
      DE: "Tax number (Steuernummer)",
      IT: "Tax code (codice fiscale)",
      ES: "NIF",
      PT: "NIF",
      FI: "Business ID (Y-tunnus)",
      other: "Company number"
    },
    vatNumber: { CH: "VAT number", EU: "VAT identification number", other: "VAT number" }
  },
  de: {
    invoice: "Rechnung",
    date: "Datum",
    due: "Fällig am",
    reference: "Ihre Referenz",
    billedTo: "Rechnung an",
    pay: "In Bitcoin bezahlen",
    payHint: "Scannen Sie den QR-Code oder öffnen Sie den Link.",
    title: "Rechnung {{number}}",
    name: "Bezeichnung",
    quantityShort: "Menge",
    unitPriceShort: "Stückpreis",
    vat: "MwSt.",
    amount: "Betrag",
    net: "Zwischensumme ohne MwSt.",
    total: "Gesamtbetrag",
    vatOn: "MwSt. {{rate}} auf {{base}}",
    conditions: "Zahlungsbedingungen",
    legal: "Rechtliche Hinweise",
    company: {
      CH: "UID-Nummer",
      FR: "SIRET-Nummer",
      DE: "Steuernummer",
      IT: "Steuernummer (Codice fiscale)",
      ES: "NIF",
      PT: "NIF",
      FI: "Unternehmenskennung (Y-tunnus)",
      other: "Unternehmensnummer"
    },
    vatNumber: { CH: "MWST-Nummer", EU: "USt-IdNr.", other: "Mehrwertsteuernummer" }
  },
  "de-CH": {
    invoice: "Rechnung",
    date: "Datum",
    due: "Fällig am",
    reference: "Ihre Referenz",
    billedTo: "Rechnung an",
    pay: "In Bitcoin bezahlen",
    payHint: "Scannen Sie den QR-Code oder öffnen Sie den Link.",
    title: "Rechnung {{number}}",
    name: "Bezeichnung",
    quantityShort: "Menge",
    unitPriceShort: "Stückpreis",
    vat: "MWST",
    amount: "Betrag",
    net: "Zwischensumme ohne MWST",
    total: "Total",
    vatOn: "MWST {{rate}} auf {{base}}",
    conditions: "Zahlungsbedingungen",
    legal: "Rechtliche Hinweise",
    company: {
      CH: "UID-Nummer",
      FR: "SIRET-Nummer",
      DE: "Steuernummer",
      IT: "Steuernummer (Codice fiscale)",
      ES: "NIF",
      PT: "NIF",
      FI: "Unternehmenskennung (Y-tunnus)",
      other: "Unternehmensnummer"
    },
    vatNumber: { CH: "MWST-Nummer", EU: "USt-IdNr.", other: "Mehrwertsteuernummer" }
  },
  it: {
    invoice: "Fattura",
    date: "Data",
    due: "Scadenza",
    reference: "Il vostro riferimento",
    billedTo: "Fatturato a",
    pay: "Paga in bitcoin",
    payHint: "Scansiona il codice QR o apri il link.",
    title: "Fattura {{number}}",
    name: "Descrizione",
    quantityShort: "Qtà",
    unitPriceShort: "Prezzo unit.",
    vat: "IVA",
    amount: "Importo",
    net: "Subtotale IVA esclusa",
    total: "Totale",
    vatOn: "IVA {{rate}} su {{base}}",
    conditions: "Condizioni di pagamento",
    legal: "Note legali",
    company: {
      CH: "Numero IDI",
      FR: "Numero SIRET",
      DE: "Codice fiscale (Steuernummer)",
      IT: "Codice fiscale",
      ES: "NIF",
      PT: "NIF",
      FI: "Codice d'impresa (Y-tunnus)",
      other: "Numero d'impresa"
    },
    vatNumber: { CH: "Numero IVA", EU: "Partita IVA", other: "Numero IVA" }
  },
  es: {
    invoice: "Factura",
    date: "Fecha",
    due: "Vencimiento",
    reference: "Su referencia",
    billedTo: "Facturado a",
    pay: "Pagar en bitcoin",
    payHint: "Escanee el código QR o abra el enlace.",
    title: "Factura {{number}}",
    name: "Descripción",
    quantityShort: "Cant.",
    unitPriceShort: "Precio unit.",
    vat: "IVA",
    amount: "Importe",
    net: "Subtotal sin IVA",
    total: "Total",
    vatOn: "IVA {{rate}} sobre {{base}}",
    conditions: "Condiciones de pago",
    legal: "Menciones legales",
    company: {
      CH: "Número UID",
      FR: "Número SIRET",
      DE: "Número fiscal (Steuernummer)",
      IT: "Código fiscal (codice fiscale)",
      ES: "NIF",
      PT: "NIF",
      FI: "Identificador de empresa (Y-tunnus)",
      other: "Número de empresa"
    },
    vatNumber: { CH: "Número de IVA", EU: "NIF-IVA", other: "Número de IVA" }
  },
  pt: {
    invoice: "Fatura",
    date: "Data",
    due: "Vencimento",
    reference: "A sua referência",
    billedTo: "Faturado a",
    pay: "Pagar em bitcoin",
    payHint: "Leia o código QR ou abra o link.",
    title: "Fatura {{number}}",
    name: "Descrição",
    quantityShort: "Qtd.",
    unitPriceShort: "Preço unit.",
    vat: "IVA",
    amount: "Montante",
    net: "Subtotal sem IVA",
    total: "Total",
    vatOn: "IVA {{rate}} sobre {{base}}",
    conditions: "Condições de pagamento",
    legal: "Menções legais",
    company: {
      CH: "Número UID",
      FR: "Número SIRET",
      DE: "Número fiscal (Steuernummer)",
      IT: "Código fiscal (codice fiscale)",
      ES: "NIF",
      PT: "NIF",
      FI: "Identificador da empresa (Y-tunnus)",
      other: "Número da empresa"
    },
    vatNumber: { CH: "Número de IVA", EU: "Número de IVA intracomunitário", other: "Número de IVA" }
  },
  fi: {
    invoice: "Lasku",
    date: "Päiväys",
    due: "Eräpäivä",
    reference: "Viitteenne",
    billedTo: "Laskun saaja",
    pay: "Maksa bitcoineilla",
    payHint: "Skannaa QR-koodi tai avaa linkki.",
    title: "Lasku {{number}}",
    name: "Kuvaus",
    quantityShort: "Määrä",
    unitPriceShort: "Yks. hinta",
    vat: "ALV",
    amount: "Summa",
    net: "Välisumma ilman ALV:tä",
    total: "Yhteensä",
    vatOn: "ALV {{rate}} summasta {{base}}",
    conditions: "Maksuehdot",
    legal: "Oikeudelliset tiedot",
    company: {
      CH: "UID-tunnus",
      FR: "SIRET-numero",
      DE: "Veronumero (Steuernummer)",
      IT: "Verokoodi (codice fiscale)",
      ES: "NIF",
      PT: "NIF",
      FI: "Y-tunnus",
      other: "Yritystunnus"
    },
    vatNumber: { CH: "ALV-numero", EU: "ALV-tunniste", other: "ALV-numero" }
  }
};
