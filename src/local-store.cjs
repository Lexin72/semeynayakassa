'use strict';

// The rows and the outbox are committed together. No network request is made
// while the persistence lock is held, so a slow server cannot block local writes.
const TABLES = ['members', 'categories', 'expenses', 'settings'];
const copy = value => JSON.parse(JSON.stringify(value));
const primaryKey = table => table === 'settings' ? 'key' : 'id';
const fields = {
  members:['id','name','color','animated_style','photo'], categories:['id','name','color'],
  expenses:['id','amount','category_id','member_id','note','date','created_at'], settings:['key','value']
};
const pickRow = (table, row) => row && Object.fromEntries(Object.entries(row).filter(([key]) => fields[table].includes(key)));
const sameValue = (a, b, key) => ['amount', 'created_at'].includes(key)
  ? Number(a) === Number(b) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const matches = (row, expected) => !!row && Object.keys(expected).every(key => sameValue(row[key], expected[key], key));
const error = message => Object.assign(new Error(message), {code:'LOCAL_STORE'});
const emptyState = () => ({version:1, tables:Object.fromEntries(TABLES.map(t => [t, []])), ready:{}, outbox:[], lastSync:null});

class LocalStore {
  constructor(storage, remote, {onStatus = () => {}, onData = () => {}, makeId = () => crypto.randomUUID()} = {}) {
    this.storage = storage;
    this.remote = remote;
    this.onStatus = onStatus;
    this.onData = onData;
    this.makeId = makeId;
    this.state = emptyState();
    this.tail = Promise.resolve();
    this.syncing = null;
    this.lastError = null;
  }

  async open() {
    const saved = await this.storage.load();
    if(saved !== null) {
      if(saved.version !== 1 || !Array.isArray(saved.outbox) || !saved.ready ||
        TABLES.some(t => !Array.isArray(saved.tables?.[t]))) throw error('Не удалось прочитать локальную базу. Данные не изменены.');
      this.state = saved;
    }
    this.notify();
    return this;
  }

  status() {
    return {pending:this.state.outbox.length, syncing:!!this.syncing, lastSync:this.state.lastSync,
      initialized:['members','categories','expenses'].every(t => this.state.ready[t]),
      error:this.lastError, conflict:this.state.outbox.find(op => op.conflict) || null};
  }
  notify() { this.onStatus(this.status()); }
  transaction(change) {
    const work = this.tail.then(async () => {
      const next = copy(this.state);
      const result = change(next);
      await this.storage.save(next);
      this.state = next;
      this.notify();
      return result;
    });
    this.tail = work.catch(() => {});
    return work;
  }
  rows(table) {
    if(!TABLES.includes(table)) throw error('Неизвестная таблица');
    if(!this.state.ready[table]) throw error('Для первой загрузки данных подключитесь к серверу.');
    return copy(this.state.tables[table]);
  }

  async mutate(table, kind, values, filters = []) {
    this.rows(table);
    const pk = primaryKey(table);
    return this.transaction(state => {
      const rows = state.tables[table];
      const selected = row => filters.every(([key, value]) => sameValue(row[key], value, key));
      const changes = [];
      const enqueue = (before, after) => {
        if(before && after && matches(before, after) && matches(after, before)) return;
        const key = (after || before)[pk];
        if(key === undefined || key === null || key === '') throw error('У записи отсутствует идентификатор');
        if(table === 'expenses' && after) {
          if(!Number.isFinite(Number(after.amount)) || Number(after.amount) <= 0) throw error('Некорректная сумма');
          if(!state.tables.members.some(row => row.id === after.member_id) ||
            !state.tables.categories.some(row => row.id === after.category_id)) throw error('Участник или категория отсутствует');
        }
        if(table === 'categories' && !after && state.tables.expenses.some(row => row.category_id === key)) {
          throw error('Категория используется в расходах');
        }
        state.outbox.push({id:this.makeId(), table, key, before:copy(before), after:copy(after)});
        changes.push(after || before);
      };
      if(kind === 'insert' || kind === 'upsert') {
        for(const value of Array.isArray(values) ? values : [values]) {
          const row = copy(value);
          const index = rows.findIndex(existing => sameValue(existing[pk], row[pk], pk));
          if(index >= 0 && kind === 'insert') throw error('Запись с таким идентификатором уже существует');
          const before = index < 0 ? null : rows[index];
          const after = {...before, ...row};
          enqueue(before, after);
          if(index < 0) rows.push(after); else rows[index] = after;
        }
      } else {
        if(!filters.length) throw error('Изменение без идентификатора запрещено');
        for(let i = rows.length - 1; i >= 0; i--) {
          if(!selected(rows[i])) continue;
          const before = rows[i], after = kind === 'delete' ? null : {...before, ...copy(values)};
          enqueue(before, after);
          if(after) rows[i] = after; else rows.splice(i, 1);
        }
        if(!changes.length && kind === 'update') throw error('Запись больше не существует');
      }
      return changes;
    });
  }

