function statValue(stats, name) {
  if (!stats) return undefined;
  if (stats[name + '_value'] !== undefined) return stats[name + '_value'];
  return stats[name];
}

function overlaps(minA, maxA, minB, maxB) {
  if (minA == null || maxA == null || minB == null || maxB == null) return true;
  return !(Number(minA) > Number(maxB) || Number(maxA) < Number(minB));
}

export function survivingRowGroups(rowGroups, { timeCol, latCol, lonCol, timeRange, bbox } = {}) {
  const keep = [];
  for (const rg of rowGroups || []) {
    let ok = true;
    const stats = rg.stats || {};
    if (ok && timeRange && timeCol && stats[timeCol]) {
      ok = overlaps(statValue(stats[timeCol], 'min'), statValue(stats[timeCol], 'max'), timeRange[0], timeRange[1]);
    }
    if (ok && bbox && latCol && lonCol && stats[latCol] && stats[lonCol]) {
      ok = overlaps(statValue(stats[latCol], 'min'), statValue(stats[latCol], 'max'), bbox[1], bbox[3]) &&
        overlaps(statValue(stats[lonCol], 'min'), statValue(stats[lonCol], 'max'), bbox[0], bbox[2]);
    }
    if (ok) keep.push(rg.index);
  }
  return keep;
}
