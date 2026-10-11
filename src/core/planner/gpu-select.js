import { fits } from './vram.js';

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function selectGpus({ catalogs, dataCenterId, needs, tpSizes, cloud = 'SECURE', util = 0.9, limit = 4 }) {
  const key = cloud.toLowerCase();
  const all = [];
  for (const count of tpSizes) {
    const need = needs(count);
    for (const g of catalogs[count] ?? []) {
      const price = g.price?.[key];
      if (!price || (g.maxCount?.[key] ?? 0) < count || !g.memory || !fits(need, g.memory, util)) continue;
      const dcs = g.dataCenters ?? [];
      const here = dcs.find((d) => d.id === dataCenterId);
      all.push({
        gpuId: g.id, name: g.name, count, memoryGiB: g.memory,
        hourly: round(price * count), perGpuGiB: round(need, 2), headroomGiB: round(g.memory * util - need, 2),
        availabilityHere: here?.availability ?? 'NONE',
        elsewhere: dcs.filter((d) => d.id !== dataCenterId && d.availability !== 'NONE').map((d) => ({ id: d.id, availability: d.availability })),
      });
    }
  }
  all.sort((a, b) => a.hourly - b.hourly || b.headroomGiB - a.headroomGiB);
  const inDc = all.filter((c) => c.availabilityHere !== 'NONE');
  return {
    choice: inDc[0] ?? null,
    alternatives: inDc.slice(1, 1 + limit),
    elsewhere: all.filter((c) => c.availabilityHere === 'NONE' && c.elsewhere.length).slice(0, limit),
    all,
  };
}
