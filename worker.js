// Worker de Cloudflare — API del gestor de horarios con base de datos en KV.
// El frontend (public/) se sirve como Static Assets; las rutas /api/* las maneja este Worker.

const DB_KEY = 'db';                 // base viva
const BACKUP_PREFIX = 'backup:';     // backup:YYYY-MM-DD
const KEEP_BACKUPS = 30;

const PERSON_STATUS = ['active', 'suspended', 'retired', 'vacation', 'leave'];
const THEMES = ['indigo', 'emerald', 'amber', 'rose', 'slate', 'dark'];
const DEFAULT_SETTINGS = { company: '', taxId: '', logo: '', theme: 'indigo' };
const MAX_JSON = 1.5 * 1024 * 1024; // cota prudente de cuerpo JSON

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_JSON) return null;
  try { return JSON.parse(text); } catch (_) { return undefined; }
}

async function loadDb(env) {
  const raw = await env.HORARIOS.get(DB_KEY);
  if (raw) {
    try {
      const db = JSON.parse(raw);
      if (!Array.isArray(db.archive)) db.archive = [];
      return db;
    } catch (e) {
      console.error('DB corrupta, se inicia limpia:', e.message);
    }
  }
  return { people: [], schedule: {}, settings: {}, archive: [] };
}

async function saveDb(env, db) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await env.HORARIOS.get(DB_KEY);
  if (existing) {
    // Respaldo diario: una copia por día, se conservan las últimas 30
    const backupKey = BACKUP_PREFIX + today;
    const hasBackup = await env.HORARIOS.get(backupKey);
    if (!hasBackup) {
      await env.HORARIOS.put(backupKey, existing);
      const { keys } = await env.HORARIOS.list({ prefix: BACKUP_PREFIX });
      const old = keys.filter(k => !k.name.endsWith(today)).sort().map(k => k.name);
      while (old.length > KEEP_BACKUPS - 1) await env.HORARIOS.delete(old.shift());
    }
  }
  await env.HORARIOS.put(DB_KEY, JSON.stringify(db));
}

