import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsvObjects } from './csv.mjs';
import { fetchOpenCanadaPackage, discoverT3010Resources } from './catalog.mjs';
import { DEFAULT_T3010_YEAR, RESOURCE_KINDS } from './constants.mjs';
import { normalizeT3010Record } from './normalize.mjs';

async function writeResource({ kind, resource, outputDir, maxRows, fetchImpl }) {
  const response = await fetchImpl(resource.url, {
    headers: { 'user-agent': 'canadian-philanthropy-clearing-house/0.2 (+https://github.com/jordanlegare/clearing_house)' }
  });
  if (!response.ok || !response.body) throw new Error(`Failed ${kind} download: ${response.status} ${response.statusText}`);

  await fs.mkdir(outputDir, { recursive: true });
  const finalPath = path.join(outputDir, `${kind}.jsonl`);
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(tempPath, 'w');
  let rows = 0;
  let withBn = 0;
  try {
    for await (const row of parseCsvObjects(response.body, { maxRows })) {
      const record = normalizeT3010Record({ kind, ...row, resource });
      rows += 1;
      if (record.bn) withBn += 1;
      await handle.write(`${JSON.stringify(record)}\n`);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  await fs.rename(tempPath, finalPath);
  return {
    kind, rows, rowsWithBusinessNumber: withBn, path: finalPath,
    sourceResourceId: resource.id, sourceUrl: resource.url,
    etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified')
  };
}

export async function ingestT3010({
  year = DEFAULT_T3010_YEAR,
  datasetId,
  outputDir = path.resolve('data', 't3010', String(year)),
  resources = RESOURCE_KINDS,
  maxRows = 0,
  fetchImpl = fetch,
  onProgress = () => {}
} = {}) {
  if (!Number.isInteger(Number(year))) throw new TypeError('year must be an integer');
  if (!Number.isInteger(maxRows) || maxRows < 0) throw new TypeError('maxRows must be a non-negative integer');
  const wanted = [...new Set(resources)];
  for (const kind of wanted) if (!RESOURCE_KINDS.includes(kind)) throw new Error(`Unknown T3010 resource kind: ${kind}`);

  const catalogue = await fetchOpenCanadaPackage({ year, datasetId, fetchImpl });
  const discovered = discoverT3010Resources(catalogue.package);
  const missing = wanted.filter(kind => !discovered[kind]);
  if (missing.length) throw new Error(`Open Canada catalogue is missing expected CSV resources: ${missing.join(', ')}`);

  const startedAt = new Date().toISOString();
  const results = [];
  for (const kind of wanted) {
    onProgress({ phase: 'resource_start', kind, url: discovered[kind].url });
    const result = await writeResource({ kind, resource: discovered[kind], outputDir, maxRows, fetchImpl });
    results.push(result);
    onProgress({ phase: 'resource_complete', ...result });
  }

  const manifest = {
    schemaVersion: 1,
    source: 'Canada Revenue Agency T3010 / Open Government Canada',
    year: Number(year),
    datasetId: catalogue.id,
    catalogueUrl: catalogue.url,
    datasetTitle: catalogue.package.title ?? `${year} List of charities`,
    datasetModified: catalogue.package.metadata_modified ?? null,
    startedAt,
    completedAt: new Date().toISOString(),
    maxRowsPerResource: maxRows || null,
    resources: results.map(({ path: p, ...r }) => ({ ...r, file: path.basename(p) }))
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
