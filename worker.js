// Worker de Cloudflare — API del gestor de horarios con base de datos en KV.
// El frontend (public/) se sirve como Static Assets; las rutas /api/* las maneja este Worker.

const DB_KEY = 'db';                 // base viva
const BACKUP_PREFIX = 'backup:';     // backup:YYYY-MM-DD
const KEEP_BACKUPS = 30;

const PERSON_STATUS = ['active', 'suspended', 'retired', 'vacation', 'leave'];
const THEMES = ['indigo', 'emerald', 'amber', 'rose', 'slate', 'dark'];
const DEFAULT_SETTINGS = { company: '', taxId: '', logo: '', theme: 'indigo', imgBand: '#f6a821', imgInk: '#111827', imgLine: '#cbd5e1', imgAreaHeaders: true };
const isValidHexColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const ROLES = ['admin', 'editor', 'viewer'];
const MAX_JSON = 1.5 * 1024 * 1024; // cota prudente de cuerpo JSON
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 días

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
      if (!Array.isArray(db.users)) db.users = [];
      if (!Array.isArray(db.sessions)) db.sessions = [];
      return db;
    } catch (e) {
      console.error('DB corrupta, se inicia limpia:', e.message);
    }
  }
  return { people: [], schedule: {}, settings: {}, archive: [], users: [], sessions: [] };
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

// ================= AUTENTICACIÓN Y AUTORIZACIÓN =================

// PBKDF2-SHA256 con salt (Web Crypto estándar de Workers)
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = hexToBytes(saltHex);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, keyMaterial, 256);
  return bytesToHex(new Uint8Array(bits));
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, chips: u.chips || null });

const findUser = (db, username) => {
  const q = String(username || '').trim().toLowerCase();
  return db.users.find(u => u.username.toLowerCase() === q);
};

// Crea el usuario inicial solo si aún no existe ninguno (el PRIMERO es admin)
async function ensureInitialAdmin(env, db) {
  if (db.users.length) return db;
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  db.users.push({
    id: 'u' + bytesToHex(crypto.getRandomValues(new Uint8Array(6))),
    username: 'admin',
    salt,
    hash: await hashPassword('admin123', salt),
    role: 'admin',
    createdAt: new Date().toISOString(),
  });
  await saveDb(env, db);
  return db;
}

// Middleware: valida el token Bearer y devuelve { user } o { error: Response }
async function authenticate(request, env, db) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { error: json({ error: 'No autenticado. Inicia sesión.' }, 401) };
  const s = db.sessions.find(x => x.token === token);
  if (!s) return { error: json({ error: 'Sesión inválida. Inicia sesión de nuevo.' }, 401) };
  if (Date.now() > s.expiresAt) {
    db.sessions = db.sessions.filter(x => x.token !== token);
    await saveDb(env, db);
    return { error: json({ error: 'Sesión expirada. Inicia sesión de nuevo.' }, 401) };
  }
  const user = db.users.find(u => u.id === s.userId);
  if (!user) return { error: json({ error: 'Usuario no encontrado. Inicia sesión de nuevo.' }, 401) };
  return { db, user };
}

// Autorización por rol: authorize(user, 'admin') o authorize(user, 'admin', 'editor')
function authorize(user, ...roles) {
  return roles.includes(user.role) ? null : json({ error: 'No tienes permisos para esta acción' }, 403);
}

