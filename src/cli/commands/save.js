export function register(program, getCtx) {
  program.command('save <nome>')
    .description('Salva l\'ultimo piano come profilo riutilizzabile')
    .action(async (name) => {
      const ctx = getCtx();
      const profile = ctx.ops.saveProfile(name);
      ctx.io.out(`✓ Profilo "${name}" salvato in ${ctx.store.dir}/profiles/${name}.json`);
      ctx.io.out('  Chiave vLLM del profilo salvata nel file .env (non viene mostrata).');
      if (!profile.volume) ctx.io.out('⚠ Nessun network volume nello stesso datacenter: i pesi saranno scaricati a ogni avvio.');
      ctx.io.out(`Avvia con: llmpod up ${name}`);
    });
}
