var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var DB_KEY = "db";
var BACKUP_PREFIX = "backup:";
var KEEP_BACKUPS = 30;
var PERSON_STATUS = ["active", "suspended", "retired", "vacation", "leave"];
var THEMES = ["indigo", "emerald", "amber", "rose", "slate", "dark"];
var DEFAULT_SETTINGS = { company: "", taxId: "", logo: "", theme: "indigo" };
var MAX_JSON = 1.5 * 1024 * 1024;
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8" }
}), "json");
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_JSON) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return void 0;
  }
}
__name(readJson, "readJson");
async function loadDb(env) {
  const raw = await env.HORARIOS.get(DB_KEY);
  if (raw) {
    try {
      const db = JSON.parse(raw);
      if (!Array.isArray(db.archive)) db.archive = [];
      return db;
    } catch (e) {
      console.error("DB corrupta, se inicia limpia:", e.message);
    }
  }
  return { people: [], schedule: {}, settings: {}, archive: [] };
}
__name(loadDb, "loadDb");
async function saveDb(env, db) {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const existing = await env.HORARIOS.get(DB_KEY);
  if (existing) {
    const backupKey = BACKUP_PREFIX + today;
    const hasBackup = await env.HORARIOS.get(backupKey);
    if (!hasBackup) {
      await env.HORARIOS.put(backupKey, existing);
      const { keys } = await env.HORARIOS.list({ prefix: BACKUP_PREFIX });
      const old = keys.filter((k) => !k.name.endsWith(today)).sort().map((k) => k.name);
      while (old.length > KEEP_BACKUPS - 1) await env.HORARIOS.delete(old.shift());
    }
  }
  await env.HORARIOS.put(DB_KEY, JSON.stringify(db));
}
__name(saveDb, "saveDb");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    const db = await loadDb(env);
    const { pathname } = url;
    const seg = pathname.split("/");
    const pathId = seg[3] || "";
    const queryId = url.searchParams.get("id") || "";
    try {
      if (pathname === "/api/people" && request.method === "GET") {
        return json(db.people || []);
      }
      if (pathname === "/api/people" && request.method === "POST") {
        const body = await readJson(request);
        if (!body) return json({ error: "Cuerpo JSON demasiado grande o inv\xE1lido" }, 400);
        const name = String(body.name || "").trim();
        if (!name) return json({ error: "El nombre es obligatorio" }, 400);
        const person = {
          id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          name,
          role: String(body.role || "").trim(),
          phone: String(body.phone || "").replace(/[^\d+]/g, ""),
          status: "active"
        };
        db.people.push(person);
        await saveDb(env, db);
        return json(person, 201);
      }
      if (seg[2] === "people" && pathId && request.method === "PUT") {
        const body = await readJson(request);
        if (!body) return json({ error: "Cuerpo JSON demasiado grande o inv\xE1lido" }, 400);
        const p = db.people.find((x) => x.id === pathId);
        if (!p) return json({ error: "Persona no encontrada" }, 404);
        if (body.name !== void 0) p.name = String(body.name).trim() || p.name;
        if (body.role !== void 0) p.role = String(body.role).trim();
        if (body.phone !== void 0) p.phone = String(body.phone).replace(/[^\d+]/g, "");
        if (body.status !== void 0 && PERSON_STATUS.includes(body.status)) p.status = body.status;
        await saveDb(env, db);
        return json(p);
      }
      if (seg[2] === "people" && (pathId || queryId) && request.method === "DELETE") {
        const pid = pathId || queryId;
        const idx = db.people.findIndex((x) => x.id === pid);
        if (idx === -1) return json({ error: "Persona no encontrada" }, 404);
        const person = db.people.splice(idx, 1)[0];
        const shiftsHistory = {};
        for (const [week, shifts] of Object.entries(db.schedule || {})) {
          if (shifts[person.id]) shiftsHistory[week] = shifts[person.id];
        }
        db.archive.push({ ...person, status: "retired", retiredAt: (/* @__PURE__ */ new Date()).toISOString(), shiftsHistory });
        for (const week of Object.values(db.schedule || {})) {
          delete week[person.id];
        }
        await saveDb(env, db);
        return json({ ok: true, retired: person.name, semanasGuardadas: Object.keys(shiftsHistory).length });
      }
      if (pathname === "/api/archive" && request.method === "GET") {
        return json((db.archive || []).map(({ shiftsHistory, ...rest }) => ({
          ...rest,
          weeks: Object.keys(shiftsHistory || {}).length
        })));
      }
      if (seg[2] === "archive" && request.method === "POST" && (pathId || queryId)) {
        const pid = pathId || queryId;
        const idx = db.archive.findIndex((x) => x.id === pid);
        if (idx === -1) return json({ error: "No est\xE1 en el historial" }, 404);
        const entry = db.archive.splice(idx, 1)[0];
        const { shiftsHistory, retiredAt, ...person } = entry;
        person.status = "active";
        db.people.push(person);
        db.schedule = db.schedule || {};
        for (const [week, days] of Object.entries(shiftsHistory || {})) {
          db.schedule[week] = db.schedule[week] || {};
          db.schedule[week][person.id] = days;
        }
        await saveDb(env, db);
        return json({ ok: true, person });
      }
      if (pathname === "/api/schedule" && request.method === "GET") {
        const week = url.searchParams.get("week");
        if (!week) return json({ error: "Falta el par\xE1metro week" }, 400);
        return json({ week, shifts: db.schedule && db.schedule[week] || {} });
      }
      if (pathname === "/api/schedule" && request.method === "PUT") {
        const body = await readJson(request);
        if (!body || !body.week || typeof body.shifts !== "object" || body.shifts === null) {
          return json({ error: "Faltan datos (week, shifts)" }, 400);
        }
        db.schedule = db.schedule || {};
        db.schedule[body.week] = body.shifts;
        await saveDb(env, db);
        return json({ ok: true, week: body.week });
      }
      if (pathname === "/api/settings" && request.method === "GET") {
        return json({ ...DEFAULT_SETTINGS, ...db.settings || {} });
      }
      if (pathname === "/api/settings" && request.method === "PUT") {
        const body = await readJson(request);
        if (!body) return json({ error: "Cuerpo JSON demasiado grande o inv\xE1lido" }, 400);
        const prev = { ...DEFAULT_SETTINGS, ...db.settings || {} };
        db.settings = {
          company: body.company !== void 0 ? String(body.company).trim().slice(0, 60) : prev.company,
          taxId: body.taxId !== void 0 ? String(body.taxId).trim().slice(0, 40) : prev.taxId,
          logo: body.logo !== void 0 ? String(body.logo).slice(0, 3e5) : prev.logo,
          theme: THEMES.includes(body.theme) ? body.theme : prev.theme
        };
        await saveDb(env, db);
        return json(db.settings);
      }
      if (pathname === "/api/backup" && request.method === "GET") {
        return json({ ...db, settings: { ...DEFAULT_SETTINGS, ...db.settings || {} } });
      }
      if (pathname === "/api/restore" && request.method === "POST") {
        const body = await readJson(request);
        if (!body || !Array.isArray(body.people) || typeof body.schedule !== "object") {
          return json({ error: "Archivo de respaldo no v\xE1lido" }, 400);
        }
        if (!Array.isArray(body.archive)) body.archive = db.archive || [];
        await saveDb(env, body);
        return json({ ok: true });
      }
      return json({ error: "Ruta no encontrada" }, 404);
    } catch (e) {
      console.error("Error del Worker:", e.message);
      return json({ error: "Error interno del Worker" }, 500);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-CeAIlB/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-CeAIlB/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