  async currentRemote(op) {
    const result = await this.remote.from(op.table).select('*').eq(primaryKey(op.table), op.key).maybeSingle();
    if(result.error) throw result.error;
    return pickRow(op.table, result.data);
  }

  async send(op) {
    const current = await this.currentRemote(op);
    // A reply can be lost after the server committed a write. Checking the
    // stable row ID and intended contents makes replay safe in that case.
    if((op.after && matches(current, op.after)) || (!op.after && !current)) return;
    if((!op.before && current) || (op.before && !matches(current, op.before))) {
      throw Object.assign(error('Эту запись изменили на другом устройстве.'), {conflict:true, remote:current});
    }
    let request;
    if(!op.before) request = this.remote.from(op.table).insert(op.after).select();
    else {
      const patch = op.after && Object.fromEntries(Object.entries(op.after)
        .filter(([key, value]) => !sameValue(value, op.before[key], key)));
      request = op.after ? this.remote.from(op.table).update(patch) : this.remote.from(op.table).delete();
      request = request.eq(primaryKey(op.table), op.key);
      // Compare-and-set protects expense edits/deletes against a concurrent
      // writer between GET and PATCH. Large profile photos are compared on GET
      // only; they cannot safely be placed in a PostgREST URL.
      for(const [key, value] of Object.entries(op.before)) {
        if(key === primaryKey(op.table) || typeof value === 'object' && value !== null) continue;
        if(String(value).length > 2048) {
          if(op.table === 'expenses') throw error('Слишком длинная запись для безопасной синхронизации. Сохраните резервную копию.');
          continue;
        }
        request = value === null ? request.is(key, null) : request.eq(key, value);
      }
      request = request.select();
    }
    const result = await request;
    if(result.error) throw result.error;
    if(!result.data?.length) throw Object.assign(error('Запись изменилась или нет разрешения на запись.'),
      {conflict:true, remote:await this.currentRemote(op)});
  }

  async pullTable(table) {
    const rows = [], pk = primaryKey(table);
    let cursor;
    for(;;) {
      let request = this.remote.from(table).select('*').order(pk).limit(1000);
      if(cursor !== undefined) request = request.gt(pk, cursor);
      const {data, error:failure} = await request;
      if(failure) throw failure;
      rows.push(...data.map(row => pickRow(table, row)));
      if(data.length < 1000) return rows;
      cursor = data.at(-1)[pk];
    }
  }

  sync() {
    if(this.syncing) return this.syncing;
    this.syncing = this.performSync().catch(failure => {
      this.lastError = failure.message || 'Нет связи с сервером';
    }).finally(() => { this.syncing = null; this.notify(); });
    this.notify();
    return this.syncing;
  }
  async performSync() {
    this.lastError = null;
    await this.tail;
    for(let count = 0; count < 100; count++) {
      const op = this.state.outbox[0];
      if(!op || op.conflict) break;
      try { await this.send(copy(op)); }
      catch(failure) {
        if(failure.conflict) {
          await this.transaction(state => {
            const pending = state.outbox.find(item => item.id === op.id);
            if(pending) pending.conflict = {remote:failure.remote, message:failure.message};
          });
        }
        throw failure;
      }
      await this.transaction(state => { state.outbox = state.outbox.filter(item => item.id !== op.id); });
    }
    const pulled = {};
    await Promise.all(TABLES.map(async table => {
      try { pulled[table] = await this.pullTable(table); }
      catch(failure) {
        // Some existing installations do not have the optional budget table.
        if(table !== 'settings' || !['PGRST205','42P01'].includes(failure.code)) throw failure;
      }
    }));
    const changed = await this.transaction(state => {
      const before = JSON.stringify([state.tables, state.ready]);
      for(const [table, rows] of Object.entries(pulled)) {
        const pk = primaryKey(table), merged = new Map(rows.map(row => [row[pk], row]));
        for(const op of state.outbox.filter(item => item.table === table)) {
          if(op.after) merged.set(op.key, op.after); else merged.delete(op.key);
        }
        state.tables[table] = [...merged.values()];
        state.ready[table] = true;
      }
      state.lastSync = new Date().toISOString();
      return before !== JSON.stringify([state.tables, state.ready]);
    });
    if(changed) this.onData();
  }

