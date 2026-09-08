// A stand-in for @/lib/supabase that answers from in-memory fixtures.
//
// It exists so the attendance read can be tested without a database and,
// specifically, without the hosted project. It emulates only the slice of the
// PostgREST query builder the api modules actually use: eq / neq / gte / lte /
// in / is / order / range, embedded selects, and !inner filtering on an
// embedded resource.
//
// Filters on a dotted path ("class_sessions.session_date") are applied to the
// embedded row, and with !inner a parent whose embed is filtered out drops from
// the result — which is the behaviour attendanceLog relies on.

let tables = {};

export const __setTables = (next) => {
  tables = next;
};

/** Every request this run made, so a test can assert on pagination. */
export const __requests = [];

const CMP = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gte: (a, b) => a >= b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  lt: (a, b) => a < b,
};

/** "id, name, cohorts(label)" -> { columns: [...], embeds: {cohorts: [...]} } */
const parseSelect = (select) => {
  const columns = [];
  const embeds = {};
  let depth = 0;
  let token = "";
  const flush = () => {
    const t = token.trim();
    token = "";
    if (!t) return;
    const m = t.match(/^([A-Za-z0-9_]+)(!inner)?\((.*)\)$/s);
    if (m) embeds[m[1]] = { inner: Boolean(m[2]), select: m[3] };
    else columns.push(t);
  };
  for (const ch of select) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) flush();
    else token += ch;
  }
  flush();
  return { columns, embeds };
};

// How an embedded table is reached from its parent. Kept explicit rather than
// guessed: the fixtures are small and a wrong guess would make a test pass for
// the wrong reason.
const RELATIONS = {
  class_sessions: {
    cohorts: { localKey: "cohort_id", foreignKey: "id", table: "cohorts", many: false },
  },
  attendance_records: {
    class_sessions: {
      localKey: "session_id",
      foreignKey: "id",
      table: "class_sessions",
      many: false,
    },
  },
  enrolments: {
    cohorts: { localKey: "cohort_id", foreignKey: "id", table: "cohorts", many: false },
    students: {
      localKey: "student_id",
      foreignKey: "student_id",
      table: "students",
      many: false,
    },
  },
  classes: {
    cohorts: { localKey: "id", foreignKey: "class_id", table: "cohorts", many: true },
  },
};

const project = (row, select, tableName) => {
  const { columns, embeds } = parseSelect(select);
  const out = {};
  if (columns.includes("*")) Object.assign(out, row);
  else columns.forEach((c) => (out[c] = row[c]));

  for (const [name, spec] of Object.entries(embeds)) {
    const rel = RELATIONS[tableName]?.[name];
    if (!rel) throw new Error(`stub: no relation ${tableName} -> ${name}`);
    const matches = (tables[rel.table] ?? []).filter(
      (r) => r[rel.foreignKey] === row[rel.localKey],
    );
    out[name] = rel.many
      ? matches.map((m) => project(m, spec.select, rel.table))
      : matches.length
        ? project(matches[0], spec.select, rel.table)
        : null;
  }
  return out;
};

class Query {
  constructor(table) {
    this.table = table;
    this.select_ = "*";
    this.filters = [];
    this.orders = [];
    this.range_ = null;
    this.single_ = null;
  }

  select(s) {
    this.select_ = s ?? "*";
    return this;
  }

  order(col, opts) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }

  range(from, to) {
    this.range_ = [from, to];
    return this;
  }

  maybeSingle() {
    this.single_ = "maybe";
    return this;
  }

  single() {
    this.single_ = "one";
    return this;
  }

  is(col, val) {
    this.filters.push({ col, op: "is", val });
    return this;
  }

  in(col, vals) {
    this.filters.push({ col, op: "in", val: vals });
    return this;
  }

  run() {
    __requests.push({
      table: this.table,
      select: this.select_,
      filters: this.filters.map((f) => `${f.col}.${f.op}.${JSON.stringify(f.val)}`),
      range: this.range_,
    });

    const { embeds } = parseSelect(this.select_);

    // Filtering and ordering happen on the underlying row plus its resolved
    // embeds, never on the projection: PostgREST lets you filter and order by a
    // column you did not select, and attendanceLog does exactly that.
    let rows = (tables[this.table] ?? []).map((raw) => {
      const resolved = { ...raw };
      for (const [name, spec] of Object.entries(embeds)) {
        const rel = RELATIONS[this.table]?.[name];
        if (!rel) throw new Error(`stub: no relation ${this.table} -> ${name}`);
        const matches = (tables[rel.table] ?? []).filter(
          (r) => r[rel.foreignKey] === raw[rel.localKey],
        );
        resolved[name] = rel.many
          ? matches.map((m) => project(m, spec.select, rel.table))
          : matches.length
            ? project(matches[0], spec.select, rel.table)
            : null;
      }
      return { raw, resolved };
    });

    for (const f of this.filters) {
      const [head, ...rest] = f.col.split(".");
      const path = rest.length > 0 ? rest.join(".") : null;

      rows = rows.filter(({ resolved }) => {
        // A dotted column addresses the embedded row, as PostgREST does.
        const target = path ? resolved[head] : resolved;
        if (path && target == null) return false;
        const value = target[path ?? head];

        if (f.op === "is") return f.val === null ? value == null : value === f.val;
        if (f.op === "in") return f.val.includes(value);
        return CMP[f.op](value, f.val);
      });
    }

    // !inner: a parent whose embedded row is absent drops out entirely.
    for (const [name, spec] of Object.entries(embeds)) {
      if (spec.inner) rows = rows.filter(({ resolved }) => resolved[name] !== null);
    }

    for (const o of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const x = a.resolved[o.col];
        const y = b.resolved[o.col];
        const c = x < y ? -1 : x > y ? 1 : 0;
        return o.asc ? c : -c;
      });
    }

    if (this.range_) rows = rows.slice(this.range_[0], this.range_[1] + 1);

    const projected = rows.map(({ raw }) => project(raw, this.select_, this.table));

    if (this.single_) {
      if (projected.length === 0) {
        return this.single_ === "maybe"
          ? { data: null, error: null }
          : { data: null, error: { message: "no rows" } };
      }
      return { data: projected[0], error: null };
    }
    return { data: projected, error: null };
  }

  then(resolve, reject) {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
}

for (const op of ["eq", "neq", "gte", "lte", "gt", "lt"]) {
  Query.prototype[op] = function (col, val) {
    this.filters.push({ col, op, val });
    return this;
  };
}

export const supabase = {
  from: (table) => new Query(table),
  rpc: async () => ({ data: null, error: { message: "stub: rpc not configured" } }),
};
