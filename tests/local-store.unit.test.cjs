const {test} = require('node:test');
const assert = require('node:assert/strict');
const {LocalStore, createLocalClient} = require('../src/local-store.cjs');
const {createClient} = new Function(require('node:fs').readFileSync(require('node:path').join(__dirname,'../vendor/supabase-2.117.3.js'),'utf8') + ';return supabase;')();
const clone = value => JSON.parse(JSON.stringify(value));
const expense = (id, amount = 100, member = 'm1') => ({id, amount, member_id:member, category_id:'c1', note:'Магазин', date:'2026-10-09', created_at:1791547200000});
function setupRemote() {
  const api = {rows:{members:[{id:'m1',name:'Аня'},{id:'m2',name:'Саша'}], categories:[{id:'c1',name:'Продукты'}],
    expenses:[expense('e1')], settings:[{key:'monthly_budget',value:'5000'}]}, writes:[], mode:'ok', after:null, before:null};
  const fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.origin, 'https://example.test');
    const table = url.pathname.split('/').at(-1), method = options.method || 'GET';
    if(api.mode === 'offline') throw new TypeError('Network unavailable');
    if(api.before) await api.before({table, method, url});
    if(!api.rows[table]) return Response.json({code:'PGRST205',message:'Table missing'}, {status:404});
    const selected = row => [...url.searchParams].every(([key, filter]) => {
      if(['select','order','limit','offset','on_conflict'].includes(key)) return true;
      const dot = filter.indexOf('.'), op = filter.slice(0,dot), value = filter.slice(dot+1);
      if(op === 'gt') return row[key] > value;
      if(op === 'is') return row[key] === null || row[key] === undefined;
      assert.equal(op,'eq'); return String(row[key]) === value;
    });
    let result;
    if(method === 'GET') {
      result = api.rows[table].filter(selected).map(clone);
      const key = url.searchParams.get('order')?.split('.')[0];
      if(key) result.sort((a,b) => String(a[key]).localeCompare(String(b[key])));
      result = result.slice(0,Number(url.searchParams.get('limit') || result.length));
    } else {
      api.writes.push({table,method});
      if(api.mode === 'denied') return Response.json({code:'42501',message:'permission denied'}, {status:403});
      const body = options.body && JSON.parse(options.body);
      if(method === 'POST') {
        const pk = table === 'settings' ? 'key' : 'id';
        if(api.rows[table].some(row => row[pk] === body[pk])) return Response.json({code:'23505',message:'duplicate'}, {status:409});
        api.rows[table].push(clone(body)); result = [body];
      } else {
        result = api.rows[table].filter(selected);
        if(method === 'PATCH') result.forEach(row => Object.assign(row,body));
        else if(method === 'DELETE') api.rows[table] = api.rows[table].filter(row => !selected(row));
        else throw new Error('Unexpected method '+method);
      }
    }
    if(api.after) await api.after({table, method, url});
    return Response.json(result);
  };
  api.client = createClient('https://example.test','public-test-key',{global:{fetch},auth:{persistSession:false,autoRefreshToken:false}});
  return api;
}
function memory() {
  return {saved:null, fail:false, async load(){return clone(this.saved);}, async save(value){
    if(this.fail) throw new Error('Disk full'); this.saved = clone(value);
  }};
}
async function device(api, storage = memory()) {
  const store = await new LocalStore(storage,api.client).open();
  const client = createLocalClient(store, () => {});
  return {store, client, storage};
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

test('all family expenses are shared between two devices after offline additions', async () => {
  const api = setupRemote(), a = await device(api), b = await device(api);
  await a.store.sync(); await b.store.sync(); api.mode = 'offline';
  assert.equal((await a.client.from('expenses').insert(expense('a',150,'m1'))).error,null);
  assert.equal((await b.client.from('expenses').insert(expense('b',250,'m2'))).error,null);
  assert.equal(a.store.status().pending,1); assert.equal(b.store.status().pending,1);
  api.mode = 'ok'; await a.store.sync(); await b.store.sync(); await a.store.sync();
  for(const {client,store} of [a,b]) {
    const {data} = await client.from('expenses').select('*');
    assert.equal(data.reduce((sum,row) => sum+row.amount,0),500);
    assert.equal((await client.from('expenses').select('*').eq('member_id','m2')).data.length,1);
    assert.equal(store.status().pending,0);
  }
});

test('offline edits and deletes survive process restart with their outbox', async () => {
  const api = setupRemote(), a = await device(api); await a.store.sync(); api.mode = 'offline';
  await a.client.from('expenses').update({amount:275}).eq('id','e1');
  const b = await device(api,a.storage);
  assert.equal(b.store.rows('expenses')[0].amount,275); assert.equal(b.store.status().pending,1);
  await b.client.from('expenses').delete().eq('id','e1');
  const c = await device(api,a.storage); assert.equal(c.store.rows('expenses').length,0);
  api.mode = 'ok'; await c.store.sync(); assert.equal(c.store.status().pending,0); assert.equal(api.rows.expenses.length,0);
});

test('lost insert response is retried without duplicating a family expense', async () => {
  const api = setupRemote(), a = await device(api); await a.store.sync();
  await a.client.from('expenses').insert(expense('new',333));
  api.after = ({method}) => { if(method === 'POST') throw new TypeError('Reply lost after commit'); };
  await a.store.sync(); assert.equal(a.store.status().pending,1); assert.equal(api.rows.expenses.length,2);
  api.after = null; const restarted = await device(api,a.storage); await restarted.store.sync();
  assert.equal(restarted.store.status().pending,0); assert.equal(api.rows.expenses.length,2);
  assert.equal(api.writes.filter(w => w.method === 'POST').length,1);
});

test('local saving remains responsive while an upload hangs; later edits are preserved', async () => {
  const api = setupRemote(), a = await device(api); await a.store.sync();
  await a.client.from('expenses').update({amount:200}).eq('id','e1');
  const started = deferred(), release = deferred();
  api.before = async ({method}) => { if(method === 'PATCH'){ started.resolve(); await release.promise; } };
  const sync = a.store.sync(); await started.promise;
  const result = await a.client.from('expenses').update({amount:300}).eq('id','e1');
  assert.equal(result.error,null); assert.equal(a.store.rows('expenses')[0].amount,300);
  release.resolve(); await sync;
  assert.equal(api.rows.expenses[0].amount,300); assert.equal(a.store.status().pending,0);
});

test('concurrent edits produce a durable conflict instead of overwriting another member', async () => {
  const api = setupRemote(), a = await device(api), b = await device(api);
  await a.store.sync(); await b.store.sync();
  await a.client.from('expenses').update({amount:200}).eq('id','e1');
  await b.client.from('expenses').update({amount:300}).eq('id','e1');
  await a.store.sync(); await b.store.sync();
  assert.equal(api.rows.expenses[0].amount,200); assert.ok(b.store.status().conflict);
  const restarted = await device(api,b.storage); assert.ok(restarted.store.status().conflict);
  await restarted.store.resolveConflict('remote');
  assert.equal(restarted.store.rows('expenses')[0].amount,200); assert.equal(restarted.store.status().pending,0);
});

test('explicitly choosing the phone version resolves a conflict and syncs later edits', async () => {
  const api = setupRemote(), a = await device(api); await a.store.sync();
  await a.client.from('expenses').update({amount:200}).eq('id','e1'); api.rows.expenses[0].amount = 500;
  await a.store.sync(); await a.client.from('expenses').update({amount:300}).eq('id','e1');
  await a.store.resolveConflict('local');
  assert.equal(api.rows.expenses[0].amount,300); assert.equal(a.store.status().pending,0);
});

test('compare-and-set catches an edit occurring between remote GET and PATCH', async () => {
  const api = setupRemote(), a = await device(api); await a.store.sync();
  await a.client.from('expenses').update({amount:200}).eq('id','e1');
  api.before = ({method}) => { if(method === 'PATCH') api.rows.expenses[0].amount = 999; };
  await a.store.sync(); assert.equal(api.rows.expenses[0].amount,999); assert.ok(a.store.status().conflict);
});

test('a failed SQLite commit never reports local success or loses the previous state', async () => {
  const api = setupRemote(), a = await device(api); await a.store.sync(); a.storage.fail = true;
  const result = await a.client.from('expenses').insert(expense('new'));
  assert.match(result.error.message,/Disk full/); assert.equal(a.store.status().pending,0);
  assert.equal(a.store.rows('expenses').length,1); assert.equal(a.storage.saved.tables.expenses.length,1);
});

test('server rejection preserves the queue and local family totals', async () => {
  const api = setupRemote(), a = await device(api); await a.store.sync();
  await a.client.from('expenses').insert(expense('new',400)); api.mode = 'denied'; await a.store.sync();
  assert.equal(a.store.status().pending,1); assert.equal(a.store.rows('expenses').length,2);
  api.mode = 'ok'; await a.store.sync(); assert.equal(a.store.status().pending,0);
});

test('initial offline startup does not invent an empty family or allow unsafely unbased writes', async () => {
  const api = setupRemote(), a = await device(api); api.mode = 'offline'; await a.store.sync();
  assert.equal(a.store.status().initialized,false);
  assert.ok((await a.client.from('members').select('*')).error);
  assert.ok((await a.client.from('members').insert({id:'x',name:'New'})).error);
  assert.equal(a.store.status().pending,0);
});

test('a local write made during a full pull is not overwritten by the remote snapshot', async () => {
  const api = setupRemote(), a = await device(api); await a.store.sync();
  const started = deferred(), release = deferred();
  api.after = async ({table,method,url}) => {
    if(table === 'expenses' && method === 'GET' && !url.searchParams.has('id')) { started.resolve(); await release.promise; }
  };
  const sync = a.store.sync(); await started.promise;
  await a.client.from('expenses').insert(expense('new')); release.resolve(); await sync;
  assert.equal(a.store.rows('expenses').length,2); assert.equal(a.store.status().pending,1);
  api.after = null; await a.store.sync(); assert.equal(api.rows.expenses.length,2);
});

test('full family import paginates beyond 1000 records and tolerates a missing budget table', async () => {
  const api = setupRemote(); api.rows.expenses = Array.from({length:1005},(_,i) => expense('e'+String(i).padStart(5,'0')));
  delete api.rows.settings; const a = await device(api); await a.store.sync();
  assert.equal(a.store.rows('expenses').length,1005); assert.equal(a.store.status().initialized,true);
  assert.ok((await a.client.from('settings').upsert({key:'monthly_budget',value:'500'})).error);
});

test('server-generated columns cannot create false replay conflicts after a lost reply', async () => {
  const api = setupRemote(); api.rows.expenses[0].updated_at = 'old'; const a = await device(api); await a.store.sync();
  await a.client.from('expenses').update({amount:555}).eq('id','e1');
  api.after = ({method}) => { if(method === 'PATCH') { api.rows.expenses[0].updated_at = 'new'; throw new TypeError('Reply lost'); } };
  await a.store.sync(); api.after = null; await a.store.sync();
  assert.equal(a.store.status().pending,0); assert.equal(api.rows.expenses[0].amount,555);
});
