/**
 * In-memory stand-in for the subset of the Supabase query builder used by the cron
 * helpers and the worker: select/update/insert/upsert with eq/in/gte/lt/is/order/limit and
 * maybeSingle(), awaited directly or via `.select()`. Embedded relations are stored on the
 * row itself (e.g. `podcast_subscriptions: { title, user_id }`).
 *
 * `hooks.beforeUpdate(data, table, patch)` lets a test simulate a concurrent writer between
 * a read and the compare-and-swap write.
 */
export function makeFakeSupabase(tables, hooks = {}) {
  const data = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))])
  )
  const writes = []

  function builder(table, kind, payload, options = {}) {
    const filters = []
    let order = null
    let limit = Infinity
    let single = false

    const run = () => {
      data[table] ??= []
      const rows = data[table]

      if (kind === 'insert' || kind === 'upsert') {
        const inserted = []
        const conflictColumns = options.onConflict ? options.onConflict.split(',').map((c) => c.trim()) : []
        for (const record of [].concat(payload)) {
          const existing = conflictColumns.length
            ? rows.find((row) => conflictColumns.every((c) => row[c] === record[c]))
            : null
          if (existing && kind === 'upsert' && options.ignoreDuplicates) {
            continue
          } else if (existing && kind === 'upsert') {
            Object.assign(existing, record)
            inserted.push(existing)
          } else if (existing) {
            return { data: null, error: { message: `duplicate key value violates unique constraint (${options.onConflict})` } }
          } else {
            const row = { id: record.id ?? `${table}-${rows.length + 1}`, ...record }
            rows.push(row)
            inserted.push(row)
          }
        }
        writes.push({ table, kind, payload })
        return { data: inserted.map((row) => ({ id: row.id })), error: null }
      }

      if (kind === 'update' && hooks.beforeUpdate) hooks.beforeUpdate(data, table, payload)
      let matched = rows.filter((row) => filters.every((matches) => matches(row)))

      if (kind === 'update') {
        for (const row of matched) Object.assign(row, payload)
        writes.push({ table, kind, payload, ids: matched.map((row) => row.id) })
        return { data: matched.map((row) => ({ id: row.id })), error: null }
      }

      if (order) {
        matched = [...matched].sort((a, b) => {
          const cmp = String(a[order.column]).localeCompare(String(b[order.column]))
          return order.ascending ? cmp : -cmp
        })
      }
      const result = matched.slice(0, limit).map((row) => ({ ...row }))
      if (single) return { data: result[0] ?? null, error: null }
      return { data: result, error: null }
    }

    const b = {
      eq(column, value) { filters.push((row) => row[column] === value); return b },
      in(column, values) { filters.push((row) => values.includes(row[column])); return b },
      gte(column, value) { filters.push((row) => row[column] >= value); return b },
      lt(column, value) { filters.push((row) => row[column] != null && row[column] < value); return b },
      is(column, value) { filters.push((row) => (row[column] ?? null) === value); return b },
      order(column, { ascending = true } = {}) { order = { column, ascending }; return b },
      limit(n) { limit = n; return b },
      maybeSingle() { single = true; return Promise.resolve(run()) },
      single() { single = true; return Promise.resolve(run()) },
      select() { return Promise.resolve(run()) },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
    }
    return b
  }

  return {
    data,
    writes,
    from(table) {
      return {
        select: () => builder(table, 'select'),
        update: (patch) => builder(table, 'update', patch),
        insert: (record) => builder(table, 'insert', record),
        upsert: (record, options) => builder(table, 'upsert', record, options),
      }
    },
  }
}
