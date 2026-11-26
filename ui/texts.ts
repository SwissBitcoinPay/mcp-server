import type { Recipient, TextLanguage } from "./model.js";

/*
 * The invoice card's words, in the languages of the sattle.me app (French is the source), German in
 * its two variants as the app's (« de »: Germany, Austria; « de-CH »: Switzerland, Liechtenstein). {n},
 * {rate} and {number} are replaced. No final period on a message, as in the app.
 */

export type Texts = {
  invoice: string;
  toMake: string;
  made: string;
  recipient: string;
  fields: Record<keyof Recipient, string>;
  dueDate: string;
  dueRange: string;
  terms: string;
  legal: string;
  redirect: string;
  edit: string;
  editDone: string;
  missing: string;
  net: string;
  vat: string;
  total: string;
  make: string;
  checking: string;
  making: string;
  madeTitle: string;
  alreadyTitle: string;
  paymentLink: string;
  pdf: string;
  /** The PDF's language, beside « Télécharger le PDF » (the app's DocumentLanguageChip): its name. */
  pdfLanguage: string;
  /** Said after the card's own language in the list. */
  yourLanguage: string;
  openLink: string;
  pdfFailed: string;
  noPdf: string;
  invalid: string;
  fixInChat: string;
  readFailed: string;
  makeFailed: string;
  retrySafe: string;
  retry: string;
  cannotInvoice: string;
  unreadable: string;
};

