import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { extractCity, extractDesignation, extractName, extractProvince, numericFields, firstField, extractPhoneCandidates, extractEmailCandidates } from './normalize.mjs';

const STOP = new Set('the and for with from this that those these de la le les des du et pour une un dans sur of to a an in on by at is are be as or canada canadian foundation charity charitable society association incorporated inc corporation corp trust fund fonds fondation'.split(' '));

function tokens(value) {
  return [...new Set(String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{3,}/g) ?? [])]
    .filter(t => !STOP.has(t));
}

function recordText(record) {
  if (!record) return '';
  return [record.name, ...Object.values(record.fields ?? {})].filter(Boolean).join(' ');
}

function scoreText(queryTokens, text) {
  if (!queryTokens.length) return 0;
  const hay = new Set(tokens(text));
  let hits = 0;
  for (const token of queryTokens) if (hay.has(token)) hits += 1;
  return hits / queryTokens.length;
}

async function readJsonl(file) {
  const rows = [];
  try { await fs.access(file); } catch { return rows; }
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function toMap(rows) {
  const map = new Map();
  for (const row of rows) if (row.bn && !map.has(row.bn)) map.set(row.bn, row);
  return map;
}

function toMultiMap(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.bn) continue;
    if (!map.has(row.bn)) map.set(row.bn, []);
    map.get(row.bn).push(row);
  }
  return map;
}

function isFoundationDesignation(value) {
  const designation = String(value ?? '').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return /\b(?:public|private)\s+foundation\b/.test(designation)
    || /\bfondation\s+(?:publique|privee)\b/.test(designation);
}

function buildFoundationMap(identification, foundationRows) {
  const schedule1ByBn = toMap(foundationRows);
  const map = new Map();
  for (const ident of identification) {
    if (!ident.bn || !isFoundationDesignation(extractDesignation(ident.fields))) continue;
    map.set(ident.bn, schedule1ByBn.get(ident.bn) ?? { bn: ident.bn, name: ident.name, fields: {} });
  }
  return map;
}

