/*
 * Replacements (SPEC.md, "Replacements"): a payer whose transaction is slow to confirm may
 * broadcast another one in its place (RBF), which spends a coin of the same. A replacement keeps
 * the time of the payment it replaces, for at most what that payment paid the address: what it pays
 * more counts at its own time, as any other payment would.
 */

/** A transaction paying the address, as the parts are made of it. */
export type PaymentTx = {
  txid: string;
  /** What it pays the address. */
  sats: bigint;
  /** The coins it spends (`<txid>:<vout>`), or those recorded of it. */
  inputs: readonly string[];
  /** When it was seen (a witness's `created_at`); null: unknown, after every known one. */
  order: number | null;
  /** Whether the explorer lists it now. */
  listed: boolean;
};

/** A part of a listed transaction: sats it pays as its `root` (itself, for a part of its own). */
export type Part = { sats: bigint; root: string };

/**
 * The parts of each listed transaction, by txid: a txid given twice is taken once (its first
 * entry); the transactions in order (unknown last, then by txid); the roots of each are those before
 * it that spend one of its coins (their roots, put together), else itself; each root gives at most
 * its sats, in that order, then what a transaction still pays is a part of its own.
 */
export function paymentParts(txs: readonly PaymentTx[]): Map<string, Part[]> {
  const unique = new Map<string, PaymentTx>();
  for (const tx of txs) if (!unique.has(tx.txid)) unique.set(tx.txid, tx);
  const sorted = [...unique.values()].sort((a, b) => {
    if (a.order !== b.order) {
      if (a.order === null) return 1;
      if (b.order === null) return -1;
      return a.order - b.order;
    }
    return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
  });
  const position = new Map(sorted.map((tx, index) => [tx.txid, index]));
  const roots = new Map<string, string[]>();
  sorted.forEach((tx, index) => {
    const coins = new Set(tx.inputs);
    const before = sorted
      .slice(0, index)
      .filter((other) => other.inputs.some((coin) => coins.has(coin)));
    if (before.length === 0) {
      roots.set(tx.txid, [tx.txid]);
      return;
    }
    const together = new Set(before.flatMap((other) => roots.get(other.txid)!));
    roots.set(
      tx.txid,
      [...together].sort((a, b) => position.get(a)! - position.get(b)!)
    );
  });
  const toGive = new Map(sorted.map((tx) => [tx.txid, tx.sats]));
  const parts = new Map<string, Part[]>();
  for (const tx of sorted) {
    if (!tx.listed) continue;
    const own = roots.get(tx.txid)!;
    let owed = tx.sats;
    const list: Part[] = [];
    if (own.length === 1 && own[0] === tx.txid) {
      // A payment of its own: all its sats, which it no longer has to give.
      toGive.set(tx.txid, 0n);
    } else {
      for (const root of own) {
        const left = toGive.get(root)!;
        const take = owed < left ? owed : left;
        if (take > 0n) {
          list.push({ sats: take, root });
          toGive.set(root, left - take);
          owed -= take;
        }
      }
    }
    if (owed > 0n) list.push({ sats: owed, root: tx.txid });
    parts.set(tx.txid, list);
  }
  return parts;
}
