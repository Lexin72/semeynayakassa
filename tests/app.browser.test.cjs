const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const basePath = '/semeynayakassa/';
const backend = 'https://cjitxdvgmilxmdwdygha.supabase.co';
const cachePrefix = 'family-cash-cache-v1:' + backend + ':';
const today = new Date();
function dateInMonth(offset, day = 1){
  const d = new Date(today.getFullYear(), today.getMonth() + offset, day);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function rangeForMonth(offset){
  return [dateInMonth(offset), dateInMonth(offset+1, 0)];
}
const members = [{id:'m1',name:'Аня',color:'#7C9473'}, {id:'m2',name:'Саша',color:'#5B7FA6'}];
const categories = [{id:'c1',name:'Продукты',color:'#7C9473'}];
function expense(id, amount, memberId = 'm1', offset = 0){
  return {id,amount,category_id:'c1',member_id:memberId,note:'Покупка',date:dateInMonth(offset, today.getDate()),created_at:Date.now()};
}
const defaults = [expense('e1',123), expense('e2',77,'m2')];
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.json':'application/json','.css':'text/css','.png':'image/png','.woff2':'font/woff2'};
let browser, server, origin, slowStatic = false;
const pendingStatic = new Set();

before(async () => {
  server = http.createServer(async (req,res) => {
    if(slowStatic && !req.url.includes('sw.js')){
      pendingStatic.add(res);
      res.on('close', () => pendingStatic.delete(res));
      return;
    }
    const relative = decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(basePath.length) || 'index.html';
    if(relative === 'setup.html'){ res.writeHead(200,{'Content-Type':'text/html'}); res.end('<!DOCTYPE html><title>Setup</title>'); return; }
    const file = path.resolve(root, relative);
    if(!file.startsWith(root + path.sep)){ res.writeHead(404); res.end(); return; }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, {'Content-Type':mime[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-cache'});
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true,channel:'chromium'});
});
after(async () => {
  await browser?.close();
  pendingStatic.forEach(res => res.destroy());
  await new Promise(resolve => server.close(resolve));
});

async function setup(t, options = {}){
  const context = await browser.newContext({serviceWorkers: options.serviceWorkers ? 'allow' : 'block',
    viewport:{width:390,height:844},timezoneId:'UTC'});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [], errors = [], external = [];
  const config = {mode:'ok', expenses:[...defaults], ...options.api};
  const cors = {'access-control-allow-origin':'*', 'access-control-allow-methods':'GET,HEAD,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers':'apikey,authorization,x-client-info,content-type,prefer,range,range-unit'};
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await context.routeWebSocket('**/*.supabase.co/**', ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if(url.origin === origin) return route.continue();
    if(url.origin !== backend){ external.push(url.href); return route.abort(); }
    if(!url.pathname.startsWith('/rest/v1/')) return route.abort();
    if(request.method() === 'OPTIONS') return route.fulfill({status:204,headers:cors});
    calls.push({url, method:request.method()});
    if(config.mode === 'hang') await gate;
    if(config.mode === 'fail' || (config.failWrites && request.method() !== 'GET' && request.method() !== 'HEAD')){
      return route.fulfill({status:503,headers:cors,contentType:'application/json',body:JSON.stringify({message:'Unavailable'})}).catch(()=>{});
    }
    const table = url.pathname.split('/').at(-1);
    if(config.delay) await config.delay(table,url);
    let rows = table === 'members' ? members : table === 'categories' ? categories
      : table === 'settings' ? [{key:'monthly_budget',value:'5000'}] : config.expenses;
    if(table === 'expenses'){
      for(const filter of url.searchParams.getAll('date')){
        if(filter.startsWith('gte.')) rows = rows.filter(r => r.date >= filter.slice(4));
        if(filter.startsWith('lte.')) rows = rows.filter(r => r.date <= filter.slice(4));
      }
      rows = [...rows].sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 1000);
      rows = rows.slice(offset,offset+limit);
    }
    return route.fulfill({status:200,headers:cors,contentType:'application/json',body:JSON.stringify(rows)}).catch(()=>{});
  });
  await context.addInitScript(({prefix, member, seed}) => {
    if(member) localStorage.setItem('family-cash-member-id','m1');
    if(seed) for(const [key,value] of Object.entries(seed)) localStorage.setItem(prefix+key,JSON.stringify(value));
  }, {prefix:cachePrefix,member:options.member !== false,seed:options.seed});
  t.after(async () => { release(); await context.close(); assert.deepEqual(errors,[], 'browser errors'); assert.deepEqual(external,[], 'unexpected external dependencies'); });
  return {page,context,calls,config,release};
}

test('cached screen opens while all API calls are stalled, then reports timeout', async t => {
  const [start,end] = rangeForMonth(0);
  const rows = defaults.map(r => ({id:r.id,amount:r.amount,categoryId:r.category_id,memberId:r.member_id,note:r.note,date:r.date,createdAt:r.created_at}));
  const {page} = await setup(t, {api:{mode:'hang'}, seed:{members,categories,budget:5000,
    expenses:{[start+':'+end]:{savedAt:Date.now()-60000,rows}}}});
  await page.clock.install();
  const started = Date.now();
  await page.goto(origin+basePath, {waitUntil:'domcontentloaded'});
  await page.waitForSelector('.receipt', {timeout:1500});
  assert.ok(Date.now()-started < 1500, 'cached data must not wait for the API');
  assert.match(await page.locator('#top5-list').innerText(), /200/);
  await page.clock.fastForward(12100);
  await page.waitForSelector('#offline-banner.show', {timeout:1500});
  assert.match(await page.locator('#top5-list').innerText(), /200/);
  assert.equal(await page.locator('#retry-connection').isVisible(), true);
});

test('first visit with an unavailable backend offers retry instead of fake empty onboarding', async t => {
  const {page} = await setup(t, {member:false,api:{mode:'hang'}});
  await page.clock.install();
  await page.goto(origin+basePath,{waitUntil:'domcontentloaded'});
  assert.match(await page.locator('#app').innerText(), /Загружаем участников/);
  await page.clock.fastForward(12100);
  await page.waitForSelector('#retry-startup',{timeout:1500});
  assert.equal(await page.locator('#add-member-btn').count(),0);
});

test('switching member filters reuses loaded expenses and keeps correct totals', async t => {
  const {page,calls} = await setup(t);
  await page.goto(origin+basePath);
  await page.waitForSelector('.receipt');
  const count = () => calls.filter(c => c.url.pathname.endsWith('/expenses')).length;
  assert.equal(count(),1);
  await page.locator('[data-filter-member="m1"]').click();
  await page.waitForFunction(() => document.getElementById('top5-list').textContent.includes('123'));
  await page.locator('[data-filter-member="m2"]').click();
  await page.waitForFunction(() => document.getElementById('top5-list').textContent.includes('77'));
  assert.equal(count(),1);
});

test('late response from a previous month cannot replace the selected month', async t => {
  let releaseOld;
  const oldMonth = new Promise(resolve => { releaseOld = resolve; });
  const {page, calls} = await setup(t,{api:{expenses:[...defaults,expense('old',111,'m1',-1),expense('selected',222,'m1',-2)],
    delay:async (table,url) => {
      if(table === 'expenses' && url.searchParams.getAll('date').includes('gte.'+dateInMonth(-1))) await oldMonth;
    }}});
  t.after(releaseOld);
  await page.goto(origin+basePath);
  await page.waitForSelector('.receipt');
  await page.locator('#prev-month').click();
  await page.waitForFunction(() => document.querySelector('#month-main').textContent.length > 0);
  await page.locator('#prev-month').click();
  await page.waitForFunction(() => document.getElementById('top5-list').textContent.includes('222'));
  releaseOld();
  await page.waitForTimeout(200);
  assert.match(await page.locator('#top5-list').innerText(),/222/);
  assert.doesNotMatch(await page.locator('#top5-list').innerText(),/111/);
  assert.ok(calls.some(c => c.url.searchParams.getAll('date').includes('gte.'+dateInMonth(-1))));
});

test('analytics uses one paginated interval and includes expenses beyond 1000 rows', async t => {
  const expenses = Array.from({length:1005},(_,i) => expense(String(i).padStart(4,'0'),1));
  const {page,calls} = await setup(t,{api:{expenses}});
  await page.goto(origin+basePath);
  await page.waitForFunction(() => document.getElementById('top5-list').textContent.replace(/\s/g,'').includes('1005'));
  const beforeCount = calls.filter(c => c.url.pathname.endsWith('/expenses')).length;
  assert.equal(beforeCount,2);
  await page.locator('[data-page="analytics"]').click();
  await page.waitForSelector('.compare-card');
  const analyticsCalls = calls.filter(c => c.url.pathname.endsWith('/expenses')).slice(beforeCount);
  assert.equal(analyticsCalls.length,2,'one interval, with two pages');
  assert.equal(new Set(analyticsCalls.map(c => c.url.searchParams.getAll('date').join('|'))).size,1);
  await page.waitForFunction(() => document.querySelector('.compare-metric-value').textContent.replace(/\s/g,'').includes('1005'));
});

test('failed deletion retains the expense and never reports success', async t => {
  const {page,config,calls} = await setup(t);
  await page.goto(origin+basePath);
  await page.waitForSelector('.receipt');
  config.failWrites = true;
  await page.locator('.receipt').first().click();
  await page.locator('#exp-delete').click();
  await page.locator('#del-confirm').click();
  await page.waitForFunction(() => !document.getElementById('del-confirm').disabled);
  assert.match(await page.locator('#toast').innerText(), /Не удалось удалить/);
  assert.equal(await page.locator('#del-confirm').isVisible(),true);
  assert.equal(calls.filter(c => c.method === 'DELETE').length,1);
});

test('app stays usable when browser localStorage is unavailable', async t => {
  const {page,context} = await setup(t,{member:false});
  await context.addInitScript(() => {
    Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Unavailable','SecurityError');}});
  });
  await page.goto(origin+basePath);
  await page.waitForSelector('[data-select-member="m1"]');
  await page.locator('[data-select-member="m1"]').click();
  await page.waitForSelector('.receipt');
  assert.match(await page.locator('#top5-list').innerText(), /200/);
});

test('service worker opens instantly with hanging hosting and offline, caches only app assets', async t => {
  const {page,context} = await setup(t,{serviceWorkers:true});
  await page.goto(origin+basePath+'setup.html');
  await page.evaluate(async () => {
    await caches.open('semeynaya-kassa-v1');
    await caches.open('unrelated-app-cache');
  });
  await page.goto(origin+basePath);
  await page.waitForSelector('.receipt');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
  });
  assert.equal(await page.evaluate(async () => (await caches.keys()).includes('semeynaya-kassa-v1')),false);
  assert.equal(await page.evaluate(async () => (await caches.keys()).includes('unrelated-app-cache')),true);
  const keys = await page.evaluate(async () => (await (await caches.open('semeynaya-kassa-v2')).keys()).map(r => r.url));
  assert.ok(keys.some(url => url.includes('/vendor/supabase-2.117.3.js')));
  assert.ok(keys.every(url => new URL(url).origin === origin && !url.includes('/rest/v1/')));
  slowStatic = true;
  try {
    const started = Date.now();
    await page.reload({waitUntil:'domcontentloaded',timeout:2500});
    await page.waitForSelector('.receipt',{timeout:1500});
    assert.ok(Date.now()-started < 2500,'navigation must not await hanging hosting');
  } finally {
    slowStatic = false;
    pendingStatic.forEach(res => res.destroy());
  }
  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded',timeout:2500});
  await page.waitForSelector('.receipt',{timeout:1500});
  assert.match(await page.locator('#top5-list').innerText(), /200/);
  assert.equal(await page.locator('#offline-banner.show').count(),1);
});
