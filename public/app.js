/* Gestor de Horarios — lógica del frontend */
'use strict';

// ---------- Constantes ----------
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const STATUS_LABEL = { active: 'Activo', suspended: 'Suspendido', retired: 'Retirado', vacation: 'Vacaciones', leave: 'Incapacidad' };
const SPECIAL_CONDITIONS = { vacaciones: '🏖️', disponible: '✅', incapacidad: '🤒' }; // no cuentan como días trabajados
const shiftLabel = (val) => SPECIAL_CONDITIONS[val] ? `${SPECIAL_CONDITIONS[val]} ${val[0].toUpperCase()}${val.slice(1)}` : val;
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ---------- Estado ----------
let people = [];
let currentWeek = weekKeyOf(new Date());
let shifts = {};            // { personId: { "0": "08:00-16:00", ... } }
let settings = { company: '' };
let editingPersonId = null; // null = añadiendo
let shiftTarget = null;     // { personId, day }
let imgDay = 'all';         // día seleccionado para la imagen: 'all' | 0..6
let summaryMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
let lastSummaryRows = [];
const monthShiftCache = new Map();          // 'YYYY-MM' -> Map(personId -> { name, role, status, shifts })

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function isoMonday(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

function weekKeyOf(date) {
  const monday = isoMonday(date);
  const y = monday.getUTCFullYear();
  const thursday = new Date(monday);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const fDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDay + 3);
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${y}-W${String(week).padStart(2, '0')}`;
}

function weekDates(mondayStr) {
  const [y, w] = mondayStr.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const fDay = (jan4.getUTCDay() + 6) % 7;
  jan4.setUTCDate(jan4.getUTCDate() - fDay + 3); // primer jueves
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - 3 + (w - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d;
  });
}

const fmtDay = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const todayUTC = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------- Carga inicial ----------
async function loadAll() {
  const [p, s, st] = await Promise.all([
    api('/api/people'),
    api(`/api/schedule?week=${currentWeek}`),
    api('/api/settings'),
  ]);
  people = p;
  shifts = s.shifts || {};
  settings = st;
  if (settings.company) $('#app-title').textContent = `🗓 ${settings.company}`;
}

// ---------- Render: horario ----------
function activePeople() {
  return people.filter(p => p.status !== 'retired');
}

function renderSchedule() {
  const dates = weekDates(currentWeek);
  const monday = dates[0];
  const sunday = dates[6];
  $('#week-label').textContent =
    `Semana ${currentWeek.split('-W')[1]} · ${fmtDay(monday)} – ${fmtDay(sunday)}`;

  const grid = $('#schedule-grid');
  grid.classList.add('day-grid');
  grid.innerHTML = '';
  const staff = activePeople();
  const today = todayUTC();

  dates.forEach((date, i) => {
    const isToday = date.getTime() === today.getTime();
    const card = document.createElement('div');
    card.className = 'day-card' + (isToday ? ' today' : '');
    const rows = [];
    let count = 0;

    staff.forEach(p => {
      const val = (shifts[p.id] || {})[String(i)];
      const nameHtml = `<span class="p-name">${escapeHtml(p.name)}${p.role ? ` <span class="p-role">· ${escapeHtml(p.role)}</span>` : ''}</span>`;
      if (p.status === 'suspended') {
        rows.push(`<div class="person-row suspended-person">⚠️ ${nameHtml}<span class="p-time" style="color:var(--amber)">Suspendido</span></div>`);
      } else if (val) {
        count++;
        const cond = SPECIAL_CONDITIONS[val];
        const icon = cond || '🕐';
        const cls = cond ? ' cond-row' : '';
        rows.push(`<div class="person-row${cls}" data-person="${p.id}" data-day="${i}" role="button" tabindex="0">${icon} ${nameHtml}<span class="p-time">${escapeHtml(shiftLabel(val))}</span></div>`);
      }
    });

    card.innerHTML = `
      <div class="day-header">
        <span>${DAYS[i]} ${fmtDay(date)}${isToday ? '<span class="today-badge">Hoy</span>' : ''}</span>
        <span class="day-count">${count ? count + ' programado' + (count > 1 ? 's' : '') : ''}</span>
      </div>
      <div class="day-body">
        ${rows.join('')}
        <button class="add-shift-btn" data-day="${i}">＋ Añadir turno</button>
      </div>`;
    grid.appendChild(card);
  });

  grid.querySelectorAll('.person-row[data-person]').forEach(el => {
    el.addEventListener('click', () => openShiftModal(el.dataset.person, Number(el.dataset.day)));
  });
  grid.querySelectorAll('.add-shift-btn').forEach(el => {
    el.addEventListener('click', () => openAddShift(el.dataset.day));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Render: personal ----------
function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function renderStaff() {
  const list = $('#staff-list');
  list.innerHTML = '';
  if (!people.length) {
    list.innerHTML = '<li class="empty-note" style="color:var(--muted);text-align:center;padding:20px">Aún no hay personal. Toca «＋ Añadir personal».</li>';
    return;
  }
  people.forEach(p => {
    const li = document.createElement('li');
    li.className = `person-card ${p.status}`;
    li.innerHTML = `
      <div class="avatar">${escapeHtml(initials(p.name))}</div>
      <div class="info">
        <div class="name">${escapeHtml(p.name)}<span class="badge ${p.status}">${STATUS_LABEL[p.status]}</span></div>
        <div class="sub">${p.role ? escapeHtml(p.role) + ' · ' : ''}${p.phone ? '📱 ' + escapeHtml(p.phone) : 'Sin teléfono'}</div>
      </div>
      <button class="menu-btn" aria-label="Opciones">⋮</button>`;
    li.querySelector('.menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openCtxMenu(e.currentTarget, p);
    });
    list.appendChild(li);
  });
}

// ---------- Modal persona ----------
function openPersonModal(person) {
  editingPersonId = person ? person.id : null;
  $('#person-modal-title').textContent = person ? 'Editar personal' : 'Añadir personal';
  $('#inp-name').value = person ? person.name : '';
  $('#inp-role').value = person ? person.role : '';
  $('#inp-phone').value = person ? person.phone : '';
  $('#modal-person').hidden = false;
  $('#inp-name').focus();
}

async function savePerson() {
  const name = $('#inp-name').value.trim();
  if (!name) { toast('Escribe el nombre'); return; }
  const body = { name, role: $('#inp-role').value.trim(), phone: $('#inp-phone').value.trim() };
  try {
    if (editingPersonId) {
      await api(`/api/people/${editingPersonId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('Cambios guardados ✅');
    } else {
      await api('/api/people', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('Personal añadido ✅');
    }
    $('#modal-person').hidden = true;
    await refresh();
  } catch (e) { toast(e.message); }
}

