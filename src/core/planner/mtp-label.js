// Testo di stato MTP per CLI e interfaccia web (modulo puro, senza dipendenze Node). null se il piano non ha l'informazione.
export function mtpLabel(mtp) {
  if (!mtp) return null;
  if (mtp.enabled) {
    const n = Number.isInteger(mtp.tokens) && mtp.tokens > 0 ? mtp.tokens : 1;
    return `attivo (decodifica speculativa, ${n} ${n === 1 ? 'token' : 'token per passo'})`;
  }
  return mtp.present ? 'presente nei pesi ma disattivato' : 'assente nei pesi';
}
