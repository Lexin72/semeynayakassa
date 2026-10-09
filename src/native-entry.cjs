const {registerPlugin, Capacitor} = require('@capacitor/core');
const {LocalStore, createLocalClient} = require('./local-store.cjs');

if(Capacitor.isNativePlatform()) {
  const database = registerPlugin('FamilyCashDatabase');
  let store, timer, listeners = [], remoteChannel;
  const native = window.FamilyCashNative = {
    async createClient(remote) {
      store = await new LocalStore({
        load:async () => { const {snapshot} = await database.load(); return snapshot ? JSON.parse(snapshot) : null; },
        save:async state => { await database.save({snapshot:JSON.stringify(state)}); }
      }, remote, {
        onStatus:() => { renderStatus(); window.dispatchEvent(new Event('family-cash:status')); },
        onData:() => window.dispatchEvent(new Event('family-cash:data'))
      }).open();
      native.remote = remote;
      return createLocalClient(store, () => native.schedule());
    },
    status:() => store?.status(),
    async sync() { if(store && navigator.onLine) await store.sync(); renderStatus(); },
    schedule() { clearTimeout(timer); timer = setTimeout(() => native.sync(), 400); },
    start() {
      const style = document.createElement('style');
      style.textContent = `
        .native-status{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 14px;background:#eee8d8;color:#572a07;font:12px Inter,sans-serif}
        .native-status button{border:1px solid #95531866;border-radius:8px;padding:5px 9px;background:transparent;color:inherit;font:inherit}
        .native-sync-details{white-space:pre-wrap;font-size:13px;overflow-wrap:anywhere;margin:12px 0}
        .native-sync-actions{display:grid;gap:10px;margin-top:16px}
        .native-conflict{padding:12px;border:1px solid #95531866;border-radius:10px;margin:14px 0;font-size:13px}
        .native-conflict p{white-space:pre-wrap;overflow-wrap:anywhere}
        /* Avoid continuous blur animations and full-screen repaints on phones. */
        .oil-puddle,.oil-puddle::before,.oil-puddle::after,.name-shimmer{animation:none!important}
        .overlay{backdrop-filter:none!important}
        html{overscroll-behavior:none}
      `;
      document.head.appendChild(style);
      const bar = document.createElement('div');
      bar.className = 'native-status';
      bar.innerHTML = '<span id="native-sync-status" role="status"></span><button type="button">Состояние</button>';
      bar.querySelector('button').addEventListener('click', showDetails);
      document.body.prepend(bar);
      window.addEventListener('online', () => native.schedule());
      window.addEventListener('offline', renderStatus);
      document.addEventListener('visibilitychange', () => {
        if(!document.hidden) native.schedule();
      });
      window.addEventListener('family-cash:back', () => {
        const overlay = document.querySelector('.overlay:last-of-type');
        if(overlay) overlay.remove(); else database.minimize();
      });
      setInterval(() => { if(!document.hidden) native.schedule(); }, 30000);
      // Realtime is a prompt to re-read; a missed websocket message is repaired
      // by polling on resume and every 30 seconds while the app is foregrounded.
      remoteChannel = native.remote.channel('android-family-cash')
        .on('postgres_changes', {event:'*', schema:'public'}, () => native.schedule()).subscribe();
      native.schedule();
      renderStatus();
    }
  };

  function statusText() {
    const status = store?.status();
    if(!status) return 'Открываем базу на телефоне…';
    if(status.conflict) return 'Нужно выбрать версию изменённой записи';
    if(!status.initialized) return status.syncing ? 'Загружаем семейную кассу…' : 'Для первой загрузки нужна связь с сервером';
    if(status.pending) return `На телефоне сохранено. Ждут отправки: ${status.pending}`;
    if(!navigator.onLine || status.error) return 'Офлайн · изменения сохраняются на телефоне';
    return status.syncing ? 'Проверяем изменения семьи…' : 'Все изменения отправлены';
  }
  function renderStatus() {
    const label = document.getElementById('native-sync-status');
    if(label) label.textContent = statusText();
    listeners.forEach(listener => listener());
  }
  function describe(table, row) {
    if(!row) return 'Запись удалена';
    if(table === 'expenses') {
      const member = store.state.tables.members.find(m => m.id === row.member_id)?.name || 'Участник';
      const category = store.state.tables.categories.find(c => c.id === row.category_id)?.name || 'Категория';
      return `${row.date} · ${Number(row.amount).toLocaleString('ru-RU')} ₽\n${member} · ${category}${row.note ? '\n' + row.note : ''}`;
    }
    if(table === 'settings') return `Бюджет: ${row.value ?? 'не задан'}`;
    return row.name || 'Запись';
  }
  function showDetails() {
    if(document.getElementById('native-sync-dialog')) return;
    const overlay = document.createElement('div');
    overlay.className = 'overlay'; overlay.id = 'native-sync-dialog';
    overlay.innerHTML = `<div class="modal"><h2>Синхронизация</h2>
      <div class="native-sync-details" role="status"></div><div class="native-conflict" hidden></div>
      <div class="native-sync-actions"><button class="btn btn-primary" data-sync>Повторить синхронизацию</button>
      <button class="btn btn-secondary" data-backup>Сохранить резервную копию</button>
      <button class="btn btn-secondary" data-close>Закрыть</button></div></div>`;
    const update = () => {
      if(!overlay.isConnected) { listeners = listeners.filter(fn => fn !== update); return; }
      const status = store.status();
      overlay.querySelector('.native-sync-details').textContent = statusText() +
        (status.lastSync ? '\nПоследний обмен: ' + new Date(status.lastSync).toLocaleString('ru-RU') : '') +
        '\nДругие участники увидят новые траты после отправки. Обмен выполняется, пока приложение открыто.' +
        (status.error ? '\nОбмен пока не завершён. Неотправленные изменения остаются на телефоне.' : '');
      overlay.querySelector('[data-sync]').disabled = status.syncing;
      const box = overlay.querySelector('.native-conflict');
      box.hidden = !status.conflict;
      if(status.conflict && !box.querySelector('button')) {
        const op = status.conflict;
        const local = store.state.outbox.filter(item => item.table === op.table && item.key === op.key).at(-1).after;
        const title = document.createElement('strong'); title.textContent = 'Запись изменена на двух устройствах'; box.append(title);
        for(const [label, row] of [['На этом телефоне', local], ['На сервере', op.conflict.remote]]) {
          const p = document.createElement('p'); p.textContent = label + ':\n' + describe(op.table, row); box.append(p);
        }
        for(const [choice, label] of [['local','Использовать версию телефона'], ['remote','Принять версию сервера']]) {
          const button = document.createElement('button'); button.className = 'btn btn-secondary'; button.textContent = label;
          button.onclick = async () => {
            box.querySelectorAll('button').forEach(b => { b.disabled = true; });
            try { await store.resolveConflict(choice); box.replaceChildren(); update(); }
            catch { box.querySelectorAll('button').forEach(b => { b.disabled = false; });
              overlay.querySelector('.native-sync-details').textContent = 'Для выбора версии нужна связь с сервером. Изменения сохранены на телефоне.'; }
          };
          box.append(button);
        }
      }
      if(!status.conflict) box.replaceChildren();
    };
    const close = () => { overlay.remove(); listeners = listeners.filter(fn => fn !== update); };
    overlay.querySelector('[data-close]').onclick = close;
    overlay.onclick = event => { if(event.target === overlay) close(); };
    overlay.querySelector('[data-sync]').onclick = () => native.sync();
    overlay.querySelector('[data-backup]').onclick = async () => {
      try { await database.exportBackup(); }
      catch { overlay.querySelector('.native-sync-details').textContent = 'Не удалось открыть сохранение резервной копии.'; }
    };
    document.body.append(overlay); listeners.push(update); update();
  }
}
