export function register(program, getCtx) {
  program.command('rotate-key <profilo>')
    .description('Genera una nuova chiave vLLM per il profilo')
    .action(async (name) => {
      const ctx = getCtx();
      const r = await ctx.ops.rotateKey(name);
      ctx.io.out(`✓ Nuova chiave per ${name} salvata nel file .env (non viene mostrata).`);
      if (r.activePodId) ctx.io.out(`⚠ Il Pod ${r.activePodId} usa ancora la chiave precedente: riavvialo con "llmpod down ${name}" e "llmpod up ${name}".`);
    });
}
