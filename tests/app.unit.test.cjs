const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM, VirtualConsole} = require('jsdom');
const FakeTimers = require('@sinonjs/fake-timers');

const root = path.resolve(__dirname,'..');
const origin = 'https://example.test/semeynayakassa/';
const backend = 'https://cjitxdvgmilxmdwdygha.supabase.co';
const prefix = 'family-cash-cache-v1:' + backend + ':';
const now = Date.UTC(2026,9,9,12);
const members = [{id:'m1',name:'Аня',color:'#7C9473'},{id:'m2',name:'Саша',color:'#5B7FA6'}];
const categories = [{id:'c1',name:'Продукты',color:'#7C9473'}];
const defaults = [row('e1',123), row('e2',77,'m2')];
function row(id,amount,member='m1',date='2026-10-09'){
  return {id,amount,category_id:'c1',member_id:member,note:'Покупка',date,created_at:now};
}
function cached(rows){
  return rows.map(r => ({id:r.id,amount:r.amount,categoryId:r.category_id,memberId:r.member_id,note:r.note,date:r.date,createdAt:r.created_at}));
}
async function flush(){ for(let i=0;i<10;i++) await new Promise(resolve => setImmediate(resolve)); }
async function setup(t, options={}){
  const sdk = await fs.readFile(path.join(root,'vendor/supabase-2.117.3.js'),'utf8');
  const source = (await fs.readFile(path.join(root,'index.html'),'utf8'))
    .replace(/<style>[\s\S]*?<\/style>/,'')
    .replace('<script defer src="vendor/supabase-2.117.3.js"></script>',() => '<script>'+sdk.replace(/<\/script/gi,'<\\/script')+'</script>');
  const config = {mode:'ok', expenses:[...defaults], ...options.api};
  const calls = [], errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  let clock;
  const dom = new JSDOM(source,{url:origin,runScripts:'dangerously',
    pretendToBeVisual:true,virtualConsole,beforeParse(w){
      clock = FakeTimers.withGlobal(w).install({now,toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame','performance']});
      Object.assign(w,{Request,Response,Headers,TextEncoder,TextDecoder,ReadableStream});
      w.WebSocket = class {
        static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
        readyState=0; addEventListener(){} removeEventListener(){} send(){} close(){this.readyState=3;}
      };
      w.fetch = async (input,options={}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        assert.equal(url.origin,backend,'tests must never contact a real backend');
        const table = url.pathname.split('/').at(-1), method = options.method || 'GET';
        calls.push({url,table,method});
        if(config.mode === 'hang') return new Promise((resolve,reject) => {
          options.signal.addEventListener('abort',() => reject(new DOMException('Aborted','AbortError')),{once:true});
        });
        if(config.mode === 'body-hang'){
          const stream = new ReadableStream({start(controller){
            options.signal.addEventListener('abort',() => controller.error(new DOMException('Aborted','AbortError')),{once:true});
          }});
          return new Response(stream,{status:200,headers:{'content-type':'application/json'}});
        }
        if(config.mode === 'fail' || (config.failWrites && method !== 'GET' && method !== 'HEAD')){
          return Response.json({message:'Unavailable'},{status:503});
        }
        let rows = table === 'members' ? members : table === 'categories' ? categories
          : table === 'settings' ? [{key:'monthly_budget',value:'5000'}] : config.expenses;
        if(table === 'expenses'){
          for(const filter of url.searchParams.getAll('date')){
            if(filter.startsWith('gte.')) rows = rows.filter(r => r.date >= filter.slice(4));
            if(filter.startsWith('lte.')) rows = rows.filter(r => r.date <= filter.slice(4));
          }
          rows = [...rows].sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
          const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 1000);
          rows = rows.slice(offset,offset+limit);
        }
        const snapshot = JSON.stringify(rows);
        if(config.delay) await config.delay(table,url,method);
        if(method !== 'GET' && method !== 'HEAD') return new Response(null,{status:204});
        return new Response(snapshot,{status:200,headers:{'content-type':'application/json'}});
      };
      if(options.member !== false) w.localStorage.setItem('family-cash-member-id','m1');
      if(options.seed) for(const [key,value] of Object.entries(options.seed)) w.localStorage.setItem(prefix+key,JSON.stringify(value));
      if(options.noStorage) Object.defineProperty(w,'localStorage',{get(){throw new DOMException('Unavailable','SecurityError');}});
    }});
  t.after(() => { clock.uninstall(); dom.window.close(); assert.deepEqual(errors,[]); });
  await new Promise(resolve => dom.window.addEventListener('DOMContentLoaded',resolve,{once:true}));
  await flush();
  return {w:dom.window,doc:dom.window.document,clock,calls,config};
}
function click(doc,selector){
  const element = doc.querySelector(selector);
  assert.ok(element,'Missing UI element: '+selector);
  element.click();
}

test('saved expenses render before stalled API requests and remain after timeout', async t => {
  const {doc,clock,calls} = await setup(t,{api:{mode:'hang'},seed:{members,categories,budget:5000,
    expenses:{'2026-10-01:2026-10-31':{savedAt:now-60000,rows:cached(defaults)}}}});
  assert.match(doc.querySelector('#top5-list').textContent,/200/);
  assert.ok(doc.querySelector('.receipt'));
  assert.equal(calls.length,4,'reference reads and month read proceed in the background');
  await clock.tickAsync(12100); await flush();
  assert.ok(doc.querySelector('#offline-banner.show'));
  assert.match(doc.querySelector('#top5-list').textContent,/200/);
});

test('cold startup with an unavailable database exposes retry and prevents fake onboarding', async t => {
  const {doc,clock} = await setup(t,{member:false,api:{mode:'hang'}});
  assert.match(doc.querySelector('#app').textContent,/Загружаем участников/);
  await clock.tickAsync(12100); await flush();
  assert.ok(doc.querySelector('#retry-startup'));
  assert.equal(doc.querySelector('#add-member-btn'),null);
});

test('timeout also covers a response whose headers arrive but body never finishes', async t => {
  const {doc,clock} = await setup(t,{member:false,api:{mode:'body-hang'}});
  await clock.tickAsync(12100); await flush();
  assert.ok(doc.querySelector('#retry-startup'));
  assert.ok(doc.querySelector('#offline-banner.show'));
});

test('member filters reuse the same range and update totals without extra requests', async t => {
  const {doc,calls} = await setup(t);
  assert.match(doc.querySelector('#top5-list').textContent,/200/);
  assert.equal(calls.filter(c => c.table === 'expenses').length,1);
  click(doc,'[data-filter-member="m1"]'); await flush();
  assert.match(doc.querySelector('#top5-list').textContent,/123/);
  click(doc,'[data-filter-member="m2"]'); await flush();
  assert.match(doc.querySelector('#top5-list').textContent,/77/);
  assert.equal(calls.filter(c => c.table === 'expenses').length,1);
});

test('delayed response for an old month cannot overwrite the currently selected month', async t => {
  let release;
  const gate = new Promise(resolve => { release=resolve; });
  const {doc} = await setup(t,{api:{expenses:[...defaults,row('old',111,'m1','2026-09-09'),row('selected',222,'m1','2026-08-09')],
    delay:async (table,url) => {if(table === 'expenses' && url.searchParams.getAll('date').includes('gte.2026-09-01')) await gate;}}});
  click(doc,'#prev-month'); await flush();
  click(doc,'#prev-month'); await flush();
  assert.match(doc.querySelector('#top5-list').textContent,/222/);
  release(); await flush();
  assert.match(doc.querySelector('#top5-list').textContent,/222/);
});

test('pagination includes more than 1000 expenses and analytics uses one shared range', async t => {
  const expenses = Array.from({length:1005},(_,i) => row(String(i).padStart(4,'0'),1));
  const {doc,calls,clock} = await setup(t,{api:{expenses}});
  assert.match(doc.querySelector('#top5-list').textContent.replace(/\s/g,''),/1005/);
  const beforeCount = calls.filter(c => c.table === 'expenses').length;
  assert.equal(beforeCount,2);
  click(doc,'[data-page="analytics"]'); await flush();
  const analyticsCalls = calls.filter(c => c.table === 'expenses').slice(beforeCount);
  assert.equal(analyticsCalls.length,2);
  assert.equal(new Set(analyticsCalls.map(c => c.url.searchParams.getAll('date').join('|'))).size,1);
  await clock.tickAsync(900); await flush();
  assert.match(doc.querySelector('.compare-metric-value').textContent.replace(/\s/g,''),/1005/);
});

test('failed deletion retains the confirmation and never announces success', async t => {
  const {doc,config,calls} = await setup(t);
  config.failWrites=true;
  click(doc,'.receipt'); click(doc,'#exp-delete'); click(doc,'#del-confirm'); await flush();
  assert.match(doc.querySelector('#toast').textContent,/Не удалось удалить/);
  assert.ok(doc.querySelector('#del-confirm'));
  assert.equal(doc.querySelector('#del-confirm').disabled,false);
  assert.equal(calls.filter(c => c.method === 'DELETE').length,1);
});

test('a successful write invalidates cached totals and handles an empty 204 response', async t => {
  const {doc,config,calls} = await setup(t);
  const beforeCount = calls.filter(c => c.table === 'expenses').length;
  click(doc,'.receipt'); click(doc,'#exp-delete');
  config.expenses=[];
  click(doc,'#del-confirm'); await flush();
  assert.equal(doc.querySelector('#del-confirm'),null);
  assert.match(doc.querySelector('#top5-list').textContent,/Нет трат/);
  assert.equal(calls.filter(c => c.table === 'expenses').length,beforeCount+2,'one write and one fresh read');
});

test('private mode storage failure does not prevent selecting a member or displaying data', async t => {
  const {doc} = await setup(t,{member:false,noStorage:true});
  click(doc,'[data-select-member="m1"]'); await flush();
  assert.match(doc.querySelector('#top5-list').textContent,/200/);
});

test('service worker returns cached navigation before a stalled network and excludes API responses', async () => {
  const handlers={}, stores=new Map(), pending=[], timers=new Map();
  let timerId=0;
  const key = value => new URL(typeof value === 'string' ? value : value.url,origin).href;
  const caches = {
    async open(name){
      if(!stores.has(name)) stores.set(name,new Map());
      const store=stores.get(name);
      return {async match(request){return store.get(key(request))?.clone();},
        async put(request,response){store.set(key(request),response.clone());},
        async addAll(assets){for(const asset of assets){await fs.access(path.join(root,asset === './' ? 'index.html' : asset)); store.set(key(asset),new Response('cached'));}}};
    },
    async keys(){return [...stores.keys()];},
    async delete(name){return stores.delete(name);},
  };
  await caches.open('semeynaya-kassa-v1'); await caches.open('unrelated-app-cache');
  const sandbox={URL,Response,AbortController,caches,
    self:{registration:{scope:origin},location:{origin:new URL(origin).origin},clients:{claim:async()=>{}},skipWaiting:async()=>{},
      addEventListener(type,handler){handlers[type]=handler;}},
    fetch:(request,options) => new Promise((resolve,reject) => {
      pending.push({resolve,reject});
      options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    }),
    setTimeout(callback){const id=++timerId; timers.set(id,callback);return id;},
    clearTimeout(id){timers.delete(id);},
  };
  vm.runInNewContext(await fs.readFile(path.join(root,'sw.js'),'utf8'),sandbox);
  let install; handlers.install({waitUntil(promise){install=promise;}}); await install;
  let activate; handlers.activate({waitUntil(promise){activate=promise;}}); await activate;
  assert.equal(stores.has('semeynaya-kassa-v1'),false);
  assert.equal(stores.has('unrelated-app-cache'),true);
  let response, background;
  handlers.fetch({request:{method:'GET',url:origin,mode:'navigate'},respondWith(promise){response=promise;},waitUntil(promise){background=promise;}});
  assert.equal(await (await response).text(),'cached');
  assert.equal(pending.length,1,'network refresh is running independently');
  for(const callback of timers.values()) callback();
  await background;
  let intercepted=false;
  handlers.fetch({request:{method:'GET',url:backend+'/rest/v1/expenses',mode:'cors'},respondWith(){intercepted=true;},waitUntil(){}});
  assert.equal(intercepted,false);
  assert.ok([...stores.get('semeynaya-kassa-v2').keys()].every(url => url.startsWith(origin)));
});