// ---------- Menú contextual ----------
function openCtxMenu(anchor, person) {
  const menu = $('#ctx-menu');
  const items = [];
  items.push({ label: '✏️ Editar', fn: () => openPersonModal(person) });

  if (person.status === 'active') {
    items.push({ label: '⏸️ Suspender', fn: () => setStatus(person, 'suspended') });
  } else {
    items.push({ label: '▶️ Reactivar', fn: () => setStatus(person, 'active') });
  }
  if (person.status !== 'vacation') {
    items.push({ label: '🏖️ Poner de vacaciones', fn: () => setStatus(person, 'vacation') });
  }
  if (person.status !== 'leave') {
    items.push({ label: '🤒 Marcar incapacidad', fn: () => setStatus(person, 'leave') });
  }

  if (person.phone) {
    items.push({ label: '💬 WhatsApp directo', fn: () => sendPersonWhatsApp(person) });
  }
  items.push({ label: '🗑️ Retirar (eliminar)', fn: () => retirePerson(person), danger: true });

  menu.innerHTML = '';
  items.forEach(it => {
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    b.addEventListener('click', () => { menu.hidden = true; it.fn(); });
    menu.appendChild(b);
  });

  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  const mw = menu.offsetWidth;
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 10) + 'px';
  menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
}

