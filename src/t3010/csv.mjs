/**
 * Streaming RFC4180-ish CSV parser using only Node/Web platform primitives.
 * It handles quoted commas, CRLF, escaped double-quotes and quoted newlines.
 */
export async function* parseCsvRows(stream, { maxRows = 0 } = {}) {
  if (!stream?.getReader) throw new TypeError('stream must be a Web ReadableStream');
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let row = [];
  let field = '';
  let inQuotes = false;
  let quoteSeen = false;
  let yielded = 0;

  const pushField = () => { row.push(field); field = ''; };

  const emitRow = () => {
    pushField();
    const out = row;
    row = [];
    return out;
  };

  const processOutside = (ch) => {
    if (ch === ',' ) { pushField(); return null; }
    if (ch === '\n') return emitRow();
    if (ch === '\r') return null;
    if (ch === '"' && field.length === 0) { inQuotes = true; return null; }
    field += ch;
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const ch of text) {
        let emitted = null;
        if (inQuotes) {
          if (quoteSeen) {
            if (ch === '"') {
              field += '"';
              quoteSeen = false;
            } else {
              inQuotes = false;
              quoteSeen = false;
              emitted = processOutside(ch);
            }
          } else if (ch === '"') {
            quoteSeen = true;
          } else {
            field += ch;
          }
        } else {
          emitted = processOutside(ch);
        }
        if (emitted) {
          yielded += 1;
          yield emitted;
          if (maxRows > 0 && yielded >= maxRows) {
            await reader.cancel('row limit reached');
            return;
          }
        }
      }
    }

    const tail = decoder.decode();
    for (const ch of tail) {
      let emitted = null;
      if (inQuotes) {
        if (quoteSeen) {
          if (ch === '"') { field += '"'; quoteSeen = false; }
          else { inQuotes = false; quoteSeen = false; emitted = processOutside(ch); }
        } else if (ch === '"') quoteSeen = true;
        else field += ch;
      } else emitted = processOutside(ch);
      if (emitted) { yielded += 1; yield emitted; }
    }

    // A final quote closes the quoted field at EOF.
    if (quoteSeen) { inQuotes = false; quoteSeen = false; }
    if (inQuotes) throw new Error('unterminated quoted CSV field');
    if (field.length || row.length) yield emitRow();
  } finally {
    reader.releaseLock();
  }
}

export function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((header, i) => {
    let key = normalizeHeader(header) || `column_${i + 1}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key}_${n}`;
    return key;
  });
}

export async function* parseCsvObjects(stream, { maxRows = 0 } = {}) {
  // +1 because maxRows refers to data rows, not the header.
  const rows = parseCsvRows(stream, { maxRows: maxRows > 0 ? maxRows + 1 : 0 });
  let headers;
  let rowNumber = 0;
  for await (const row of rows) {
    if (!headers) {
      headers = uniqueHeaders(row);
      continue;
    }
    rowNumber += 1;
    const obj = {};
    for (let i = 0; i < headers.length; i += 1) obj[headers[i]] = row[i] ?? '';
    yield { rowNumber, fields: obj };
  }
}