// ---------- Router manual de /api/* ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const db = await loadDb(env);
    const { pathname } = url;
    const seg = pathname.split('/'); // /api/people/:id[/reinstate]
    const pathId = seg[3] || '';
    const queryId = url.searchParams.get('id') || '';

    try {
      // ---- Personal ----
      if (pathname === '/api/people' && request.method === 'GET') {
        return json(db.people || []);
      }

      if (pathname === '/api/people' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body) return json({ error: 'Cuerpo JSON demasiado grande o inválido' }, 400);
        const name = String(body.name || '').trim();
        if (!name) return json({ error: 'El nombre es obligatorio' }, 400);
        const person = {
          id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          name,
          role: String(body.role || '').trim(),
          phone: String(body.phone || '').replace(/[^\d+]/g, ''),
          status: 'active',
        };
        db.people.push(person);
        await saveDb(env, db);
        return json(person, 201);
      }

      // Editar: /api/people/:id o { id } en el cuerpo
      if (seg[2] === 'people' && pathId && request.method === 'PUT') {
        const body = await readJson(request);
        if (!body) return json({ error: 'Cuerpo JSON demasiado grande o inválido' }, 400);
        const p = db.people.find(x => x.id === pathId);
        if (!p) return json({ error: 'Persona no encontrada' }, 404);
        if (body.name !== undefined) p.name = String(body.name).trim() || p.name;
        if (body.role !== undefined) p.role = String(body.role).trim();
        if (body.phone !== undefined) p.phone = String(body.phone).replace(/[^\d+]/g, '');
        if (body.status !== undefined && PERSON_STATUS.includes(body.status)) p.status = body.status;
        await saveDb(env, db);
        return json(p);
      }

      // Retirar: /api/people/:id o ?id= — pasa al historial con snapshot de sus turnos
      if (seg[2] === 'people' && (pathId || queryId) && request.method === 'DELETE') {
        const pid = pathId || queryId;
        const idx = db.people.findIndex(x => x.id === pid);
        if (idx === -1) return json({ error: 'Persona no encontrada' }, 404);
        const person = db.people.splice(idx, 1)[0];
        const shiftsHistory = {};
        for (const [week, shifts] of Object.entries(db.schedule || {})) {
          if (shifts[person.id]) shiftsHistory[week] = shifts[person.id];
        }
        db.archive.push({ ...person, status: 'retired', retiredAt: new Date().toISOString(), shiftsHistory });
        for (const week of Object.values(db.schedule || {})) {
          delete week[person.id];
        }
        await saveDb(env, db);
        return json({ ok: true, retired: person.name, semanasGuardadas: Object.keys(shiftsHistory).length });
      }

      // ---- Historial ----
      if (pathname === '/api/archive' && request.method === 'GET') {
        return json((db.archive || []).map(({ shiftsHistory, ...rest }) => ({
          ...rest,
          weeks: Object.keys(shiftsHistory || {}).length,
        })));
      }

      // Reintegrar: /api/archive/:id/reinstate o /api/archive?id=...
      if (seg[2] === 'archive' && request.method === 'POST' && (pathId || queryId)) {
        const pid = pathId || queryId;
        const idx = db.archive.findIndex(x => x.id === pid);
        if (idx === -1) return json({ error: 'No está en el historial' }, 404);
        const entry = db.archive.splice(idx, 1)[0];
        const { shiftsHistory, retiredAt, ...person } = entry;
        person.status = 'active';
        db.people.push(person);
        db.schedule = db.schedule || {};
        for (const [week, days] of Object.entries(shiftsHistory || {})) {
          db.schedule[week] = db.schedule[week] || {};
          db.schedule[week][person.id] = days;
        }
        await saveDb(env, db);
        return json({ ok: true, person });
      }

      // ---- Horario ----
      if (pathname === '/api/schedule' && request.method === 'GET') {
        const week = url.searchParams.get('week');
        if (!week) return json({ error: 'Falta el parámetro week' }, 400);
        return json({ week, shifts: (db.schedule && db.schedule[week]) || {} });
      }

      if (pathname === '/api/schedule' && request.method === 'PUT') {
        const body = await readJson(request);
        if (!body || !body.week || typeof body.shifts !== 'object' || body.shifts === null) {
          return json({ error: 'Faltan datos (week, shifts)' }, 400);
        }
        db.schedule = db.schedule || {};
        db.schedule[body.week] = body.shifts;
        await saveDb(env, db);
        return json({ ok: true, week: body.week });
      }

      // ---- Ajustes ----
      if (pathname === '/api/settings' && request.method === 'GET') {
        return json({ ...DEFAULT_SETTINGS, ...(db.settings || {}) });
      }

      if (pathname === '/api/settings' && request.method === 'PUT') {
        const body = await readJson(request);
        if (!body) return json({ error: 'Cuerpo JSON demasiado grande o inválido' }, 400);
        const prev = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
        db.settings = {
          company: body.company !== undefined ? String(body.company).trim().slice(0, 60) : prev.company,
          taxId: body.taxId !== undefined ? String(body.taxId).trim().slice(0, 40) : prev.taxId,
          logo: body.logo !== undefined ? String(body.logo).slice(0, 300000) : prev.logo,
          theme: THEMES.includes(body.theme) ? body.theme : prev.theme,
        };
        await saveDb(env, db);
        return json(db.settings);
      }

      // ---- Respaldo ----
      if (pathname === '/api/backup' && request.method === 'GET') {
        return json({ ...db, settings: { ...DEFAULT_SETTINGS, ...(db.settings || {}) } });
      }

      if (pathname === '/api/restore' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body || !Array.isArray(body.people) || typeof body.schedule !== 'object') {
          return json({ error: 'Archivo de respaldo no válido' }, 400);
        }
        if (!Array.isArray(body.archive)) body.archive = db.archive || [];
        await saveDb(env, body);
        return json({ ok: true });
      }

      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (e) {
      console.error('Error del Worker:', e.message);
      return json({ error: 'Error interno del Worker' }, 500);
    }
  },
};
