import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let dollarTag = null;
  let inSingleQuote = false;
  for (let index = 0; index < sql.length; index += 1) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += sql[index];
      }
      continue;
    }
    if (inSingleQuote) {
      current += sql[index];
      if (sql[index] === "'" && sql[index + 1] === "'") {
        current += sql[index + 1];
        index += 1;
      } else if (sql[index] === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (sql[index] === "'") {
      inSingleQuote = true;
      current += sql[index];
      continue;
    }
    if (sql[index] === '$') {
      const tag = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/)?.[0];
      if (tag) {
        dollarTag = tag;
        current += tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (sql[index] === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += sql[index];
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

test('migration 016 repairs only an invalid interrupted rate index before a top-level concurrent create', () => {
  const sql = readFileSync(new URL('../db/migrations/016_admin_test_notifications.sql', import.meta.url), 'utf8');
  const statements = splitSqlStatements(sql);
  assert.equal(statements.some(statement => /^BEGIN\b/i.test(statement)), false);
  assert.equal(statements.some(statement => /^COMMIT\b/i.test(statement)), false);

  const createIndexPosition = statements.findIndex(statement => /^CREATE\s+INDEX\s+CONCURRENTLY\b/i.test(statement));
  assert.notEqual(createIndexPosition, -1);
  const repairPosition = statements.findIndex(statement => (
    /^DO\s+\$\$/i.test(statement)
    && /pg_index/i.test(statement)
    && /notification_outbox_admin_test_rate_idx/i.test(statement)
  ));
  assert.notEqual(repairPosition, -1);
  assert.ok(repairPosition < createIndexPosition);

  const repair = statements[repairPosition];
  assert.match(repair, /NOT\s+i\.indisvalid/i);
  assert.match(repair, /DROP\s+INDEX\s+public\.notification_outbox_admin_test_rate_idx/i);
  assert.equal((repair.match(/DROP\s+INDEX/gi) || []).length, 1);
});
