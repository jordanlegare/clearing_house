import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { parseCsvObjects, normalizeHeader } from '../src/t3010/csv.mjs';

function streamChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); }
  });
}

test('normalizeHeader handles punctuation and BOM', () => assert.equal(normalizeHeader('\uFEFFCharity Name / Nom'), 'charity_name_nom'));

test('CSV parser handles quoted comma, escaped quote and quoted newline across chunks', async () => {
  const stream = streamChunks(['BN,Name,Program\r\n123456789RR0001,"A, B","Food ', 'bank\nprogram"\r\n123456789RR0002,"Say ""Hi""",Housing\r\n']);
  const rows = [];
  for await (const row of parseCsvObjects(stream)) rows.push(row);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fields.name, 'A, B');
  assert.equal(rows[0].fields.program, 'Food bank\nprogram');
  assert.equal(rows[1].fields.name, 'Say "Hi"');
});