async function setStatus(person, status) {
  try {
    await api(`/api/people/${person.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    toast(status === 'suspended' ? 'Persona suspendida' : status === 'vacation' ? 'Persona de vacaciones 🏖️' : status === 'leave' ? 'Persona con incapacidad 🤒' : 'Persona activada');
    await refresh();
  } catch (e) { toast(e.message); }
}

async function retirePerson(person) {
  if (!confirm(`¿Retirar a ${person.name}? Se eliminará su ficha y todos sus turnos. Esta acción no se puede deshacer.`)) return;
  try {
    await api(`/api/people/${person.id}`, { method: 'DELETE' });
    toast('Personal retirado');
    await refresh();
  } catch (e) { toast(e.message); }
}

// ---------- Modal turno ----------
function openAddShift(day) {
  const staff = activePeople().filter(p => p.status === 'active');
  if (!staff.length) { toast('Primero añade personal en la pestaña 👥'); return; }
  const list = $('#pick-list');
  list.innerHTML = '';
  staff.forEach(p => {
    const b = document.createElement('button');
    b.className = 'pick-btn';
    b.innerHTML = `${escapeHtml(p.name)}${p.role ? `<span class="sub">${escapeHtml(p.role)}</span>` : ''}`;
    b.addEventListener('click', () => { $('#modal-pick').hidden = true; openShiftModal(p.id, day); });
    list.appendChild(b);
  });
  $('#modal-pick').hidden = false;
}

// Marca visualmente el chip elegido (o ninguno) en el modal de turno
function markChip(chip) {
  $$('#modal-shift .chip').forEach(c => c.classList.toggle('active', c === chip));
}

function openShiftModal(personId, day) {
  const person = people.find(p => p.id === personId);
  if (!person) return;
  shiftTarget = { personId, day };
  $('#shift-modal-title').textContent = `${person.name} · ${DAYS[day]}`;
  const cur = (shifts[personId] || {})[String(day)] || '';
  const isCond = !!SPECIAL_CONDITIONS[cur];
  $('#inp-cond').value = isCond ? cur : '';
  $('#inp-start').value = isCond || !cur ? '' : cur.split('-')[0];
  $('#inp-end').value = isCond || !cur ? '' : cur.split('-')[1];
  // Marcar el chip que corresponde al valor actual (si lo hay)
  markChip($$('#modal-shift .chip').find(c =>
    c.dataset.cond ? c.dataset.cond === cur : (c.dataset.start === $('#inp-start').value && c.dataset.end === $('#inp-end').value)
  ));
  $('#modal-shift').hidden = false;
  $('#inp-start').focus();
}

async function saveShift() {
  const { personId, day } = shiftTarget;
  const start = $('#inp-start').value;
  const end = $('#inp-end').value;
  const cond = $('#inp-cond').value;

  if (start && end && end <= start) { toast('La salida debe ser mayor a la entrada'); return; }

  shifts[personId] = shifts[personId] || {};
  if (cond) {
    shifts[personId][String(day)] = cond;
  } else if (!start && !end) {
    delete shifts[personId][String(day)];
  } else {
    if (!start || !end) { toast('Completa entrada y salida'); return; }
    shifts[personId][String(day)] = `${start}-${end}`;
  }
  try {
    await api('/api/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week: currentWeek, shifts }),
    });
    monthShiftCache.clear(); // barato y correcto: cualquier semana editada puede afectar cualquier mes abierto
    $('#modal-shift').hidden = true;
    renderSchedule();
    toast('Turno guardado ✅');
  } catch (e) { toast(e.message); }
}

// ---------- WhatsApp ----------
function openWhatsApp(text, phone) {
  if (!phone) { copyText(text, 'Esa persona no tiene teléfono. Mensaje copiado para pegarlo manualmente.'); return; }
  window.open(`https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`, '_blank');
}

let sentThisWeek = new Set(); // ids de personas a las que ya se les envió su horario

function openSendModal() {
  const targets = activePeople().filter(p => p.status === 'active');
  const list = $('#send-list');
  const bar = $('#send-all-bar');
  list.innerHTML = '';
  bar.innerHTML = '';
  if (!targets.length) {
    list.innerHTML = '<p class="hint" style="padding:10px">No hay personal activo con horario esta semana.</p>';
  }
  targets.forEach(p => {
    const hasShifts = DAYS.some((_, i) => (shifts[p.id] || {})[String(i)]);
    const b = document.createElement('button');
    b.className = 'pick-btn' + (sentThisWeek.has(p.id) ? ' sent' : '');
    b.innerHTML = `${escapeHtml(p.name)}${p.role ? `<span class="sub">${escapeHtml(p.role)}</span>` : ''}` +
      `<span class="sub ${hasShifts ? 'has-shifts' : 'no-shifts'}">${sentThisWeek.has(p.id) ? '✓ Enviado' : hasShifts ? 'Con turnos esta semana' : 'Sin turnos'}</span>`;
    b.addEventListener('click', () => sendPersonWhatsApp(p));
    list.appendChild(b);
  });

  const withPhone = targets.filter(p => p.phone && DAYS.some((_, i) => (shifts[p.id] || {})[String(i)]) && p.status === 'active');
  if (withPhone.length) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-whatsapp';
    btn.textContent = `🚀 Enviar a todos (${withPhone.length})`;
    btn.addEventListener('click', () => {
      const pending = withPhone.filter(p => !sentThisWeek.has(p.id));
      const queue = pending.length ? pending : withPhone; // si ya se envió a todos, vuelve a empezar
      const p = queue[0];
      if (!p.phone) { toast('Esa persona no tiene teléfono'); return; }
      openWhatsApp(buildPersonMessage(p), p.phone);
      toast(`WhatsApp de ${p.name} abierto — al volver, toca de nuevo para el siguiente`);
    });
    const hint = document.createElement('span');
    hint.className = 'hint';
    const done = withPhone.filter(p => sentThisWeek.has(p.id)).length;
    hint.textContent = done ? `${done} de ${withPhone.length} enviados` : 'Uno por uno, en orden';
    bar.appendChild(btn);
    bar.appendChild(hint);
  }
  $('#modal-send').hidden = false;
}

function sendPersonWhatsApp(person) {
  sentThisWeek.add(person.id);
  openWhatsApp(buildPersonMessage(person), person.phone);
  openSendModal(); // re-render para marcar «✓ Enviado»
}

function buildWeekMessage() {
  const dates = weekDates(currentWeek);
  const L = [];
  L.push(`📅 *HORARIO SEMANAL*${settings.company ? ` — ${settings.company}` : ''}`);
  L.push(`🗓 ${fmtDay(dates[0])} al ${fmtDay(dates[6])}`);
  L.push('');
  let total = 0;
  DAYS.forEach((dayName, i) => {
    L.push(`*${dayName} ${fmtDay(dates[i])}*`);
    const rows = activePeople()
      .filter(p => p.status === 'active' && (shifts[p.id] || {})[String(i)])
      .map(p => `• ${p.name}${p.role ? ` (${p.role})` : ''}: ${shiftLabel(shifts[p.id][String(i)])}`);
    if (rows.length) { L.push(...rows); total += rows.length; }
    else L.push('• Sin personal programado');
    L.push('');
  });
  L.push(`Total: ${total} turnos asignados. ¡Gracias! 🙌`);
  return L.join('\n');
}

function buildPersonMessage(person) {
  const dates = weekDates(currentWeek);
  const L = [];
  L.push(`Hola *${person.name}* 👋`);
  L.push(`Tu horario de la semana ${fmtDay(dates[0])} al ${fmtDay(dates[6])}${settings.company ? ` en *${settings.company}*` : ''}:`);
  L.push('');
  let any = false;
  DAYS.forEach((dayName, i) => {
    const val = (shifts[person.id] || {})[String(i)];
    if (!val) return;
    L.push(`• ${dayName} ${fmtDay(dates[i])}: ${shiftLabel(val)}`);
    any = true;
  });
  if (!any) L.push('(Sin turnos asignados esta semana)');
  L.push('');
  L.push('¡Te esperamos! 💪');
  return L.join('\n');
}

function sendWeekWhatsApp() {
  openSendModal();
}

// Al cambiar de semana, se olvida quién fue contactado
function resetSentTracking() {
  sentThisWeek.clear();
}

function copyText(text, okMsg) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast(okMsg || 'Copiado ✅')).catch(() => fallbackCopy(text, okMsg));
  } else {
    fallbackCopy(text, okMsg);
  }
}

function fallbackCopy(text, okMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast(okMsg || 'Copiado ✅'); }
  catch (_) { prompt('Copia el mensaje:', text); }
  document.body.removeChild(ta);
}

// ---------- Imagen del horario ----------
const IMG = { W: 800, pad: 26, bandH: 36, rowH: 36, yellow: '#f6a821', ink: '#111827', line: '#cbd5e1' };
const AREA_DEFS = [
  { re: /cocina/i, fija: 'COCINA PERSONAL FIJO', extra: 'COCINA PERSONAL EXTRA' },
  { re: /bar/i, fija: 'BAR FIJO', extra: 'BAR EXTRA' },
  { re: /habitac/i, fija: 'HABITACIONES FIJO', extra: 'HABITACIONES EXTRA' },
  { re: /mantenimiento/i, fija: 'MANTENIMIENTO FIJO', extra: 'MANTENIMIENTO EXTRA' },
  { re: /vigilante|seguridad/i, fija: 'VIGILANTES FIJO', extra: 'VIGILANTES EXTRA' },
];
const AREA_FALLBACK = { fija: 'OTRO PERSONAL FIJO', extra: 'OTRO PERSONAL EXTRA' };
const isFijo = (p) => /fij/i.test(p.role || '');

function buildImageSections() {
  const staff = activePeople();
  const used = new Set();
  const sections = [];
  const push = (title, list) => { if (list.length) sections.push({ title, people: list }); };

  for (const def of AREA_DEFS) {
    push(def.fija, staff.filter(p => !used.has(p.id) && def.re.test(p.role || '') && isFijo(p)));
    push(def.extra, staff.filter(p => !used.has(p.id) && def.re.test(p.role || '') && !isFijo(p)));
    staff.forEach(p => { if (def.re.test(p.role || '')) used.add(p.id); });
  }
  push(AREA_FALLBACK.fija, staff.filter(p => !used.has(p.id) && isFijo(p)));
  push(AREA_FALLBACK.extra, staff.filter(p => !used.has(p.id)));
  return sections;
}

function personWeekCell(p) {
  const sh = shifts[p.id] || {};
  if (imgDay !== 'all') {
    const v = sh[String(imgDay)];
    return v ? shiftLabel(v) : '—';
  }
  const vals = DAYS.map((_, i) => sh[String(i)]).filter(Boolean);
  if (!vals.length) return 'Disponible';
  if (vals.length === 7 && new Set(vals).size === 1) return `${shiftLabel(vals[0])} (L-D)`;
  const letter = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  return DAYS.map((_, i) => sh[String(i)] ? `${letter[i]} ${shiftLabel(sh[String(i)])}` : null).filter(Boolean).join(' · ');
}

function drawScheduleImage() {
  const dates = weekDates(currentWeek);
  const sections = buildImageSections();
  const daySuffix = imgDay === 'all' ? '' : ` — ${DAYS[imgDay].toUpperCase()} ${fmtDay(dates[imgDay])}`;
  const c = $('#schedule-canvas');
  const ctx = c.getContext('2d');
  const S = 2, W = IMG.W;

  let H = IMG.pad + 34 + 30;
  for (const sec of sections) H += IMG.bandH + sec.people.length * IMG.rowH + 6;
  if (!sections.length) H += 46;
  H += 34 + IMG.pad;

  c.width = W * S; c.height = H * S;
  ctx.scale(S, S);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  let y = IMG.pad;
  ctx.textAlign = 'center';
  ctx.fillStyle = IMG.ink;
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillText(`HORARIO${daySuffix}${settings.company ? ' — ' + settings.company.toUpperCase() : ''}`, W / 2, y + 24);
  y += 34;
  ctx.fillStyle = '#475569';
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText(`${fmtDay(dates[0])} al ${fmtDay(dates[6])} · Semana ${currentWeek.split('-W')[1]}`, W / 2, y + 18);
  y += 30;

  const x0 = IMG.pad, x1 = W - IMG.pad, splitX = x0 + (x1 - x0) * 0.58;
  ctx.textAlign = 'left';

  for (const sec of sections) {
    ctx.fillStyle = IMG.yellow;
    ctx.fillRect(x0, y, x1 - x0, IMG.bandH);
    ctx.fillStyle = IMG.ink;
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(sec.title, W / 2, y + 24);
    ctx.textAlign = 'left';
    y += IMG.bandH;

    for (const p of sec.people) {
      const suspended = p.status === 'suspended';
      ctx.fillStyle = '#fff';
      ctx.fillRect(x0, y, x1 - x0, IMG.rowH);
      ctx.fillStyle = suspended ? '#b45309' : IMG.ink;
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillText((p.name + (suspended ? ' (suspendido)' : '')).slice(0, 38), x0 + 10, y + 23);
      ctx.fillText(personWeekCell(p), splitX + 10, y + 23);
      ctx.strokeStyle = IMG.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + .5, y + .5, x1 - x0 - 1, IMG.rowH - 1);
      ctx.beginPath();
      ctx.moveTo(splitX + .5, y);
      ctx.lineTo(splitX + .5, y + IMG.rowH);
      ctx.stroke();
      y += IMG.rowH;
    }
    y += 6;
  }

  if (!sections.length) {
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('Sin personal activo para mostrar', W / 2, y + 20);
    y += 40;
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText('Generado con Gestor de Horarios', W / 2, y + 20);
  ctx.textAlign = 'left';
}

let currentImageFile = 'horario.png';

function downloadImage() {
  const a = document.createElement('a');
  a.href = $('#schedule-canvas').toDataURL('image/png');
  a.download = currentImageFile;
  a.click();
  toast('Imagen descargada 📷');
}

async function shareImage() {
  try {
    const blob = await new Promise((res, rej) => $('#schedule-canvas').toBlob(b => b ? res(b) : rej(new Error('sin imagen')), 'image/png'));
    const file = new File([blob], currentImageFile, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Horario semanal' });
    } else {
      downloadImage();
      toast('Comparte el archivo descargado por WhatsApp');
    }
  } catch (e) {
    if (e.name !== 'AbortError') toast('No se pudo compartir la imagen');
  }
}

// ---------- Resumen quincenal/mensual ----------
// Devuelve Map(personId -> { name, role, status, shifts }) donde shifts se indexa
// por día absoluto: 0 = lunes de la semana que contiene el día 1 del mes.
async function fetchMonthShifts(ym) {
  if (monthShiftCache.has(ym)) return monthShiftCache.get(ym);
  const [y, m] = ym.split('-').map(Number);
  const day1 = new Date(Date.UTC(y, m - 1, 1));
  const dow0 = (day1.getUTCDay() + 6) % 7; // 0 = lunes
  const start = new Date(day1); start.setUTCDate(1 - dow0);
  const lastDay = new Date(Date.UTC(y, m - 1, new Date(Date.UTC(y, m, 0)).getUTCDate()));

  const weeks = [];
  for (let d = new Date(start); d.getTime() <= lastDay.getTime(); d.setUTCDate(d.getUTCDate() + 7)) {
    weeks.push(weekKeyOf(d));
  }
  const results = await Promise.all(weeks.map(w => api(`/api/schedule?week=${w}`)));

  const byPerson = new Map();
  for (const p of people) {
    if (p.status !== 'retired') byPerson.set(p.id, { name: p.name, role: p.role, status: p.status, shifts: {} });
  }
  results.forEach((r, wi) => {
    for (const [pid, sh] of Object.entries(r.shifts || {})) {
      const entry = byPerson.get(pid);
      if (!entry) continue;
      for (const [day, val] of Object.entries(sh)) entry.shifts[Number(day) + wi * 7] = val;
    }
  });
  monthShiftCache.set(ym, byPerson);
  return byPerson;
}

function countFortnightDays(sh, y, m0) {
  const dim = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  const day1 = new Date(Date.UTC(y, m0, 1));
  const dow0 = (day1.getUTCDay() + 6) % 7; // 0 = lunes
  let q1 = 0, q2 = 0;
  const condCount = {};
  for (let d = 1; d <= dim; d++) {
    const v = sh[d - 1 + dow0];
    if (!v) continue;
    if (SPECIAL_CONDITIONS[v]) { condCount[v] = (condCount[v] || 0) + 1; continue; }
    if (d <= 15) q1++; else q2++;
  }
  return { q1, q2, total: q1 + q2, condCount };
}

async function renderSummary() {
  const [y, m] = summaryMonth.split('-').map(Number);
  $('#summary-month-label').textContent = `${MONTHS[m - 1]} ${y}`;
  $('#summary-table').innerHTML = '<tbody><tr><td colspan="4">Cargando…</td></tr></tbody>';
  try {
    const byPerson = await fetchMonthShifts(summaryMonth);
    lastSummaryRows = Array.from(byPerson, ([id, e]) => ({
      name: e.name,
      role: e.role,
      suspended: e.status === 'suspended',
      ...countFortnightDays(e.shifts, y, m - 1),
    }));

    const tot = { q1: 0, q2: 0, total: 0 };
    const body = lastSummaryRows.map(r => {
      tot.q1 += r.q1; tot.q2 += r.q2; tot.total += r.total;
      const conds = Object.entries(r.condCount || {}).map(([c, n]) => `${SPECIAL_CONDITIONS[c]} ${n}`).join(' ');
      const name = `${escapeHtml(r.name)}${r.role ? ` <small>· ${escapeHtml(r.role)}</small>` : ''}${conds ? ` <small>${conds}</small>` : ''}`;
      return `<tr${r.suspended ? ' class="suspended-row"' : ''}><td>${name}</td><td>${r.q1}</td><td>${r.q2}</td><td>${r.total}</td></tr>`;
    }).join('') || '<tr><td colspan="4">Sin personal</td></tr>';
    $('#summary-table').innerHTML =
      `<thead><tr><th>Persona</th><th>1.ª quin.</th><th>2.ª quin.</th><th>Total</th></tr></thead>` +
      `<tbody>${body}<tr class="total-row"><td>TOTAL</td><td>${tot.q1}</td><td>${tot.q2}</td><td>${tot.total}</td></tr></tbody>`;
  } catch (e) {
    $('#summary-table').innerHTML = `<tbody><tr><td colspan="4">${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

function changeMonth(delta) {
  const [y, m] = summaryMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  summaryMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  renderSummary();
}

function buildSummaryMessage() {
  const [y, m] = summaryMonth.split('-').map(Number);
  const L = [`📊 *DÍAS PROGRAMADOS — ${MONTHS[m - 1].toUpperCase()} ${y}*${settings.company ? ` (${settings.company})` : ''}`, ''];
  lastSummaryRows.forEach(r => {
    const conds = Object.entries(r.condCount || {}).map(([c, n]) => `${SPECIAL_CONDITIONS[c]} ${n} ${c}`).join(', ');
    L.push(`• ${r.name}: ${r.total} día${r.total === 1 ? '' : 's'} (1.ª: ${r.q1} / 2.ª: ${r.q2})${conds ? ` — ${conds}` : ''}`);
  });
  const total = lastSummaryRows.reduce((a, r) => a + r.total, 0);
  L.push('', `Total general: ${total} días programados.`);
  return L.join('\n');
}

function drawSummaryImage() {
  const c = $('#schedule-canvas');
  const ctx = c.getContext('2d');
  const S = 2, W = 800, x0 = 26, x1 = W - 26, rowH = 34, pad = 26;
  const split = [0, 0.52, 0.72, 0.87].map(f => x0 + (x1 - x0) * f);
  const [y0, m0] = summaryMonth.split('-').map(Number);

  const H = pad + 34 + 22 + IMG.bandH + Math.max(lastSummaryRows.length, 1) * rowH + 40 + pad;
  c.width = W * S; c.height = H * S;
  ctx.scale(S, S);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

  let y = pad;
  ctx.fillStyle = IMG.ink; ctx.textAlign = 'center';
  ctx.font = 'bold 24px system-ui, sans-serif';
  ctx.fillText(`DÍAS PROGRAMADOS${settings.company ? ' — ' + settings.company.toUpperCase() : ''}`, W / 2, y + 22);
  y += 34;
  ctx.fillStyle = '#475569'; ctx.font = '15px system-ui, sans-serif';
  ctx.fillText(`${MONTHS[m0 - 1].toUpperCase()} ${y0} · 1.ª quincena: 1–15 · 2.ª: 16–fin de mes`, W / 2, y + 14);
  y += 22;

  ctx.fillStyle = IMG.yellow;
  ctx.fillRect(x0, y, x1 - x0, IMG.bandH);
  ctx.fillStyle = IMG.ink; ctx.font = 'bold 15px system-ui, sans-serif';
  ['PERSONA', '1.ª QUINCENA', '2.ª QUINCENA', 'TOTAL'].forEach((t, i) => {
    ctx.textAlign = i === 0 ? 'left' : 'center';
    ctx.fillText(t, i === 0 ? x0 + 10 : (split[i] + split[i + 1]) / 2, y + 23);
  });
  y += IMG.bandH;

  ctx.textAlign = 'left';
  const rows = lastSummaryRows.length ? lastSummaryRows : [{ name: 'Sin personal', q1: '', q2: '', total: '' }];
  for (const r of rows) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, y, x1 - x0, rowH);
    ctx.fillStyle = r.suspended ? '#b45309' : IMG.ink;
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillText((r.name + (r.suspended ? ' (suspendido)' : '')).slice(0, 36), x0 + 10, y + 22);
    ctx.textAlign = 'center';
    ctx.fillText(String(r.q1), (split[1] + split[2]) / 2, y + 22);
    ctx.fillText(String(r.q2), (split[2] + split[3]) / 2, y + 22);
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText(String(r.total), (split[3] + x1) / 2, y + 22);
    ctx.textAlign = 'left';
    ctx.strokeStyle = IMG.line; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + .5, y + .5, x1 - x0 - 1, rowH - 1);
    for (let i = 1; i < split.length; i++) {
      ctx.beginPath(); ctx.moveTo(split[i] + .5, y); ctx.lineTo(split[i] + .5, y + rowH); ctx.stroke();
    }
    y += rowH;
  }

  ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.font = '13px system-ui, sans-serif';
  ctx.fillText('Generado con Gestor de Horarios', W / 2, y + 24);
  ctx.textAlign = 'left';
}

// ---------- Ajustes ----------
async function saveSettings() {
  const company = $('#inp-company').value.trim();
  try {
    settings = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company }) });
    $('#app-title').textContent = settings.company ? `🗓 ${settings.company}` : '🗓 Gestor de Horarios';
    $('#modal-settings').hidden = true;
    toast('Ajustes guardados ✅');
  } catch (e) { toast(e.message); }
}

