const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM,VirtualConsole} = require('jsdom');
const FakeTimers = require('@sinonjs/fake-timers');
const {LocalStore,createLocalClient} = require('../src/local-store.cjs');
const root = path.resolve(__dirname,'..');
const now = Date.UTC(2026,9,9,12);
const fixture = {version:1,ready:{members:true,categories:true,expenses:true,settings:true},outbox:[],lastSync:null,tables:{
  members:[{id:'m1',name:'Аня',color:'#7C9473'},{id:'m2',name:'Саша',color:'#5B7FA6'}],
  categories:[{id:'c1',name:'Продукты',color:'#7C9473'}],settings:[{key:'monthly_budget',value:'5000'}],
  expenses:[{id:'e1',amount:100,member_id:'m1',category_id:'c1',date:'2026-10-09',note:'Покупка',created_at:now},
    {id:'e2',amount:200,member_id:'m2',category_id:'c1',date:'2026-10-09',note:'Покупка',created_at:now}]
}};
const flush = async () => { for(let i=0;i<10;i++) await new Promise(r => setImmediate(r)); };
async function setup(t) {
  const storage = {value:structuredClone(fixture),fail:false,async load(){return structuredClone(this.value);},
    async save(value){ if(this.fail) throw new Error('Disk full'); this.value = structuredClone(value); }};
  const store = await new LocalStore(storage,null).open();
  const source = fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<style>[\s\S]*?<\/style>/,'')
    .replace('<script defer src="vendor/supabase-2.117.3.js"></script>', () => '<script>'+fs.readFileSync(path.join(root,'vendor/supabase-2.117.3.js'),'utf8')+'</script>');
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e.message));
  let clock, starts = 0;
  const dom = new JSDOM(source,{url:'https://localhost/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole,
    beforeParse(w){
      clock = FakeTimers.withGlobal(w).install({now,toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame','performance']});
      Object.assign(w,{Request,Response,Headers,TextEncoder,TextDecoder});
      Object.defineProperty(w.navigator,'onLine',{value:false});
      w.fetch = () => { throw new Error('Android UI must read the local database'); };
      w.localStorage.setItem('family-cash-member-id','m1');
      w.FamilyCashNative = {createClient:async () => createLocalClient(store, () => {}),
        start:() => { starts++; },status:() => store.status(),sync:() => {}};
    }});
  t.after(() => { clock.uninstall(); dom.window.close(); assert.deepEqual(errors,[]); });
  await flush(); assert.equal(starts,1);
  return {w:dom.window,doc:dom.window.document,store,storage,clock};
}
function click(doc,selector){ const element=doc.querySelector(selector); assert.ok(element,selector); element.click(); }

test('Android UI opens offline, shows all members, and immediately includes an offline expense in totals', async t => {
  const {doc,store,storage} = await setup(t);
  assert.match(doc.querySelector('#top5-list').textContent,/300/);
  click(doc,'[data-filter-member="m2"]'); await flush(); assert.match(doc.querySelector('#top5-list').textContent,/200/);
  click(doc,'[data-filter-member="all"]'); await flush();
  click(doc,'#fab-add'); doc.querySelector('#exp-amount').value='50'; click(doc,'#exp-save'); await flush();
  assert.equal(doc.querySelector('#exp-save'),null); assert.equal(store.status().pending,1);
  assert.equal(storage.value.tables.expenses.length,3); assert.match(doc.querySelector('#top5-list').textContent,/350/);
  click(doc,'[data-filter-member="m1"]'); await flush(); assert.match(doc.querySelector('#top5-list').textContent,/150/);
});

test('Android UI can edit and delete offline without losing the durable queue', async t => {
  const {doc,store,storage} = await setup(t);
  click(doc,'.receipt'); doc.querySelector('#exp-amount').value='90'; click(doc,'#exp-save'); await flush();
  assert.equal(store.status().pending,1); assert.equal(doc.querySelector('#exp-save'),null);
  click(doc,'.receipt'); click(doc,'#exp-delete'); click(doc,'#del-confirm'); await flush();
  assert.equal(store.status().pending,2); assert.equal(storage.value.tables.expenses.length,1);
  assert.equal(doc.querySelector('#del-confirm'),null);
});

test('Android UI retains the form when durable storage rejects a write', async t => {
  const {doc,store,storage} = await setup(t); storage.fail=true;
  click(doc,'#fab-add'); doc.querySelector('#exp-amount').value='50'; click(doc,'#exp-save'); await flush();
  assert.ok(doc.querySelector('#exp-save')); assert.equal(store.status().pending,0);
  assert.match(doc.querySelector('#toast').textContent,/Не удалось сохранить/);
  assert.match(doc.querySelector('#top5-list').textContent,/300/);
});

test('a family sync event refreshes visible totals and names from the native database', async t => {
  const {doc,w,store} = await setup(t);
  await store.transaction(state => {
    state.tables.expenses[0].amount=400;
    state.tables.members[1].name='Александр';
  });
  w.dispatchEvent(new w.Event('family-cash:data')); await flush();
  assert.match(doc.querySelector('#top5-list').textContent,/600/);
  assert.match(doc.querySelector('[data-filter-member="m2"]').textContent,/Александр/);
});
