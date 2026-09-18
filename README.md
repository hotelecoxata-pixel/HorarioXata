# 🗓 Gestor de Horarios — ECOXATA

Aplicación web para armar el horario semanal de tu empresa y compartirlo por WhatsApp. Funciona igual de bien en **PC** que en **celular**.

## ✨ Funciones

- **Horario semanal** con horas exactas de entrada y salida por persona y día.
- **Chips rápidos** al asignar turno: 6:00–15:00, 7:00–16:00, 11:00–20:00, 12:00–21:00 y 3:00–10:00.
- **Condiciones especiales por día**: 🏖️ Vacaciones, ✅ Disponible y 🤒 Incapacidad (reemplazan la entrada/salida y no cuentan como días trabajados en el resumen mensual).
- Navegación entre semanas (◀ ▶) y botón «Semana actual».
- **Personal**: añadir, editar, suspender, reactivar, poner vacaciones, marcar incapacidad y retirar.
- Los **suspendidos** aparecen con aviso ⚠️ en el horario; los retirados se eliminan con todo su historial.
- **Compartir por WhatsApp**:
  - **WhatsApp individual**: botón «💬 WhatsApp individual» → lista del personal; al tocar una persona se abre su WhatsApp con su horario listo (de una en una).
  - Mensaje individual también desde 👥 → ⋮ → «WhatsApp directo».
  - «📋 Copiar lista» para pegar la semana completa en cualquier chat.
- **📷 Imagen**: de la semana completa o de un solo día (selector de día en el modal) para compartir al grupo.
- **📊 Resumen mensual** de días programados por quincena; las condiciones especiales se muestran aparte y no suman días.
- **Respaldo**: descarga todos los datos en un archivo JSON y restáuralos cuando quieras.
- Nombre de la empresa configurable (⚙️) — aparece en el título y en los mensajes.

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

## 🔒 Seguridad (opcional pero recomendado)

Esta app no tiene contraseña. Si la pones en internet, cualquier persona con el enlace podría ver/modificar el horario. Opciones sencillas:

- Comparte la URL solo con tu personal de confianza.
- Pide que se agregue protección con usuario/contraseña (puedo añadirlo si lo necesitas).

## 📁 Estructura

```
├── server.js         # Servidor Express + API (personal, horario, ajustes, respaldo)
├── public/
│   ├── index.html    # Interfaz
│   ├── style.css     # Estilos responsive (PC y móvil)
│   └── app.js        # Lógica del frontend
├── data/db.json      # Base de datos (se crea sola)
└── package.json
```