// ---------- Refresh ----------
async function refresh() {
  people = await api('/api/people');
  const s = await api(`/api/schedule?week=${currentWeek}`);
  shifts = s.shifts || {};
  renderSchedule();
  renderStaff();
}

// ---------- Navegación de semanas ----------
function changeWeek(delta) {
  const dates = weekDates(currentWeek);
  const d = new Date(dates[0]);
  d.setUTCDate(d.getUTCDate() + delta * 7);
  currentWeek = weekKeyOf(d);
  resetSentTracking();
  refresh().catch(e => toast(e.message));
}

// ---------- Eventos ----------
function wire() {
  // Pestañas
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
      $('#tab-schedule').hidden = tab.dataset.tab !== 'schedule';
      $('#tab-staff').hidden = tab.dataset.tab !== 'staff';
    });
  });

  $('#btn-prev-week').addEventListener('click', () => changeWeek(-1));
  $('#btn-next-week').addEventListener('click', () => changeWeek(1));
  $('#btn-now').addEventListener('click', () => { currentWeek = weekKeyOf(new Date()); resetSentTracking(); refresh().catch(e => toast(e.message)); });

  $('#btn-add-person').addEventListener('click', () => openPersonModal(null));
  $('#btn-save-person').addEventListener('click', savePerson);
  $('#btn-save-shift').addEventListener('click', saveShift);
  $('#btn-save-settings').addEventListener('click', saveSettings);

  $('#btn-settings').addEventListener('click', () => {
    $('#inp-company').value = settings.company || '';
    $('#modal-settings').hidden = false;
  });

  $('#btn-share-all').addEventListener('click', sendWeekWhatsApp);
  $('#btn-copy').addEventListener('click', () => copyText(buildWeekMessage(), 'Lista semanal copiada 📋'));
  $('#btn-image').addEventListener('click', () => {
    imgDay = 'all';
    $$('#img-day-chips .chip-day').forEach(c => c.classList.toggle('active', c.dataset.day === 'all'));
    currentImageFile = `horario-${currentWeek}.png`;
    drawScheduleImage();
    $('#modal-image').hidden = false;
  });
  $('#btn-download-image').addEventListener('click', downloadImage);
  $('#btn-share-image').addEventListener('click', shareImage);

  $('#btn-summary').addEventListener('click', () => { $('#modal-summary').hidden = false; renderSummary(); });
  $('#btn-prev-month').addEventListener('click', () => changeMonth(-1));
  $('#btn-next-month').addEventListener('click', () => changeMonth(1));
  $('#btn-copy-summary').addEventListener('click', () => copyText(buildSummaryMessage(), 'Resumen copiado 📋'));
  $('#btn-share-summary').addEventListener('click', () => {
    const first = activePeople().find(p => p.status === 'active' && p.phone);
    openWhatsApp(buildSummaryMessage(), first && first.phone);
  });
  // (btn-share-all ya abre el modal de envío individual vía sendWeekWhatsApp)
  $('#btn-image-summary').addEventListener('click', () => { currentImageFile = `resumen-${summaryMonth}.png`; drawSummaryImage(); $('#modal-image').hidden = false; });

  $('#btn-backup').addEventListener('click', () => { window.location.href = '/api/backup'; });
  $('#file-restore').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      await api('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
      toast('Respaldo restaurado ✅');
      monthShiftCache.clear();
      settings = await api('/api/settings');
      if (settings.company) $('#app-title').textContent = `🗓 ${settings.company}`;
      await refresh();
    } catch (err) { toast('Archivo no válido: ' + err.message); }
    e.target.value = '';
  });

  // Cerrar modales
  $$('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true; });
    ov.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { ov.hidden = true; }));
  });

  // Chips de turnos rápidos y condiciones especiales: se ven seleccionados antes de guardar
  $$('#modal-shift .chip[data-start]').forEach(chip => {
    chip.addEventListener('click', () => {
      $('#inp-start').value = chip.dataset.start;
      $('#inp-end').value = chip.dataset.end;
      $('#inp-cond').value = '';
      markChip(chip);
    });
  });
  $$('#modal-shift .chip-cond').forEach(chip => {
    chip.addEventListener('click', () => {
      $('#inp-start').value = '';
      $('#inp-end').value = '';
      $('#inp-cond').value = chip.dataset.cond;
      markChip(chip);
    });
  });
  // Si el usuario escribe las horas a mano, se anula la condición y la selección del chip
  ['inp-start', 'inp-end'].forEach(id => {
    $('#' + id).addEventListener('input', () => {
      $('#inp-cond').value = '';
      markChip(null);
    });
  });

  // Selector de día para la imagen
  $$('#img-day-chips .chip-day').forEach(chip => {
    chip.addEventListener('click', () => {
      imgDay = chip.dataset.day === 'all' ? 'all' : Number(chip.dataset.day);
      $$('#img-day-chips .chip-day').forEach(c => c.classList.toggle('active', c === chip));
      drawScheduleImage();
    });
  });

  // Enter en formulario de persona
  $('#modal-person').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePerson(); });

  // Historial de retirados
  $('#btn-archive').addEventListener('click', toggleArchive);

  // Cerrar menú contextual al tocar fuera
  document.addEventListener('click', (e) => {
    if (!$('#ctx-menu').hidden && !e.target.closest('.ctx-menu')) $('#ctx-menu').hidden = true;
  });
}

