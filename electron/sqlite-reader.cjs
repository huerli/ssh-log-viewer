const fs = require('node:fs/promises');
const { DatabaseSync } = require('node:sqlite');
async function isSqliteFile(file) {
  const handle = await fs.open(file, 'r');
  try { const head = Buffer.alloc(16); await handle.read(head, 0, 16, 0); return head.equals(Buffer.from('SQLite format 3\0')); }
  finally { await handle.close(); }
}
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function readSqlite(file, table, offset = 0, search = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000000) throw new Error('无效分页位置');
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 1000 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    const tables = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (table === undefined) return { tables };
    if (typeof table !== 'string' || !tables.some(item => item.name === table)) throw new Error('请选择数据库中的表或视图');
    const columns = db.prepare('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)').all(table);
    if (!search || typeof search !== 'object' || (search.query !== undefined && (typeof search.query !== 'string' || search.query.length > 2048))) throw new Error('搜索内容不得超过 2048 字符');
    const field = search.field || '';
    if (field && !columns.some(c => c.name === field)) throw new Error('无效搜索字段');
    const mode = search.mode || 'contains';
    if (!['contains', 'exact'].includes(mode)) throw new Error('无效搜索方式');
    const query = search.query || '';
    const fields = field ? columns.filter(c => c.name === field) : columns;
    const terms = query ? fields.map(c => {
      const name = quote(c.name);
      const value = `CASE WHEN typeof(${name}) = 'blob' THEN hex(${name}) ELSE CAST(${name} AS TEXT) END`;
      return mode === 'exact' ? `${value} = ? COLLATE NOCASE` : `instr(lower(${value}), lower(?)) > 0`;
    }) : [];
    const where = terms.length ? ` WHERE (${terms.join(' OR ')})` : '';
    const params = terms.map(() => query);
    const total = db.prepare(`SELECT count(*) AS total FROM ${quote(table)}${where}`).get(...params).total;
    const statement = db.prepare(`SELECT * FROM ${quote(table)}${where} LIMIT 101 OFFSET ?`);
    statement.setReadBigInts(true);
    const data = statement.all(...params, offset);
    const hasMore = data.length > 100;
    const rows = data.slice(0, 100).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      value === null ? null : value instanceof Uint8Array ? `BLOB (${value.length} B): ${Buffer.from(value.subarray(0, 256)).toString('hex')}${value.length > 256 ? '…' : ''}` : typeof value === 'bigint' ? value.toString() : typeof value === 'string' && value.length > 4096 ? value.slice(0, 4096) + '… [显示截断]' : value
    ])));
    return { tables, columns, rows, hasMore, offset, total };
  } finally { db.close(); }
}
module.exports = { isSqliteFile, readSqlite };
