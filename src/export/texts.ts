/*
 * The texts of the export (SPEC.md §20), as the merchant's app writes them in « Portefeuille ›
 * Exporter » (its src/i18n/locales/*.ts: walletExport.columns, .remarks, .pdf; activity.sources,
 * .you; wallet.titles, .networks), in its 7 languages, German in its two variants (« de », « de-CH »).
 * Copied as they are: the export's vectors (vectors/app/export.json), made by the app, check every
 * one the files write. `{{name}}` is filled as i18next fills it (no escaping).
 */

import type { TextLanguage } from "../protocol/constants.js";

export type ExportTexts = (typeof EXPORT_TEXTS)[TextLanguage];

export const EXPORT_TEXTS = {
  fr: {
    columns: {
      dateAndTime: "Date et heure",
      label: "Libellé",
      source: "Source",
      by: "Par",
      network: "Type de paiement",
      reference: "Référence",
      bitcoinAmount: "Montant en BTC",
      bitcoinFees: "Frais en BTC",
      fiatAmount: "Montant en {{currency}}",
      fiatFees: "Frais en {{currency}}",
      originalAmount: "Montant saisi",
      originalCurrency: "Devise saisie",
      bitcoinPrice: "Cours du bitcoin en {{currency}}",
      remark: "Remarque"
    },
    remarks: {
      accepted:
        "Différence de {{fiat}} / {{btc}}, accepté par le propriétaire le {{date}} à {{time}}",
      acceptedSats: "Différence de {{btc}}, accepté par le propriétaire le {{date}} à {{time}}"
    },
    pdf: {
      title: "Rapport de transactions",
      period: "Du {{first}} au {{last}}",
      made: "Établi le {{date}}",
      count: "Nombre de transactions",
      countOf: {
        pos: "dont point de vente",
        link: "dont factures",
        integration: "dont intégrations",
        receive: "dont réceptions",
        send: "dont envois"
      },
      received: "Montant total encaissé",
      sent: "Montant total envoyé",
      fees: "Frais d'envoi",
      lines: "Détail des transactions",
      none: "Aucune transaction terminée sur cette période.",
      amount: "Montant ({{unit}})",
      amountMixed: "Montant",
      valuesNote:
        "Une vente compte pour le montant saisi, dans sa devise ; toute autre transaction, pour la valeur de ses bitcoins au cours noté lors de son paiement (source : CoinGecko). Une transaction sans cours noté compte en BTC.",
      valuesNoteImported:
        "Une vente compte pour le montant saisi, dans sa devise ; toute autre transaction, pour la valeur de ses bitcoins au cours noté lors de son paiement (source : CoinGecko ; pour l'historique repris de votre ancien service de paiement, le cours qu'il avait enregistré). Une transaction sans cours noté compte en BTC."
    },
    sources: {
      pos: "Point de Vente",
      link: "Facture",
      integration: "Intégration",
      receive: "Réception",
      send: "Envoi"
    },
    you: "Vous",
    titles: {
      deposit: "Dépôt",
      withdrawal: "Retrait"
    },
    networks: {
      lightning: "Lightning",
      bitcoin: "Bitcoin",
      spark: "Spark"
    }
  },
  en: {
    columns: {
      dateAndTime: "Date and time",
      label: "Description",
      source: "Source",
      by: "By",
      network: "Payment type",
      reference: "Reference",
      bitcoinAmount: "Amount in BTC",
      bitcoinFees: "Fees in BTC",
      fiatAmount: "Amount in {{currency}}",
      fiatFees: "Fees in {{currency}}",
      originalAmount: "Amount entered",
      originalCurrency: "Currency entered",
      bitcoinPrice: "Bitcoin price in {{currency}}",
      remark: "Remark"
    },
    remarks: {
      accepted: "Difference of {{fiat}} / {{btc}}, accepted by the owner on {{date}} at {{time}}",
      acceptedSats: "Difference of {{btc}}, accepted by the owner on {{date}} at {{time}}"
    },
    pdf: {
      title: "Transactions report",
      period: "From {{first}} to {{last}}",
      made: "Issued on {{date}}",
      count: "Number of transactions",
      countOf: {
        pos: "of which point of sale",
        link: "of which invoices",
        integration: "of which integrations",
        receive: "of which received",
        send: "of which sent"
      },
      received: "Total received",
      sent: "Total sent",
      fees: "Sending fees",
      lines: "Transaction details",
      none: "No completed transaction in this period.",
      amount: "Amount ({{unit}})",
      amountMixed: "Amount",
      valuesNote:
        "A sale counts at the amount entered, in its currency; any other transaction, at the value of its bitcoin at the price recorded when it was paid (source: CoinGecko). A transaction without a recorded price counts in BTC.",
      valuesNoteImported:
        "A sale counts for the amount typed, in its currency; any other transaction, for the value of its bitcoin at the rate recorded at its payment (source: CoinGecko; for the history taken over from your former payment service, the rate it had recorded). A transaction without a recorded rate counts in BTC."
    },
    sources: {
      pos: "Point of sale",
      link: "Invoice",
      integration: "Integration",
      receive: "Received",
      send: "Sent"
    },
    you: "You",
    titles: {
      deposit: "Deposit",
      withdrawal: "Withdrawal"
    },
    networks: {
      lightning: "Lightning",
      bitcoin: "Bitcoin",
      spark: "Spark"
    }
  },
  de: {
    columns: {
      dateAndTime: "Datum und Uhrzeit",
      label: "Bezeichnung",
      source: "Quelle",
      by: "Von",
      network: "Zahlungsart",
      reference: "Referenz",
      bitcoinAmount: "Betrag in BTC",
      bitcoinFees: "Gebühren in BTC",
      fiatAmount: "Betrag in {{currency}}",
      fiatFees: "Gebühren in {{currency}}",
      originalAmount: "Erfasster Betrag",
      originalCurrency: "Erfasste Währung",
      bitcoinPrice: "Bitcoin-Kurs in {{currency}}",
      remark: "Bemerkung"
    },
    remarks: {
      accepted: "Differenz von {{fiat}} / {{btc}}, vom Inhaber akzeptiert am {{date}} um {{time}}",
      acceptedSats: "Differenz von {{btc}}, vom Inhaber akzeptiert am {{date}} um {{time}}"
    },
    pdf: {
      title: "Transaktionsbericht",
      period: "Vom {{first}} bis {{last}}",
      made: "Erstellt am {{date}}",
      count: "Anzahl Transaktionen",
      countOf: {
        pos: "davon Kasse",
        link: "davon Rechnungen",
        integration: "davon Integrationen",
        receive: "davon Eingänge",
        send: "davon Ausgänge"
      },
      received: "Insgesamt eingenommen",
      sent: "Insgesamt gesendet",
      fees: "Sendegebühren",
      lines: "Transaktionen im Detail",
      none: "Keine abgeschlossene Transaktion in diesem Zeitraum.",
      amount: "Betrag ({{unit}})",
      amountMixed: "Betrag",
      valuesNote:
        "Ein Verkauf zählt mit dem erfassten Betrag, in seiner Währung; jede andere Transaktion mit dem Wert ihrer Bitcoin zum bei der Zahlung festgehaltenen Kurs (Quelle: CoinGecko). Eine Transaktion ohne festgehaltenen Kurs zählt in BTC.",
      valuesNoteImported:
        "Ein Verkauf zählt mit dem eingegebenen Betrag in seiner Währung; jede andere Transaktion mit dem Wert ihrer Bitcoins zum bei ihrer Zahlung notierten Kurs (Quelle: CoinGecko; für den von Ihrem früheren Zahlungsdienst übernommenen Verlauf der dort erfasste Kurs). Eine Transaktion ohne notierten Kurs zählt in BTC."
    },
    sources: {
      pos: "Kasse",
      link: "Rechnung",
      integration: "Integration",
      receive: "Eingang",
      send: "Ausgang"
    },
    you: "Sie",
    titles: {
      deposit: "Einzahlung",
      withdrawal: "Auszahlung"
    },
    networks: {
      lightning: "Lightning",
      bitcoin: "Bitcoin",
      spark: "Spark"
    }
  },
  "de-CH": {
    columns: {
      dateAndTime: "Datum und Uhrzeit",
      label: "Bezeichnung",
      source: "Quelle",
      by: "Von",
      network: "Zahlungsart",
      reference: "Referenz",
      bitcoinAmount: "Betrag in BTC",
      bitcoinFees: "Gebühren in BTC",
      fiatAmount: "Betrag in {{currency}}",
      fiatFees: "Gebühren in {{currency}}",
      originalAmount: "Erfasster Betrag",
      originalCurrency: "Erfasste Währung",
      bitcoinPrice: "Bitcoin-Kurs in {{currency}}",
      remark: "Bemerkung"
    },
    remarks: {
      accepted: "Differenz von {{fiat}} / {{btc}}, vom Inhaber akzeptiert am {{date}} um {{time}}",
      acceptedSats: "Differenz von {{btc}}, vom Inhaber akzeptiert am {{date}} um {{time}}"
    },
    pdf: {
      title: "Transaktionsbericht",
      period: "Vom {{first}} bis {{last}}",
      made: "Erstellt am {{date}}",
      count: "Anzahl Transaktionen",
      countOf: {
        pos: "davon Kasse",
        link: "davon Rechnungen",
        integration: "davon Integrationen",
        receive: "davon Eingänge",
        send: "davon Ausgänge"
      },
      received: "Total eingenommen",
      sent: "Total gesendet",
      fees: "Sendegebühren",
      lines: "Transaktionen im Detail",
      none: "Keine abgeschlossene Transaktion in diesem Zeitraum.",
      amount: "Betrag ({{unit}})",
      amountMixed: "Betrag",
      valuesNote:
        "Ein Verkauf zählt mit dem erfassten Betrag, in seiner Währung; jede andere Transaktion mit dem Wert ihrer Bitcoin zum bei der Zahlung festgehaltenen Kurs (Quelle: CoinGecko). Eine Transaktion ohne festgehaltenen Kurs zählt in BTC.",
      valuesNoteImported:
        "Ein Verkauf zählt mit dem eingegebenen Betrag in seiner Währung; jede andere Transaktion mit dem Wert ihrer Bitcoins zum bei ihrer Zahlung notierten Kurs (Quelle: CoinGecko; für den von Ihrem früheren Zahlungsdienst übernommenen Verlauf der dort erfasste Kurs). Eine Transaktion ohne notierten Kurs zählt in BTC."
    },
    sources: {
      pos: "Kasse",
      link: "Rechnung",
      integration: "Integration",
      receive: "Eingang",
      send: "Ausgang"
    },
    you: "Sie",
    titles: {
      deposit: "Einzahlung",
      withdrawal: "Auszahlung"
    },
    networks: {
      lightning: "Lightning",
      bitcoin: "Bitcoin",
      spark: "Spark"
    }
  },
  it: {
    columns: {
      dateAndTime: "Data e ora",
      label: "Descrizione",
      source: "Origine",
      by: "Da",
      network: "Tipo di pagamento",
      reference: "Riferimento",
      bitcoinAmount: "Importo in BTC",
      bitcoinFees: "Commissioni in BTC",
      fiatAmount: "Importo in {{currency}}",
      fiatFees: "Commissioni in {{currency}}",
      originalAmount: "Importo inserito",
      originalCurrency: "Valuta inserita",
      bitcoinPrice: "Prezzo del bitcoin in {{currency}}",
      remark: "Osservazione"
    },
    remarks: {
      accepted:
        "Differenza di {{fiat}} / {{btc}}, accettata dal titolare il {{date}} alle {{time}}",
      acceptedSats: "Differenza di {{btc}}, accettata dal titolare il {{date}} alle {{time}}"
    },
    pdf: {
      title: "Rapporto sulle transazioni",
      period: "Dal {{first}} al {{last}}",
      made: "Redatto il {{date}}",
      count: "Numero di transazioni",
      countOf: {
        pos: "di cui punto vendita",
        link: "di cui fatture",
        integration: "di cui integrazioni",
        receive: "di cui ricezioni",
        send: "di cui invii"
      },
      received: "Totale incassato",
      sent: "Totale inviato",
      fees: "Commissioni d'invio",
      lines: "Dettaglio delle transazioni",
      none: "Nessuna transazione conclusa in questo periodo.",
      amount: "Importo ({{unit}})",
      amountMixed: "Importo",
      valuesNote:
        "Una vendita conta per l'importo inserito, nella sua valuta; ogni altra transazione, per il valore dei suoi bitcoin al prezzo registrato al momento del pagamento (fonte: CoinGecko). Una transazione senza prezzo registrato conta in BTC.",
      valuesNoteImported:
        "Una vendita conta per l'importo inserito, nella sua valuta; ogni altra transazione, per il valore dei suoi bitcoin al cambio registrato al momento del pagamento (fonte: CoinGecko; per la cronologia ripresa dal tuo precedente servizio di pagamento, il cambio da esso registrato). Una transazione senza cambio registrato conta in BTC."
    },
    sources: {
      pos: "Punto vendita",
      link: "Fattura",
      integration: "Integrazione",
      receive: "Ricezione",
      send: "Invio"
    },
    you: "Tu",
    titles: {
      deposit: "Deposito",
      withdrawal: "Prelievo"
    },
    networks: {
      lightning: "Lightning",
      bitcoin: "Bitcoin",
      spark: "Spark"
    }
  },
  es: {
    columns: {
      dateAndTime: "Fecha y hora",
      label: "Concepto",
      source: "Origen",
      by: "Por",
      network: "Tipo de pago",
      reference: "Referencia",
      bitcoinAmount: "Importe en BTC",
      bitcoinFees: "Comisiones en BTC",
      fiatAmount: "Importe en {{currency}}",
      fiatFees: "Comisiones en {{currency}}",
      originalAmount: "Importe introducido",
      originalCurrency: "Moneda introducida",
      bitcoinPrice: "Precio del bitcoin en {{currency}}",
      remark: "Observación"
    },
    remarks: {
      accepted:
        "Diferencia de {{fiat}} / {{btc}}, aceptada por el propietario el {{date}} a las {{time}}",
      acceptedSats: "Diferencia de {{btc}}, aceptada por el propietario el {{date}} a las {{time}}"
    },
    pdf: {
      title: "Informe de transacciones",
      period: "Del {{first}} al {{last}}",
      made: "Emitido el {{date}}",
      count: "Número de transacciones",
      countOf: {
        pos: "de ellas, punto de venta",
        link: "de ellas, facturas",
        integration: "de ellas, integraciones",
        receive: "de ellas, recepciones",
        send: "de ellas, envíos"
      },
      received: "Total cobrado",
      sent: "Total enviado",
      fees: "Comisiones de envío",
      lines: "Detalle de las transacciones",
      none: "Ninguna transacción finalizada en este periodo.",
      amount: "Importe ({{unit}})",
      amountMixed: "Importe",
      valuesNote:
        "Una venta cuenta por el importe introducido, en su moneda; cualquier otra transacción, por el valor de sus bitcoins al precio registrado en su pago (fuente: CoinGecko). Una transacción sin precio registrado cuenta en BTC.",
      valuesNoteImported:
        "Una venta cuenta por el importe introducido, en su moneda; cualquier otra transacción, por el valor de sus bitcoins al cambio registrado en su pago (fuente: CoinGecko; para el historial recuperado de tu anterior servicio de pago, el cambio que este registró). Una transacción sin cambio registrado cuenta en BTC."
    },
    sources: {
      pos: "Punto de venta",
      link: "Factura",
      integration: "Integración",
      receive: "Recepción",
      send: "Envío"
    },
    you: "Tú",
    titles: {
      deposit: "Depósito",
      withdrawal: "Retiro"
    },
    networks: {
      lightning: "Lightning",
      bitcoin: "Bitcoin",
      spark: "Spark"
    }
  },
  pt: {
    columns: {
      dateAndTime: "Data e hora",
      label: "Descrição",
      source: "Origem",
      by: "Por",
      network: "Tipo de pagamento",
      reference: "Referência",
      bitcoinAmount: "Montante em BTC",
      bitcoinFees: "Comissões em BTC",
      fiatAmount: "Montante em {{currency}}",
      fiatFees: "Comissões em {{currency}}",
      originalAmount: "Montante introduzido",
      originalCurrency: "Moeda introduzida",
      bitcoinPrice: "Preço do bitcoin em {{currency}}",
      remark: "Observação"
    },
    remarks: {
      accepted: "Diferença de {{fiat}} / {{btc}}, aceite pelo proprietário em {{date}} às {{time}}",
      acceptedSats: "Diferença de {{btc}}, aceite pelo proprietário em {{date}} às {{time}}"
    },
    pdf: {
      title: "Relatório de transações",
      period: "De {{first}} a {{last}}",
      made: "Emitido a {{date}}",
      count: "Número de transações",
      countOf: {
        pos: "das quais ponto de venda",
        link: "das quais faturas",
        integration: "das quais integrações",
        receive: "das quais receções",
        send: "das quais envios"
      },
      received: "Total recebido",
      sent: "Total enviado",
      fees: "Comissões de envio",
      lines: "Detalhe das transações",
      none: "Nenhuma transação concluída neste período.",
      amount: "Montante ({{unit}})",
      amountMixed: "Montante",
      valuesNote:
        "Uma venda conta pelo montante introduzido, na sua moeda; qualquer outra transação, pelo valor dos seus bitcoins ao preço registado no seu pagamento (fonte: CoinGecko). Uma transação sem preço registado conta em BTC.",
      valuesNoteImported:
        "Uma venda conta pelo montante introduzido, na sua moeda; qualquer outra transação, pelo valor dos seus bitcoins à cotação registada no seu pagamento (fonte: CoinGecko; para o histórico recuperado do seu anterior serviço de pagamento, a cotação que este registou). Uma transação sem cotação registada conta em BTC."
    },
    sources: {
      pos: "Ponto de venda",
      link: "Fatura",
      integration: "Integração",
      receive: "Receção",
      send: "Envio"
    },
    you: "Você",
    titles: {
      deposit: "Depósito",
      withdrawal: "Levantamento"
    },
    networks: {
      lightning: "Lightning",
      bitcoin: "Bitcoin",
      spark: "Spark"
    }
  },
  fi: {
    columns: {
      dateAndTime: "Päivä ja aika",
      label: "Kuvaus",
      source: "Lähde",
      by: "Tekijä",
      network: "Maksutapa",
      reference: "Viite",
      bitcoinAmount: "Summa (BTC)",
      bitcoinFees: "Kulut (BTC)",
      fiatAmount: "Summa ({{currency}})",
      fiatFees: "Kulut ({{currency}})",
      originalAmount: "Syötetty summa",
      originalCurrency: "Syötetty valuutta",
      bitcoinPrice: "Bitcoinin kurssi ({{currency}})",
      remark: "Huomautus"
    },
    remarks: {
      accepted: "Erotus {{fiat}} / {{btc}}, omistaja hyväksyi {{date}} klo {{time}}",
      acceptedSats: "Erotus {{btc}}, omistaja hyväksyi {{date}} klo {{time}}"
    },
    pdf: {
      title: "Tapahtumaraportti",
      period: "{{first}} – {{last}}",
      made: "Laadittu {{date}}",
      count: "Tapahtumien määrä",
      countOf: {
        pos: "joista kassa",
        link: "joista laskut",
        integration: "joista integraatiot",
        receive: "joista vastaanotetut",
        send: "joista lähetetyt"
      },
      received: "Vastaanotettu yhteensä",
      sent: "Lähetetty yhteensä",
      fees: "Lähetyskulut",
      lines: "Tapahtumat eriteltyinä",
      none: "Ei päättyneitä tapahtumia tällä aikavälillä.",
      amount: "Summa ({{unit}})",
      amountMixed: "Summa",
      valuesNote:
        "Myynti lasketaan syötetyllä summalla, omassa valuutassaan; muut tapahtumat bitcoiniensa arvolla maksuhetkellä tallennetulla kurssilla (lähde: CoinGecko). Tapahtuma ilman tallennettua kurssia lasketaan bitcoineina (BTC).",
      valuesNoteImported:
        "Myynti lasketaan syötetyn summan mukaan sen valuutassa; muut tapahtumat bitcoiniensa arvon mukaan maksuhetkellä kirjatulla kurssilla (lähde: CoinGecko; aiemmasta maksupalvelustasi siirretyn historian osalta sen kirjaama kurssi). Tapahtuma ilman kirjattua kurssia lasketaan BTC:nä."
    },
    sources: {
      pos: "Kassa",
      link: "Lasku",
      integration: "Integraatio",
      receive: "Vastaanotettu",
      send: "Lähetetty"
    },
    you: "Sinä",
    titles: {
      deposit: "Talletus",
      withdrawal: "Nosto"
    },
    networks: {
      lightning: "Lightning",
      bitcoin: "Bitcoin",
      spark: "Spark"
    }
  }
} as const satisfies Record<TextLanguage, unknown>;

/** `text` with each `{{name}}` filled from `values` (i18next's interpolation, unescaped). */
export function fill(text: string, values: Record<string, string> = {}): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}
