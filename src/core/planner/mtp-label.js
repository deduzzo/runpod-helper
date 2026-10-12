// Testo di stato MTP per CLI e interfaccia web (modulo puro, senza dipendenze Node). null se il piano non ha l'informazione.
export function mtpLabel(mtp) {
  if (!mtp) return null;
  if (mtp.enabled) return 'attivo (decodifica speculativa, 1 token)';
  return mtp.present ? 'presente nei pesi ma disattivato' : 'assente nei pesi';
}