export class T3010Repository {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.loaded = false;
    this.manifest = null;
    this.identification = [];
    this.identByBn = new Map();
    this.foundationByBn = new Map();
    this.dqByBn = new Map();
    this.programsByBn = new Map();
    this.qualifiedDoneesByBn = new Map();
    this.nonQualifiedDoneesByBn = new Map();
    this.webByBn = new Map();
    this.financialByBn = new Map();
  }

  async load({ force = false } = {}) {
    if (this.loaded && !force) return this;
    this.manifest = JSON.parse(await fs.readFile(path.join(this.dataDir, 'manifest.json'), 'utf8'));
    const [identification, foundations, dq, programs, qualified, nonQualified, web, financial] = await Promise.all([
      readJsonl(path.join(this.dataDir, 'identification.jsonl')),
      readJsonl(path.join(this.dataDir, 'foundations.jsonl')),
      readJsonl(path.join(this.dataDir, 'disbursement_quota.jsonl')),
      readJsonl(path.join(this.dataDir, 'programs.jsonl')),
      readJsonl(path.join(this.dataDir, 'qualified_donees.jsonl')),
      readJsonl(path.join(this.dataDir, 'non_qualified_donees.jsonl')),
      readJsonl(path.join(this.dataDir, 'web_addresses.jsonl')),
      readJsonl(path.join(this.dataDir, 'financial_data.jsonl'))
    ]);
    this.identification = identification;
    this.identByBn = toMap(identification);
    this.foundationByBn = buildFoundationMap(identification, foundations);
    this.dqByBn = toMap(dq);
    this.programsByBn = toMultiMap(programs);
    this.qualifiedDoneesByBn = toMultiMap(qualified);
    this.nonQualifiedDoneesByBn = toMultiMap(nonQualified);
    this.webByBn = toMap(web);
    this.financialByBn = toMap(financial);
    this.loaded = true;
    return this;
  }

  status() {
    return {
      loaded: this.loaded,
      dataDir: this.dataDir,
      year: this.manifest?.year ?? null,
      datasetId: this.manifest?.datasetId ?? null,
      charities: this.identification.length,
      foundations: this.foundationByBn.size,
      dqRecords: this.dqByBn.size,
      programRows: [...this.programsByBn.values()].reduce((n, rows) => n + rows.length, 0)
    };
  }

  charityProfile(bn) {
    const ident = this.identByBn.get(bn);
    if (!ident) return null;
    const web = this.webByBn.get(bn);
    const financial = this.financialByBn.get(bn);
    const programs = this.programsByBn.get(bn) ?? [];
    const designation = extractDesignation(ident.fields);
    return {
      id: `t3010:charity:${bn}`,
      bn,
      name: ident.name || extractName(ident.fields),
      designation,
      province: extractProvince(ident.fields),
      city: extractCity(ident.fields),
      category: firstField(ident.fields, [/category/, /charitable.*purpose/, /type.*code/]),
      fiscalPeriodEnd: firstField(ident.fields, [/fiscal.*period.*end/, /fpe/, /fiscal.*end/]),
      isFoundation: this.foundationByBn.has(bn),
      website: web ? firstField(web.fields, [/website/, /web.*url/, /^url$/]) : '',
      publicContactCandidates: [
        ...extractPhoneCandidates(ident.fields, web?.fields),
        ...extractEmailCandidates(ident.fields, web?.fields)
      ],
      programDescriptions: programs.slice(0, 8).map(r => firstField(r.fields, [/description/, /program/, /activity/]) || r.name).filter(Boolean),
      financialSignals: financial ? numericFields(financial.fields, /(revenue|expenditure|asset|liabil|gift|grant)/i) : {},
      sourceYear: this.manifest?.year ?? null
    };
  }

  foundationProfile(bn) {
    if (!this.foundationByBn.has(bn)) return null;
    const charity = this.charityProfile(bn) ?? { bn, name: this.foundationByBn.get(bn)?.name ?? '' };
    const foundation = this.foundationByBn.get(bn);
    const dq = this.dqByBn.get(bn);
    const grants = this.qualifiedDoneesByBn.get(bn) ?? [];
    return {
      ...charity,
      id: `t3010:foundation:${bn}`,
      foundationFields: foundation?.fields ?? {},
      disbursementQuotaFields: dq?.fields ?? {},
      disbursementQuotaNumeric: dq ? numericFields(dq.fields) : {},
      historicalQualifiedDoneeRows: grants.slice(0, 100).map(r => r.fields)
    };
  }

  searchCharities({ query = '', province = '', limit = 20, includeFoundations = false } = {}) {
    const q = tokens(query);
    const p = String(province ?? '').toUpperCase();
    const results = [];
    for (const ident of this.identification) {
      if (!ident.bn) continue;
      if (!includeFoundations && this.foundationByBn.has(ident.bn)) continue;
      const profile = this.charityProfile(ident.bn);
      if (!profile) continue;
      if (p && profile.province && profile.province !== p) continue;
      const text = [recordText(ident), ...(this.programsByBn.get(ident.bn) ?? []).map(recordText)].join(' ');
      const score = q.length ? scoreText(q, text) : 0.01;
      if (q.length && score === 0) continue;
      results.push({ score: Number(score.toFixed(4)), ...profile });
    }
    return results.sort((a,b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  searchFoundations({ query = '', province = '', limit = 20 } = {}) {
    const q = tokens(query);
    const p = String(province ?? '').toUpperCase();
    const results = [];
    for (const [bn, foundation] of this.foundationByBn) {
      const profile = this.foundationProfile(bn);
      if (!profile) continue;
      if (p && profile.province && profile.province !== p) continue;
      const grantText = (this.qualifiedDoneesByBn.get(bn) ?? []).slice(0, 100).map(recordText).join(' ');
      const score = q.length ? scoreText(q, `${recordText(this.identByBn.get(bn))} ${recordText(foundation)} ${grantText}`) : 0.01;
      if (q.length && score === 0) continue;
      results.push({ score: Number(score.toFixed(4)), ...profile });
    }
    return results.sort((a,b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  matchFoundation({ foundationBn, focus = '', province = '', limit = 25 } = {}) {
    const foundation = this.foundationProfile(foundationBn);
    if (!foundation) throw new Error(`Foundation ${foundationBn} not found in loaded T3010 foundation records`);
    const evidence = [focus, foundation.name, ...foundation.programDescriptions, ...(this.qualifiedDoneesByBn.get(foundationBn) ?? []).slice(0, 200).map(recordText)].join(' ');
    const q = tokens(evidence).slice(0, 120);
    if (!q.length) return { foundation, confidence: 'low', evidenceTokens: [], matches: [], explanation: 'No textual mandate or historical grant evidence was available; supply a focus phrase.' };
    const candidates = this.searchCharities({ query: q.join(' '), province, limit: Math.max(limit * 5, 100), includeFoundations: false });
    const matches = candidates.slice(0, limit).map(candidate => {
      const candidateText = [candidate.name, candidate.category, ...candidate.programDescriptions].join(' ');
      const cTokens = new Set(tokens(candidateText));
      const matchedTerms = q.filter(t => cTokens.has(t)).slice(0, 12);
      return { ...candidate, matchedTerms, rationale: matchedTerms.length ? `Shared T3010 evidence terms: ${matchedTerms.join(', ')}` : 'Weak textual match' };
    });
    return { foundation, confidence: focus ? 'user-directed' : 'historical-evidence', evidenceTokens: q.slice(0, 25), matches };
  }
}
