// Quoting POSIX per mostrare/copiare comandi: modulo puro, senza dipendenze Node (usato anche dall'interfaccia web).
const SAFE = /^[A-Za-z0-9_./:=@,+-]+$/;

export function shellQuote(arg) {
  const s = String(arg);
  return SAFE.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

export function shellQuoteArgs(args) {
  return args.map(shellQuote).join(' ');
}
