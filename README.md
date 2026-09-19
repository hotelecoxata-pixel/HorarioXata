# 🗓 Gestor de Horarios — ECOXATA

Aplicación web para armar el horario semanal de tu empresa y compartirlo por WhatsApp. Funciona igual de bien en **PC** que en **celular**.

## ✨ Funciones

- **Interfaz con menú lateral** (☰): Horario (página de inicio), Personal y Ajustes.
- **Horario semanal** con horas exactas de entrada y salida por persona y día.
- **Chips rápidos** al asignar turno: 6:00–15:00, 7:00–16:00, 11:00–20:00, 12:00–21:00 y 3:00–10:00.
- **Condiciones especiales por día**: 🏖️ Vacaciones, ✅ Disponible y 🤒 Incapacidad (reemplazan la entrada/salida y no cuentan como días trabajados en el resumen mensual).
- Navegación entre semanas (◀ ▶) y botón «Semana actual».
- **Personal**: añadir, editar, suspender, reactivar, poner vacaciones, marcar incapacidad y retirar.
- Los **suspendidos** aparecen con aviso ⚠️ en el horario.
- **🗄️ Historial de retirados**: al retirar a alguien, sus ficha y turnos pasados se guardan en la base de datos; puedes **reintegrarlo** con un toque y recupera todo.
- **Base de datos local** (`data/db.json`) que acumula todo: personal activo, todas las semanas de horario guardadas, configuración e historial de retirados. **Respaldo automático diario** en `data/backups/` (se conservan los últimos 30).
- **Compartir por WhatsApp**:
  - **WhatsApp individual**: botón «💬 WhatsApp individual» → lista del personal; al tocar una persona se abre su WhatsApp con su horario listo (de una en una).
  - Mensaje individual también desde 👥 → ⋮ → «WhatsApp directo».
  - «📋 Copiar lista» para pegar la semana completa en cualquier chat.
- **📷 Imagen**: de la semana completa o de un solo día (selector de día en el modal) para compartir al grupo.
- **📊 Resumen mensual** de días programados por quincena; las condiciones especiales se muestran aparte y no suman días.
- **Respaldo**: descarga todos los datos en un archivo JSON y restáuralos cuando quieras.
- **⚙️ Ajustes**: nombre de la empresa, foto (logo) e ID fiscal — se ven en el menú y en las imágenes que compartes.
- **🎨 Temas de color**: índigo, esmeralda, ámbar, rosa, pizarra y oscuro (nocturno). Se guardan en la base y se aplican en todos los dispositivos.

## ☁️ App en internet (Cloudflare Workers)

La app está desplegada y disponible **24/7** en:

**https://horarioxata.yasser26ah.workers.dev**

- Funciona desde PC y celular, sin estar en el mismo Wi-Fi.
- La base de datos vive en **Cloudflare KV** (con respaldo diario automático, últimos 30 días) — no depende de tu PC.
- Para redesplegar tras cambios: `npx wrangler deploy` (requiere `wrangler login`).
- Configuración del Worker: `wrangler.jsonc` (assets estáticos + binding KV `HORARIOS`); código del backend en la nube: `worker.js`.
- La versión local (`npm start`) sigue funcionando con su propia base en `data/db.json`; son bases independientes.
- **Nota:** desde el 2026-09-19 el Worker vive en la cuenta de `yasser26ah@gmail.com` (la cuenta anterior de ECOXATA conserva los datos históricos en su propio KV). Esta base arrancó vacía: entra con `admin / admin123` y cámbiala enseguida.

## 🚀 Cómo usarla en tu PC

```bash
npm install
npm start
```

Abre `http://localhost:3000` en tu navegador. Para usarla desde el celular **en el mismo Wi-Fi**, abre `http://IP-DE-TU-PC:3000` (la IP se muestra al arrancar el servidor).

> 💡 Los datos se guardan en `data/db.json` en tu PC: un solo punto de verdad para todos los dispositivos.

## ☁️ Cómo ponerla en internet (acceso desde cualquier lugar)

1. Sube este proyecto a un repositorio de GitHub.
2. Crea una cuenta gratis en [Render](https://render.com) y elige **New → Web Service**.
3. Conecta tu repositorio. Configuración:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Render te dará una URL tipo `https://tu-app.onrender.com` — ábrela desde la PC o el celular.

> ⚠️ En el plan gratis de Render el servicio se duerme por inactividad y el archivo de datos puede reiniciarse en re-despliegues. Usa el botón «💾 Descargar respaldo» con frecuencia, o pide ayuda para configurar un disco persistente.

## 🔒 Seguridad — Usuarios, login y roles

La app ahora está protegida con inicio de sesión obligatorio y control de acceso por roles.

**Primer acceso:**

- **Usuario:** `admin`
- **Contraseña:** `admin123`

> ⚠️ Cambia esta contraseña enseguida: entra con admin → ☰ → 🔐 Usuarios → 🔑 → escribe la nueva.

**Roles y permisos:**

| Rol | Puede |
|---|---|
| 👑 **Administrador** | Todo: personal, horario, ajustes, respaldos y **gestionar usuarios** (crear, cambiar rol/contraseña, eliminar) |
| ✏️ **Editor** | Gestionar personal y horario, y guardar ajustes. No ve usuarios ni respaldos ni puede retirar personal |
| 👀 **Solo ver** | Consultar horario y personal. Ningún botón de edición aparece |

**Cómo funciona:**

- Al abrir la app aparece la **pantalla de login**; sin sesión no se ve ningún dato.
- La sesión dura **30 días** en el mismo navegador (token Bearer guardado en la sesión de la pestaña).
- El backend valida el token y el rol en **cada petición** (lo que ve la UI es solo el reflejo del permiso real).
- Las contraseñas se guardan con **hash + salt** (scrypt local / PBKDF2 en la nube), nunca en texto plano.
- Al cerrar sesión (🚪 en la cabecera) el token se invalida en el servidor.
- Funciona igual en el servidor local (`server.js`) que en Cloudflare (`worker.js`).
- Los respaldos ya no incluyen usuarios ni sesiones: al restaurar no se rompe el acceso.

## 📁 Estructura

```
├── server.js         # Servidor Express local + API (usa data/db.json)
├── worker.js         # Worker de Cloudflare para el despliegue en internet (usa KV)
├── wrangler.jsonc    # Configuración del despliegue (assets + KV)
├── public/
│   ├── index.html    # Interfaz
│   ├── style.css     # Estilos responsive (PC y móvil)
│   └── app.js        # Lógica del frontend (compartida por local y nube)
├── data/
│   ├── db.json       # Base de datos local (se crea sola)
│   └── backups/      # Respaldo automático diario local (últimos 30 días)
└── package.json
```
