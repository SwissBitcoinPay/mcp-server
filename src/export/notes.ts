/*
 * What an assistant's export adds to the app's report (SPEC.md §20): what it cannot hold, said in
 * the PDF under the app's note on the values, in the merchant's language (German in its two
 * variants, « de » and « de-CH », as the app's).
 * The CSV is the app's, column for column: the tool's answer says it there.
 */

import type { TextLanguage } from "../protocol/constants.js";

export type ExportNotes = {
  /** The payments the export cannot hold. */
  excluded: string;
  /** Sales whose payment could not be proven ({{count}}): in no line. */
  setAside: string;
  /** The history copied from the v2 account is not whole on the relays. */
  historyIncomplete: string;
};

export const EXPORT_NOTES: Record<TextLanguage, ExportNotes> = {
  fr: {
    excluded:
      "Établi par votre assistant IA à partir des enregistrements de votre compte. N'y figurent pas : les paiements reçus directement sur votre portefeuille sans vente (sur votre adresse Lightning sans facture, ou sur une adresse de votre portefeuille), ni les envois faits hors de l'app sattle.me.",
    setAside:
      "{{count}} vente(s) dont le paiement n'a pas pu être prouvé n'y figurent pas : vérifiez-les dans l'app sattle.me.",
    historyIncomplete:
      "L'historique repris de votre ancien service de paiement n'est pas encore entièrement copié : terminez la copie dans l'app sattle.me."
  },
  en: {
    excluded:
      "Made by your AI assistant from your account's records. Not included: payments received directly in your wallet without a sale (to your Lightning address without an invoice, or to an address of your wallet), and payments sent outside the sattle.me app.",
    setAside:
      "{{count}} sale(s) whose payment could not be proven are not included: check them in the sattle.me app.",
    historyIncomplete:
      "The history taken over from your former payment service is not fully copied yet: finish the copy in the sattle.me app."
  },
  de: {
    excluded:
      "Von Ihrem KI-Assistenten aus den Aufzeichnungen Ihres Kontos erstellt. Nicht enthalten: Zahlungen, die ohne Verkauf direkt in Ihrer Wallet eingegangen sind (an Ihre Lightning-Adresse ohne Rechnung oder an eine Adresse Ihrer Wallet), sowie Zahlungen, die außerhalb der sattle.me-App gesendet wurden.",
    setAside:
      "{{count}} Verkauf/Verkäufe, deren Zahlung nicht nachgewiesen werden konnte, sind nicht enthalten: Prüfen Sie sie in der sattle.me-App.",
    historyIncomplete:
      "Der von Ihrem früheren Zahlungsdienst übernommene Verlauf ist noch nicht vollständig kopiert: Schließen Sie das Kopieren in der sattle.me-App ab."
  },
  "de-CH": {
    excluded:
      "Von Ihrem KI-Assistenten aus den Aufzeichnungen Ihres Kontos erstellt. Nicht enthalten: Zahlungen, die ohne Verkauf direkt in Ihrer Wallet eingegangen sind (an Ihre Lightning-Adresse ohne Rechnung oder an eine Adresse Ihrer Wallet), sowie Zahlungen, die ausserhalb der sattle.me-App gesendet wurden.",
    setAside:
      "{{count}} Verkauf/Verkäufe, deren Zahlung nicht nachgewiesen werden konnte, sind nicht enthalten: Prüfen Sie sie in der sattle.me-App.",
    historyIncomplete:
      "Der von Ihrem früheren Zahlungsdienst übernommene Verlauf ist noch nicht vollständig kopiert: Schliessen Sie das Kopieren in der sattle.me-App ab."
  },
  it: {
    excluded:
      "Redatto dal vostro assistente IA a partire dalle registrazioni del vostro conto. Non sono inclusi: i pagamenti ricevuti direttamente nel vostro portafoglio senza una vendita (al vostro indirizzo Lightning senza fattura, o a un indirizzo del vostro portafoglio), né i pagamenti inviati al di fuori dell'app sattle.me.",
    setAside:
      "{{count}} vendita/e il cui pagamento non ha potuto essere provato non sono incluse: verificatele nell'app sattle.me.",
    historyIncomplete:
      "Lo storico ripreso dal vostro precedente servizio di pagamento non è ancora copiato interamente: completate la copia nell'app sattle.me."
  },
  es: {
    excluded:
      "Elaborado por su asistente de IA a partir de los registros de su cuenta. No se incluyen: los pagos recibidos directamente en su monedero sin una venta (en su dirección Lightning sin factura, o en una dirección de su monedero), ni los envíos hechos fuera de la app sattle.me.",
    setAside:
      "{{count}} venta(s) cuyo pago no se pudo probar no se incluyen: verifíquelas en la app sattle.me.",
    historyIncomplete:
      "El historial recuperado de su anterior servicio de pago aún no está copiado por completo: termine la copia en la app sattle.me."
  },
  pt: {
    excluded:
      "Elaborado pelo seu assistente de IA a partir dos registos da sua conta. Não estão incluídos: os pagamentos recebidos diretamente na sua carteira sem uma venda (no seu endereço Lightning sem fatura, ou num endereço da sua carteira), nem os envios feitos fora da app sattle.me.",
    setAside:
      "{{count}} venda(s) cujo pagamento não pôde ser provado não estão incluídas: verifique-as na app sattle.me.",
    historyIncomplete:
      "O histórico recuperado do seu anterior serviço de pagamento ainda não está totalmente copiado: termine a cópia na app sattle.me."
  },
  fi: {
    excluded:
      "Tekoälyavustajasi laatima tilisi tietueista. Ei sisällä: suoraan lompakkoosi ilman myyntiä saapuneita maksuja (Lightning-osoitteeseesi ilman laskua tai lompakkosi osoitteeseen) eikä sattle.me-sovelluksen ulkopuolella lähetettyjä maksuja.",
    setAside:
      "{{count}} myyntiä, joiden maksua ei voitu todentaa, ei ole mukana: tarkista ne sattle.me-sovelluksessa.",
    historyIncomplete:
      "Aiemmasta maksupalvelustasi siirrettyä historiaa ei ole vielä kopioitu kokonaan: viimeistele kopiointi sattle.me-sovelluksessa."
  }
};
