// Testo di stato MTP per CLI e interfaccia web (modulo puro, senza dipendenze Node). null se il piano non ha l'informazione.
export function mtpLabel(mtp) {
  if (!mtp) return null;
  // draft 'dspark': i tensori del draft sono stadi DSpark (DeepSeek-V4/V4.1), non un modulo MTP.
  const dspark = mtp.draft === 'dspark';
  if (mtp.enabled) {
    const n = Number.isInteger(mtp.tokens) && mtp.tokens > 0 ? mtp.tokens : 1;
    return `${dspark ? 'DSpark attivo' : 'attivo'} (decodifica speculativa, ${n} ${n === 1 ? 'token' : 'token per passo'})`;
  }
  if (!mtp.present) return 'assente nei pesi';
  return dspark ? 'draft DSpark presente nei pesi ma disattivato' : 'presente nei pesi ma disattivato';
}