// ---------- Router manual de /api/* ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const db = await ensureInitialAdmin(env, await loadDb(env));
    const { pathname } = url;
    const seg = pathname.split('/'); // /api/people/:id[/reinstate]
    const pathId = seg[3] || '';
    const queryId = url.searchParams.get('id') || '';

    try {
    // ---- Autenticación: /api/auth/* y todas las demás rutas ----
    const token = (request.headers.get('Authorization') || '').startsWith('Bearer ')
      ? request.headers.get('Authorization').slice(7)
      : null;

    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await readJson(request);
      const user = body ? findUser(db, body.username) : null;
      let ok = false;
      if (user) {
        const attempt = await hashPassword(String(body.password || ''), user.salt);
        ok = attempt === user.hash; // comparación constante, PBKDF2 depende de la contraseña
      }
      if (!ok) return json({ error: 'Usuario o contraseña incorrectos' }, 401);
      const newToken = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      db.sessions.push({ token: newToken, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
      db.sessions = db.sessions.filter(s => s.expiresAt > Date.now()); // limpieza de sesiones vencidas
      await saveDb(env, db);
      return json({ token: newToken, user: publicUser(user) });
    }

    const auth = await authenticate(request, env, db);
    if (auth.error) return auth.error;
    const user = auth.user;

    // Cerrar sesión
    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      db.sessions = db.sessions.filter(s => s.token !== token);
      await saveDb(env, db);
      return json({ ok: true });
    }

    // ---- Gestión de usuarios (solo admin) ----
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      return json({ user: publicUser(user) });
    }

    // Chips favoritos del propio usuario: { chips: [{start,end}|null x6] }
    if (pathname === '/api/auth/chips' && request.method === 'PUT') {
      const body = await readJson(request);
      const raw = Array.isArray(body && body.chips) ? body.chips : [];
      if (raw.length > 6) return json({ error: 'Máximo 6 chips' }, 400);
      const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
      let chips;
      try {
        chips = raw.slice(0, 6).map((c, i) => {
          if (!c || typeof c !== 'object') return null; // fila vacía
          const start = String(c.start || ''), end = String(c.end || '');
          if (!start && !end) return null; // fila vacía
          if (!HHMM.test(start) || !HHMM.test(end)) throw new Error(`Chip ${i + 1}: horas incompletas o inválidas`);
          if (end <= start) throw new Error(`Chip ${i + 1}: la salida debe ser mayor a la entrada`);
          return { start, end };
        });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
      while (chips.length < 6) chips.push(null);
      if (!chips.some(Boolean)) return json({ error: 'Deja al menos un chip con entrada y salida' }, 400);
      user.chips = chips;
      await saveDb(env, db);
      return json({ ok: true, chips: user.chips });
    }

    if (pathname === '/api/auth/users' && request.method === 'GET') {
      const denied = authorize(user, 'admin');
      if (denied) return denied;
      return json(db.users.map(publicUser));
    }

    if (pathname === '/api/auth/users' && request.method === 'POST') {
      const denied = authorize(user, 'admin');
      if (denied) return denied;
      const body = await readJson(request);
      if (!body) return json({ error: 'Cuerpo JSON demasiado grande o inválido' }, 400);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const role = ROLES.includes(body.role) ? body.role : 'viewer';
      if (!username || username.length < 3) return json({ error: 'El usuario debe tener al menos 3 caracteres' }, 400);
      if (!/^[a-zA-Z0-9._-]+$/.test(username)) return json({ error: 'El usuario solo admite letras, números, punto, guion y guion bajo' }, 400);
      if (password.length < 6) return json({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400);
      if (findUser(db, username)) return json({ error: 'Ese usuario ya existe' }, 409);
      const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      db.users.push({
        id: 'u' + bytesToHex(crypto.getRandomValues(new Uint8Array(6))),
        username,
        salt,
        hash: await hashPassword(password, salt),
        role,
        createdAt: new Date().toISOString(),
      });
      await saveDb(env, db);
      return json(publicUser(db.users[db.users.length - 1]), 201);
    }

    if (seg[2] === 'auth' && seg[3] === 'users' && (seg[4] || queryId) && request.method === 'PUT') {
      const denied = authorize(user, 'admin');
      if (denied) return denied;
      const body = await readJson(request);
      if (!body) return json({ error: 'Cuerpo JSON demasiado grande o inválido' }, 400);
      const target = db.users.find(u => u.id === (seg[4] || queryId));
      if (!target) return json({ error: 'Usuario no encontrado' }, 404);
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return json({ error: 'Rol no válido' }, 400);
        if (target.role === 'admin' && body.role !== 'admin' && db.users.filter(u => u.role === 'admin').length === 1) {
          return json({ error: 'No puedes quitar el rol al último admin' }, 400);
        }
        target.role = body.role;
      }
      if (body.password !== undefined) {
        const password = String(body.password);
        if (password.length < 6) return json({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400);
        target.salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
        target.hash = await hashPassword(password, target.salt);
      }
      await saveDb(env, db);
      return json(publicUser(target));
    }

    if (seg[2] === 'auth' && seg[3] === 'users' && (seg[4] || queryId) && request.method === 'DELETE') {
      const denied = authorize(user, 'admin');
      if (denied) return denied;
      const target = db.users.find(u => u.id === (seg[4] || queryId));
      if (!target) return json({ error: 'Usuario no encontrado' }, 404);
      if (target.id === user.id) return json({ error: 'No puedes eliminar tu propio usuario con la sesión activa' }, 400);
      if (target.role === 'admin' && db.users.filter(u => u.role === 'admin').length === 1) {
        return json({ error: 'No puedes eliminar al último admin' }, 400);
      }
      db.users = db.users.filter(u => u.id !== target.id);
      db.sessions = db.sessions.filter(s => s.userId !== target.id);
      await saveDb(env, db);
      return json({ ok: true });
    }

    // ---- Personal ----
    if (pathname === '/api/people' && request.method === 'GET') {
      return json(db.people || []);
    }

    if (pathname === '/api/people' && request.method === 'POST') {
      const denied = authorize(user, 'admin', 'editor');
      if (denied) return denied;
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
        const denied = authorize(user, 'admin', 'editor');
        if (denied) return denied;
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
        const denied = authorize(user, 'admin');
        if (denied) return denied;
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
        const denied = authorize(user, 'admin', 'editor');
        if (denied) return denied;
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
        const denied = authorize(user, 'admin', 'editor');
        if (denied) return denied;
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
        const denied = authorize(user, 'admin', 'editor');
        if (denied) return denied;
        const body = await readJson(request);
        if (!body) return json({ error: 'Cuerpo JSON demasiado grande o inválido' }, 400);
        const prev = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
        db.settings = {
          company: body.company !== undefined ? String(body.company).trim().slice(0, 60) : prev.company,
          taxId: body.taxId !== undefined ? String(body.taxId).trim().slice(0, 40) : prev.taxId,
          logo: body.logo !== undefined ? String(body.logo).slice(0, 300000) : prev.logo,
          theme: THEMES.includes(body.theme) ? body.theme : prev.theme,
          imgBand: isValidHexColor(body.imgBand) ? body.imgBand.toLowerCase() : prev.imgBand,
          imgInk: isValidHexColor(body.imgInk) ? body.imgInk.toLowerCase() : prev.imgInk,
          imgLine: isValidHexColor(body.imgLine) ? body.imgLine.toLowerCase() : prev.imgLine,
          imgAreaHeaders: body.imgAreaHeaders !== undefined ? body.imgAreaHeaders === true : prev.imgAreaHeaders,
        };
        await saveDb(env, db);
        return json(db.settings);
      }

      // ---- Respaldo ----
      if (pathname === '/api/backup' && request.method === 'GET') {
        const denied = authorize(user, 'admin');
        if (denied) return denied;
        const { sessions: _sessions, ...safeDb } = db; // los tokens de sesión no se exportan
        return json({ ...safeDb, settings: { ...DEFAULT_SETTINGS, ...(db.settings || {}) } });
      }

      if (pathname === '/api/restore' && request.method === 'POST') {
        const denied = authorize(user, 'admin');
        if (denied) return denied;
        const body = await readJson(request);
        if (!body || !Array.isArray(body.people) || typeof body.schedule !== 'object') {
          return json({ error: 'Archivo de respaldo no válido' }, 400);
        }
        if (!Array.isArray(body.archive)) body.archive = db.archive || [];
        // La autenticación nunca se pisa con un respaldo viejo
        body.users = db.users || [];
        body.sessions = db.sessions || [];
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