export const TEXTS: Record<TextLanguage, Texts> = {
  fr: {
    invoice: "Facture",
    toMake: "Aperçu",
    made: "Créée",
    recipient: "Destinataire",
    fields: {
      name: "Raison sociale",
      street: "Rue et numéro",
      postalCode: "NPA",
      city: "Localité",
      country: "Pays (CH, FR…)",
      reference: "Référence du client (facultatif)"
    },
    dueDate: "Échéance",
    dueRange: "Choisissez une échéance du {first} au {last}",
    terms: "Conditions de paiement",
    legal: "Mentions légales",
    redirect: "URL de redirection",
    edit: "Modifier",
    editDone: "Fermer",
    missing: "Il manque des informations pour créer cette facture : complétez-les ci-dessous",
    net: "Total hors TVA",
    vat: "TVA {rate}\u00a0%",
    total: "Total",
    make: "Créer la facture",
    checking: "Vérification…",
    making: "Création…",
    madeTitle: "Facture {number} créée",
    alreadyTitle: "Facture {number} déjà créée",
    paymentLink: "Lien de paiement",
    pdf: "Télécharger le PDF",
    pdfLanguage: "Langue du PDF : {language}",
    yourLanguage: "votre langue",
    openLink: "Ouvrir le lien de paiement",
    pdfFailed: "Le PDF n'a pas été enregistré",
    noPdf: "Demandez le PDF dans la conversation",
    invalid: "Cette facture n'est pas valide",
    fixInChat: "Corrigez-la dans la conversation",
    readFailed: "La facture n'a pas pu être vérifiée",
    makeFailed: "La facture n'a pas pu être créée",
    retrySafe: "Vous pouvez réessayer : sattle.me vérifie d'abord si la facture a déjà été créée",
    retry: "Réessayer",
    cannotInvoice:
      "Votre app sattle.me ne permet pas encore les factures payables par lien : mettez-la à jour",
    unreadable: "Cette réponse n'a pas pu être lue"
  },
  en: {
    invoice: "Invoice",
    toMake: "Preview",
    made: "Created",
    recipient: "Billed to",
    fields: {
      name: "Company name",
      street: "Street and number",
      postalCode: "Postcode",
      city: "City",
      country: "Country (CH, FR…)",
      reference: "Client's reference (optional)"
    },
    dueDate: "Due date",
    dueRange: "Choose a due date from {first} to {last}",
    terms: "Payment terms",
    legal: "Legal notices",
    redirect: "Redirect URL",
    edit: "Edit",
    editDone: "Close",
    missing: "Some details are missing to create this invoice: fill them in below",
    net: "Total excl. VAT",
    vat: "VAT {rate}\u00a0%",
    total: "Total",
    make: "Create the invoice",
    checking: "Checking…",
    making: "Creating…",
    madeTitle: "Invoice {number} created",
    alreadyTitle: "Invoice {number} already created",
    paymentLink: "Payment link",
    pdf: "Download the PDF",
    pdfLanguage: "PDF language: {language}",
    yourLanguage: "your language",
    openLink: "Open the payment link",
    pdfFailed: "The PDF was not saved",
    noPdf: "Ask for the PDF in the conversation",
    invalid: "This invoice is not valid",
    fixInChat: "Correct it in the conversation",
    readFailed: "The invoice could not be checked",
    makeFailed: "The invoice could not be created",
    retrySafe: "You can try again: sattle.me first checks whether the invoice was already created",
    retry: "Try again",
    cannotInvoice: "Your sattle.me app does not offer invoices paid by link yet: update it",
    unreadable: "This answer could not be read"
  },
  de: {
    invoice: "Rechnung",
    toMake: "Vorschau",
    made: "Erstellt",
    recipient: "Rechnung an",
    fields: {
      name: "Firmenname",
      street: "Straße und Nummer",
      postalCode: "PLZ",
      city: "Ort",
      country: "Land (CH, DE…)",
      reference: "Referenz des Kunden (optional)"
    },
    dueDate: "Fällig am",
    dueRange: "Wählen Sie ein Fälligkeitsdatum vom {first} bis {last}",
    terms: "Zahlungsbedingungen",
    legal: "Rechtliche Hinweise",
    redirect: "Weiterleitungs-URL",
    edit: "Bearbeiten",
    editDone: "Schließen",
    missing: "Für diese Rechnung fehlen Angaben: Ergänzen Sie sie unten",
    net: "Nettobetrag",
    vat: "MwSt. {rate}\u00a0%",
    total: "Gesamtbetrag",
    make: "Rechnung erstellen",
    checking: "Wird geprüft…",
    making: "Wird erstellt…",
    madeTitle: "Rechnung {number} erstellt",
    alreadyTitle: "Rechnung {number} bereits erstellt",
    paymentLink: "Zahlungslink",
    pdf: "PDF herunterladen",
    pdfLanguage: "Sprache des PDF: {language}",
    yourLanguage: "Ihre Sprache",
    openLink: "Zahlungslink öffnen",
    pdfFailed: "Das PDF wurde nicht gespeichert",
    noPdf: "Fragen Sie im Gespräch nach dem PDF",
    invalid: "Diese Rechnung ist nicht gültig",
    fixInChat: "Korrigieren Sie sie im Gespräch",
    readFailed: "Die Rechnung konnte nicht geprüft werden",
    makeFailed: "Die Rechnung konnte nicht erstellt werden",
    retrySafe:
      "Sie können es erneut versuchen: sattle.me prüft zuerst, ob die Rechnung bereits erstellt wurde",
    retry: "Erneut versuchen",
    cannotInvoice:
      "Ihre sattle.me-App bietet noch keine per Link bezahlbaren Rechnungen: Aktualisieren Sie sie",
    unreadable: "Diese Antwort konnte nicht gelesen werden"
  },
  "de-CH": {
    invoice: "Rechnung",
    toMake: "Vorschau",
    made: "Erstellt",
    recipient: "Rechnung an",
    fields: {
      name: "Firmenname",
      street: "Strasse und Nummer",
      postalCode: "PLZ",
      city: "Ort",
      country: "Land (CH, DE…)",
      reference: "Referenz des Kunden (optional)"
    },
    dueDate: "Fällig am",
    dueRange: "Wählen Sie ein Fälligkeitsdatum vom {first} bis {last}",
    terms: "Zahlungsbedingungen",
    legal: "Rechtliche Hinweise",
    redirect: "Weiterleitungs-URL",
    edit: "Bearbeiten",
    editDone: "Schliessen",
    missing: "Für diese Rechnung fehlen Angaben: Ergänzen Sie sie unten",
    net: "Total ohne MWST",
    vat: "MWST {rate}\u00a0%",
    total: "Total",
    make: "Rechnung erstellen",
    checking: "Wird geprüft…",
    making: "Wird erstellt…",
    madeTitle: "Rechnung {number} erstellt",
    alreadyTitle: "Rechnung {number} bereits erstellt",
    paymentLink: "Zahlungslink",
    pdf: "PDF herunterladen",
    pdfLanguage: "Sprache des PDF: {language}",
    yourLanguage: "Ihre Sprache",
    openLink: "Zahlungslink öffnen",
    pdfFailed: "Das PDF wurde nicht gespeichert",
    noPdf: "Fragen Sie im Gespräch nach dem PDF",
    invalid: "Diese Rechnung ist nicht gültig",
    fixInChat: "Korrigieren Sie sie im Gespräch",
    readFailed: "Die Rechnung konnte nicht geprüft werden",
    makeFailed: "Die Rechnung konnte nicht erstellt werden",
    retrySafe:
      "Sie können es erneut versuchen: sattle.me prüft zuerst, ob die Rechnung bereits erstellt wurde",
    retry: "Erneut versuchen",
    cannotInvoice:
      "Ihre sattle.me-App bietet noch keine per Link bezahlbaren Rechnungen: Aktualisieren Sie sie",
    unreadable: "Diese Antwort konnte nicht gelesen werden"
  },
  it: {
    invoice: "Fattura",
    toMake: "Anteprima",
    made: "Creata",
    recipient: "Destinatario",
    fields: {
      name: "Ragione sociale",
      street: "Via e numero",
      postalCode: "NPA",
      city: "Località",
      country: "Paese (CH, IT…)",
      reference: "Riferimento del cliente (facoltativo)"
    },
    dueDate: "Scadenza",
    dueRange: "Scegli una scadenza dal {first} al {last}",
    terms: "Condizioni di pagamento",
    legal: "Note legali",
    redirect: "URL di reindirizzamento",
    edit: "Modifica",
    editDone: "Chiudi",
    missing: "Mancano dei dati per creare questa fattura: completali qui sotto",
    net: "Totale IVA esclusa",
    vat: "IVA {rate}\u00a0%",
    total: "Totale",
    make: "Crea la fattura",
    checking: "Verifica…",
    making: "Creazione…",
    madeTitle: "Fattura {number} creata",
    alreadyTitle: "Fattura {number} già creata",
    paymentLink: "Link di pagamento",
    pdf: "Scarica il PDF",
    pdfLanguage: "Lingua del PDF: {language}",
    yourLanguage: "la tua lingua",
    openLink: "Apri il link di pagamento",
    pdfFailed: "Il PDF non è stato salvato",
    noPdf: "Chiedi il PDF nella conversazione",
    invalid: "Questa fattura non è valida",
    fixInChat: "Correggila nella conversazione",
    readFailed: "Non è stato possibile verificare la fattura",
    makeFailed: "Non è stato possibile creare la fattura",
    retrySafe: "Puoi riprovare: sattle.me verifica prima se la fattura è già stata creata",
    retry: "Riprova",
    cannotInvoice:
      "La tua app sattle.me non offre ancora fatture pagabili tramite link: aggiornala",
    unreadable: "Non è stato possibile leggere questa risposta"
  },
  es: {
    invoice: "Factura",
    toMake: "Vista previa",
    made: "Creada",
    recipient: "Destinatario",
    fields: {
      name: "Razón social",
      street: "Calle y número",
      postalCode: "Código postal",
      city: "Localidad",
      country: "País (CH, ES…)",
      reference: "Referencia del cliente (opcional)"
    },
    dueDate: "Vencimiento",
    dueRange: "Elige un vencimiento del {first} al {last}",
    terms: "Condiciones de pago",
    legal: "Menciones legales",
    redirect: "URL de redirección",
    edit: "Modificar",
    editDone: "Cerrar",
    missing: "Faltan datos para crear esta factura: complétalos a continuación",
    net: "Total sin IVA",
    vat: "IVA {rate}\u00a0%",
    total: "Total",
    make: "Crear la factura",
    checking: "Comprobando…",
    making: "Creando…",
    madeTitle: "Factura {number} creada",
    alreadyTitle: "Factura {number} ya creada",
    paymentLink: "Enlace de pago",
    pdf: "Descargar el PDF",
    pdfLanguage: "Idioma del PDF: {language}",
    yourLanguage: "tu idioma",
    openLink: "Abrir el enlace de pago",
    pdfFailed: "El PDF no se ha guardado",
    noPdf: "Pide el PDF en la conversación",
    invalid: "Esta factura no es válida",
    fixInChat: "Corrígela en la conversación",
    readFailed: "No se ha podido comprobar la factura",
    makeFailed: "No se ha podido crear la factura",
    retrySafe:
      "Puedes volver a intentarlo: sattle.me comprueba primero si la factura ya se ha creado",
    retry: "Reintentar",
    cannotInvoice: "Tu app sattle.me aún no ofrece facturas pagaderas por enlace: actualízala",
    unreadable: "No se ha podido leer esta respuesta"
  },
  pt: {
    invoice: "Fatura",
    toMake: "Pré-visualização",
    made: "Criada",
    recipient: "Destinatário",
    fields: {
      name: "Denominação social",
      street: "Rua e número",
      postalCode: "Código postal",
      city: "Localidade",
      country: "País (CH, PT…)",
      reference: "Referência do cliente (opcional)"
    },
    dueDate: "Vencimento",
    dueRange: "Escolha um vencimento de {first} a {last}",
    terms: "Condições de pagamento",
    legal: "Menções legais",
    redirect: "URL de redirecionamento",
    edit: "Editar",
    editDone: "Fechar",
    missing: "Faltam dados para criar esta fatura: preencha-os abaixo",
    net: "Total sem IVA",
    vat: "IVA {rate}\u00a0%",
    total: "Total",
    make: "Criar a fatura",
    checking: "A verificar…",
    making: "A criar…",
    madeTitle: "Fatura {number} criada",
    alreadyTitle: "Fatura {number} já criada",
    paymentLink: "Link de pagamento",
    pdf: "Transferir o PDF",
    pdfLanguage: "Idioma do PDF: {language}",
    yourLanguage: "o seu idioma",
    openLink: "Abrir o link de pagamento",
    pdfFailed: "O PDF não foi guardado",
    noPdf: "Peça o PDF na conversa",
    invalid: "Esta fatura não é válida",
    fixInChat: "Corrija-a na conversa",
    readFailed: "Não foi possível verificar a fatura",
    makeFailed: "Não foi possível criar a fatura",
    retrySafe: "Pode tentar novamente: a sattle.me verifica primeiro se a fatura já foi criada",
    retry: "Tentar novamente",
    cannotInvoice: "A sua app sattle.me ainda não oferece faturas pagáveis por link: atualize-a",
    unreadable: "Não foi possível ler esta resposta"
  },
  fi: {
    invoice: "Lasku",
    toMake: "Esikatselu",
    made: "Luotu",
    recipient: "Vastaanottaja",
    fields: {
      name: "Yrityksen nimi",
      street: "Katu ja numero",
      postalCode: "Postinumero",
      city: "Postitoimipaikka",
      country: "Maa (CH, FI…)",
      reference: "Asiakkaan viite (valinnainen)"
    },
    dueDate: "Eräpäivä",
    dueRange: "Valitse eräpäivä väliltä {first}–{last}",
    terms: "Maksuehdot",
    legal: "Oikeudelliset tiedot",
    redirect: "Uudelleenohjauksen URL",
    edit: "Muokkaa",
    editDone: "Sulje",
    missing: "Laskusta puuttuu tietoja: täydennä ne alla",
    net: "Yhteensä ilman ALV:tä",
    vat: "ALV {rate}\u00a0%",
    total: "Yhteensä",
    make: "Luo lasku",
    checking: "Tarkistetaan…",
    making: "Luodaan…",
    madeTitle: "Lasku {number} luotu",
    alreadyTitle: "Lasku {number} on jo luotu",
    paymentLink: "Maksulinkki",
    pdf: "Lataa PDF",
    pdfLanguage: "PDF:n kieli: {language}",
    yourLanguage: "sinun kielesi",
    openLink: "Avaa maksulinkki",
    pdfFailed: "PDF:ää ei tallennettu",
    noPdf: "Pyydä PDF keskustelussa",
    invalid: "Tämä lasku ei ole kelvollinen",
    fixInChat: "Korjaa se keskustelussa",
    readFailed: "Laskua ei voitu tarkistaa",
    makeFailed: "Laskua ei voitu luoda",
    retrySafe: "Voit yrittää uudelleen: sattle.me tarkistaa ensin, onko lasku jo luotu",
    retry: "Yritä uudelleen",
    cannotInvoice:
      "sattle.me-sovelluksesi ei vielä tarjoa linkillä maksettavia laskuja: päivitä se",
    unreadable: "Tätä vastausta ei voitu lukea"
  }
};

/** `template` with its {name}s replaced. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);
}
