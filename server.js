// Servidor del gestor de horarios
// Guarda los datos en data/db.json y sirve la app web en /public

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 30; // respaldos diarios conservados

// ---------- Utilidades de datos ----------

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!Array.isArray(db.archive)) db.archive = []; // historial de retirados (migración)
      return db;
    }
  } catch (e) {
    console.error('Error leyendo la base de datos:', e.message);
  }
  return { people: [], schedule: {}, settings: {}, archive: [] };
}

function saveDb(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  dailyBackup();
}

// Respaldo automático: una copia por día en data/backups/, se conservan las últimas 30
function dailyBackup() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUP_DIR, `db-${today}.json`);
    if (fs.existsSync(file)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DB_FILE, file);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) {
    console.error('Respaldo diario falló:', e.message);
  }
}

// ---------- Middleware ----------

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API: Personal ----------

app.get('/api/people', (req, res) => {
  const db = loadDb();
  res.json(db.people || []);
});

const PERSON_STATUS = ['active', 'suspended', 'retired', 'vacation', 'leave'];

// Crear persona: { name, role, phone }
app.post('/api/people', (req, res) => {
  const db = loadDb();
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });

  const person = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    role: (req.body.role || '').trim(),
    phone: (req.body.phone || '').replace(/[^\d+]/g, ''),
    status: 'active' // active | suspended | retired | vacation | leave
  };
  db.people.push(person);
  saveDb(db);
  res.status(201).json(person);
});

// Editar persona: { name?, role?, phone?, status? }
app.put('/api/people/:id', (req, res) => {
  const db = loadDb();
  const p = db.people.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Persona no encontrada' });

  if (req.body.name !== undefined) p.name = String(req.body.name).trim() || p.name;
  if (req.body.role !== undefined) p.role = String(req.body.role).trim();
  if (req.body.phone !== undefined) p.phone = String(req.body.phone).replace(/[^\d+]/g, '');
  if (req.body.status !== undefined && PERSON_STATUS.includes(req.body.status)) {
    p.status = req.body.status;
  }
  saveDb(db);
  res.json(p);
});

// Retirar persona: pasa al historial con todos sus turnos guardados (recuperable)
app.delete('/api/people/:id', (req, res) => {
  const db = loadDb();
  const idx = db.people.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Persona no encontrada' });
  const person = db.people.splice(idx, 1)[0];

  // Snapshot de todos sus turnos en todas las semanas
  const shiftsHistory = {};
  for (const [week, shifts] of Object.entries(db.schedule || {})) {
    if (shifts[person.id]) shiftsHistory[week] = shifts[person.id];
  }
  db.archive.push({
    ...person,
    status: 'retired',
    retiredAt: new Date().toISOString(),
    shiftsHistory,
  });

  // Quitar sus turnos del horario activo
  for (const week of Object.values(db.schedule || {})) {
    delete week[person.id];
  }
  saveDb(db);
  res.json({ ok: true, retired: person.name, semanasGuardadas: Object.keys(shiftsHistory).length });
});

// ---------- API: Historial (personal retirado) ----------

app.get('/api/archive', (req, res) => {
  const db = loadDb();
  res.json((db.archive || []).map(({ shiftsHistory, ...rest }) => ({
    ...rest,
    weeks: Object.keys(shiftsHistory || {}).length,
  })));
});

// Reintegrar: vuelve al personal activo con status activo y recupera sus turnos
app.post('/api/archive/:id/reinstate', (req, res) => {
  const db = loadDb();
  const idx = db.archive.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No está en el historial' });
  const entry = db.archive.splice(idx, 1)[0];
  const { shiftsHistory, retiredAt, ...person } = entry;
  person.status = 'active';
  db.people.push(person);

  db.schedule = db.schedule || {};
  for (const [week, days] of Object.entries(shiftsHistory || {})) {
    db.schedule[week] = db.schedule[week] || {};
    db.schedule[week][person.id] = days;
  }
  saveDb(db);
  res.json({ ok: true, person });
});

// ---------- API: Horario ----------

// Estructura: schedule[weekKey][personId] = { "0": "08:00-16:00", ... "6": "..." }
// weekKey = año-Wsemana, ej: "2026-W38"

// Obtener semana: /api/schedule?week=2026-W38 (el frontend siempre envía week)
app.get('/api/schedule', (req, res) => {
  const week = req.query.week;
  if (!week) return res.status(400).json({ error: 'Falta el parámetro week' });
  const db = loadDb();
  res.json({ week, shifts: (db.schedule && db.schedule[week]) || {} });
});

// Guardar semana: { week, shifts: { personId: { "0": "08:00-16:00", ... } } }
app.put('/api/schedule', (req, res) => {
  const { week, shifts } = req.body || {};
  if (!week || typeof shifts !== 'object' || shifts === null) {
    return res.status(400).json({ error: 'Faltan datos (week, shifts)' });
  }
  const db = loadDb();
  db.schedule = db.schedule || {};
  db.schedule[week] = shifts;
  saveDb(db);
  res.json({ ok: true, week });
});

// ---------- Configuración ----------

app.get('/api/settings', (req, res) => {
  const db = loadDb();
  res.json(db.settings || { company: '' });
});

app.put('/api/settings', (req, res) => {
  const db = loadDb();
  db.settings = Object.assign({}, db.settings, {
    company: String((req.body && req.body.company) || '').trim()
  });
  saveDb(db);
  res.json(db.settings);
});

// ---------- Respaldo ----------

app.get('/api/backup', (req, res) => {
  const db = loadDb();
  res.setHeader('Content-Disposition', 'attachment; filename="horario-respaldo.json"');
  res.json(db);
});

// Restaurar respaldo: enviar el JSON completo como body.
// Si el respaldo es viejo (sin historial), se conserva el historial actual.
app.post('/api/restore', (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.people) || typeof body.schedule !== 'object') {
    return res.status(400).json({ error: 'Archivo de respaldo no válido' });
  }
  if (!Array.isArray(body.archive)) body.archive = loadDb().archive || [];
  saveDb(body);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ Gestor de horarios corriendo en http://localhost:${PORT}`);
  console.log(`   Desde el celular: http://IP-DE-TU-PC:${PORT}`);
});