// ---------- Historial de retirados ----------
async function toggleArchive() {
  const box = $('#archive-list');
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<p class="hint" style="padding:6px">Cargando…</p>';
  try {
    const list = await api('/api/archive');
    if (!list.length) { box.innerHTML = '<p class="hint" style="padding:6px">Historial vacío — nadie retirado todavía.</p>'; return; }
    box.innerHTML = '';
    list.forEach(p => {
      const div = document.createElement('div');
      div.className = 'archive-item';
      const fecha = p.retiredAt ? new Date(p.retiredAt).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
      div.innerHTML = `
        <div class="info">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="sub">${p.role ? escapeHtml(p.role) + ' · ' : ''}Retirado${fecha ? ' el ' + fecha : ''} · ${p.weeks} semana${p.weeks === 1 ? '' : 's'} de turnos guardadas</div>
        </div>
        <button class="btn btn-sm btn-primary">Reintegrar</button>`;
      div.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`¿Reintegrar a ${p.name}? Volverá al personal activo con sus turnos pasados recuperados.`)) return;
        try {
          await api(`/api/archive/${p.id}/reinstate`, { method: 'POST' });
          toast('Personal reintegrado ✅');
          box.hidden = true;
          await refresh();
        } catch (e) { toast(e.message); }
      });
      box.appendChild(div);
    });
  } catch (e) {
    box.innerHTML = `<p class="hint" style="padding:6px">Error: ${escapeHtml(e.message)}</p>`;
  }
}

// ---------- Init ----------
(async function init() {
  wire();
  try {
    await loadAll();
    renderSchedule();
    renderStaff();
  } catch (e) {
    toast('No se pudo conectar con el servidor');
    console.error(e);
  }
})();