  async resolveConflict(choice) {
    if(!['local','remote'].includes(choice)) throw error('Неизвестный вариант');
    if(this.syncing) await this.syncing;
    const conflict = this.state.outbox.find(op => op.conflict);
    if(!conflict) return;
    // Refresh before the user's decision is committed; do not resolve using a
    // stale server value captured hours ago. A later race is checked on send.
    const remote = await this.currentRemote(conflict);
    await this.transaction(state => {
      const same = op => op.table === conflict.table && op.key === conflict.key;
      const related = state.outbox.filter(same), desired = related.at(-1).after;
      state.outbox = state.outbox.filter(op => !same(op));
      const pk = primaryKey(conflict.table), rows = state.tables[conflict.table];
      state.tables[conflict.table] = rows.filter(row => row[pk] !== conflict.key);
      const value = choice === 'local' ? desired : remote;
      if(value) state.tables[conflict.table].push(value);
      if(choice === 'local') state.outbox.unshift({id:this.makeId(), table:conflict.table, key:conflict.key, before:remote, after:desired});
      // Dependent operations are never silently discarded. A remote deletion
      // of a member/category will surface a server error on dependent writes.
    });
    this.onData();
    return this.sync();
  }
}

// Small compatibility layer for the existing UI; all reads are now local.
class LocalQuery {
  constructor(store, table, schedule) { Object.assign(this, {store, table, schedule, filters:[], orders:[], kind:'select', options:{}}); }
  select(columns = '*', options = {}) { this.columns = columns; this.options = options; return this; }
  insert(values) { this.kind = 'insert'; this.values = values; return this; }
  upsert(values) { this.kind = 'upsert'; this.values = values; return this; }
  update(values) { this.kind = 'update'; this.values = values; return this; }
  delete() { this.kind = 'delete'; return this; }
  eq(key, value) { this.filters.push([key, value, 'eq']); return this; }
  gte(key, value) { this.filters.push([key, value, 'gte']); return this; }
  lte(key, value) { this.filters.push([key, value, 'lte']); return this; }
  order(key) { this.orders.push(key); return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  then(resolve, reject) { this.promise ||= this.run(); return this.promise.then(resolve, reject); }
  async run() {
    try {
      if(this.kind !== 'select') {
        if(this.filters.some(filter => filter[2] !== 'eq')) throw error('Неподдерживаемый фильтр записи');
        const data = await this.store.mutate(this.table, this.kind, this.values, this.filters);
        this.schedule();
        return {data, error:null};
      }
      let rows = this.store.rows(this.table).filter(row => this.filters.every(([key, value, op]) =>
        op === 'gte' ? row[key] >= value : op === 'lte' ? row[key] <= value : sameValue(row[key], value, key)));
      const count = rows.length;
      rows.sort((a, b) => {
        for(const key of this.orders) { if(a[key] < b[key]) return -1; if(a[key] > b[key]) return 1; }
        return 0;
      });
      if(this.start !== undefined) rows = rows.slice(this.start, this.end + 1);
      return {data:this.options.head ? null : rows, count, error:null};
    } catch(failure) { return {data:null, error:failure}; }
  }
}

function createLocalClient(store, schedule) {
  return {from:table => new LocalQuery(store, table, schedule)};
}
module.exports = {LocalStore, createLocalClient, matches};
