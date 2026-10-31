// Servidor de turnos de Mai Alisados — Node + Express + PostgreSQL (Railway)
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Maia123";
const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error("Falta la variable DATABASE_URL. Agregá PostgreSQL en Railway y referenciala.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes("railway.internal") || DB_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// dias: días cerrados / turnos activos · turnos: reservas · config: horarios · clientes: base de clientas
const COLLS = ["dias", "turnos", "config", "clientes"];
const ID_RE = {
  dias: /^\d{4}-\d{2}-\d{2}$/,
  turnos: /^\d{4}-\d{2}-\d{2}_t[123]$/,
  config: /^(horarios|precios)$/,
  clientes: /^c\d{6,16}$/,
};
const SOLO_ADMIN_LECTURA = ["clientes"];
const TRATAMIENTOS = ["keratin", "nano", "botox", "anti"];
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// Minutos que tiene la clienta para cancelar sola después de reservar (después, por WhatsApp)
const CANCELAR_MINUTOS = 20;
const isAdmin = (req) => req.get("x-admin") === ADMIN_PASSWORD;
const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const soloDigitos = (v, max) => String(v || "").replace(/\D/g, "").slice(0, max);

// Las clientas solo ven que un horario está ocupado; nombre y teléfono solo los ve la administradora o la dueña del turno
function visible(coll, data, req) {
  if (coll !== "turnos" || isAdmin(req)) return data;
  const uid = String(req.query.uid || "");
  if (uid && data.uid === uid) return data;
  return { fecha: data.fecha, slot: data.slot, hora: data.hora };
}

function checkParams(req, res) {
  const { coll, id } = req.params;
  if (!COLLS.includes(coll)) { res.status(404).json({ error: "colección inválida" }); return false; }
  if (id !== undefined && !ID_RE[coll].test(id)) { res.status(400).json({ error: "id inválido" }); return false; }
  if (SOLO_ADMIN_LECTURA.includes(coll) && !isAdmin(req)) { res.status(403).json({ error: "solo administradora" }); return false; }
  return true;
}

// ---------- Página y librerías ----------
// La página de turnos se sirve desde el mismo servidor: abrí la URL de Railway y listo
app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(__dirname, "index.html")));
// Librerías para generar los PDF (se instalan con npm, no dependen de otro sitio)
const NM = path.join(__dirname, "node_modules");
app.get("/vendor/jspdf.js", (req, res) => res.sendFile(path.join(NM, "jspdf", "dist", "jspdf.umd.min.js")));
app.get("/vendor/autotable.js", (req, res) => res.sendFile(path.join(NM, "jspdf-autotable", "dist", "jspdf.plugin.autotable.min.js")));

app.get("/api/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  await new Promise((r) => setTimeout(r, 400)); // frena intentos repetidos
  res.json({ ok: (req.body && req.body.password) === ADMIN_PASSWORD });
});

// ---------- Importar clientas en lote (administradora) ----------
app.post("/api/clientes/import", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "solo administradora" });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 2000) : [];
  let ok = 0;
  try {
    for (const it of items) {
      const c = limpiarCliente(it);
      if (!c) continue;
      await pool.query(
        `INSERT INTO docs (coll, id, data) VALUES ('clientes', $1, $2)
         ON CONFLICT (coll, id) DO UPDATE SET data = docs.data || jsonb_build_object('nombre', $3::text, 'tel', $4::text), updated = now()`,
        ["c" + c.wa, c, c.nombre, c.tel]
      );
      ok++;
    }
    res.json({ ok: true, cargadas: ok });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Listar una colección ----------
// turnos: por defecto desde hace 60 días. La administradora puede pedir un rango: ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
app.get("/api/:coll", async (req, res) => {
  if (!checkParams(req, res)) return;
  const coll = req.params.coll;
  try {
    let rows;
    if (coll === "turnos" && isAdmin(req) && FECHA_RE.test(req.query.desde || "") && FECHA_RE.test(req.query.hasta || "")) {
      ({ rows } = await pool.query(
        "SELECT id, data FROM docs WHERE coll = 'turnos' AND id >= $1 AND id < $2 ORDER BY id",
        [req.query.desde, req.query.hasta + "_z"]
      ));
    } else {
      ({ rows } = await pool.query(
        "SELECT id, data FROM docs WHERE coll = $1 AND (coll <> 'turnos' OR id >= $2) ORDER BY id",
        [coll, haceDias(60)]
      ));
    }
    res.json(rows.map((r) => ({ id: r.id, data: visible(coll, r.data, req) })));
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Leer un documento ----------
app.get("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  try {
    const { rows } = await pool.query("SELECT data FROM docs WHERE coll = $1 AND id = $2", [req.params.coll, req.params.id]);
    if (!rows.length) return res.json({ exists: false, data: null });
    res.json({ exists: true, data: visible(req.params.coll, rows[0].data, req) });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Guardar un documento ----------
app.put("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  const { coll, id } = req.params;
  const d = req.body || {};
  try {
    if (coll === "dias") {
      if (!isAdmin(req)) return res.status(403).json({ error: "solo administradora" });
      await upsert(coll, id, { cerrado: !!d.cerrado, t1: !!d.t1, t2: !!d.t2, t3: !!d.t3 });
      return res.json({ ok: true });
    }

    if (coll === "config") {
      if (!isAdmin(req)) return res.status(403).json({ error: "solo administradora" });
      if (id === "precios") {
        await upsert(coll, id, limpiarPrecios(d));
        return res.json({ ok: true });
      }
      const data = {};
      for (const k of ["t1", "t2", "t3"]) {
        const lista = Array.isArray(d[k]) ? d[k].filter((h) => HORA_RE.test(h)) : [];
        data[k] = [...new Set(lista)].sort().slice(0, 16);
      }
      await upsert(coll, id, data);
      return res.json({ ok: true });
    }

    if (coll === "clientes") {
      const c = limpiarCliente(d);
      if (!c || "c" + c.wa !== id) return res.status(400).json({ error: "datos incompletos" });
      await pool.query(
        `INSERT INTO docs (coll, id, data) VALUES ('clientes', $1, $2)
         ON CONFLICT (coll, id) DO UPDATE SET data = docs.data || $2, updated = now()`,
        [id, c]
      );
      return res.json({ ok: true });
    }

    // turnos
    if (!str(d.nombre, 80) || !str(d.tel, 40) || !str(d.hora, 5) || !str(d.uid, 60)) {
      return res.status(400).json({ error: "datos incompletos" });
    }
    const data = {
      fecha: id.slice(0, 10), slot: id.slice(11), hora: d.hora.slice(0, 5),
      nombre: d.nombre.trim(), tel: d.tel.trim(), wa: soloDigitos(d.wa, 20),
      trat: TRATAMIENTOS.includes(d.trat) ? d.trat : "",
      hid: !!d.hid,
      lang: d.lang === "es" ? "es" : "en", uid: d.uid,
      estado: d.estado === "pendiente" ? "pendiente" : "confirmado", ts: Date.now(),
    };

    if (isAdmin(req)) {
      await upsert(coll, id, data);
    } else {
      // Clienta: solo puede reservar un horario libre
      data.estado = "confirmado";
      const r = await pool.query(
        "INSERT INTO docs (coll, id, data) VALUES ($1, $2, $3) ON CONFLICT (coll, id) DO NOTHING",
        [coll, id, data]
      );
      if (r.rowCount === 0) return res.status(409).json({ error: "horario ocupado" });
      avisarPorMail(data); // aviso a la administradora (no frena la reserva si falla)
    }
    await guardarClienteDeTurno(data);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Borrar ----------
app.delete("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  const { coll, id } = req.params;
  try {
    if (!isAdmin(req)) {
      if (coll !== "turnos") return res.status(403).json({ error: "solo administradora" });
      const { rows } = await pool.query("SELECT data FROM docs WHERE coll = $1 AND id = $2", [coll, id]);
      if (!rows.length) return res.json({ ok: true });
      if (rows[0].data.uid !== String(req.query.uid || "")) return res.status(403).json({ error: "no es tu turno" });
      if (Date.now() - Number(rows[0].data.ts || 0) > CANCELAR_MINUTOS * 60000) return res.status(403).json({ error: "plazo vencido" });
    }
    await pool.query("DELETE FROM docs WHERE coll = $1 AND id = $2", [coll, id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Ayudas ----------
// Lista de precios editable por la administradora (textos en español e inglés)
function txt(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
function limpiarPrecios(d) {
  d = d || {};
  const par = (o, max) => ({ es: txt(o && o.es, max), en: txt(o && o.en, max) });
  const filas = (Array.isArray(d.filas) ? d.filas : []).slice(0, 12)
    .map((f) => ({ es: txt(f && f.es, 80), en: txt(f && f.en, 80), p: txt(f && f.p, 24) }))
    .filter((f) => f.es || f.en || f.p);
  const extras = (Array.isArray(d.extras) ? d.extras : []).slice(0, 8)
    .map((x) => ({ es: txt(x && x.es, 100), en: txt(x && x.en, 100), p: txt(x && x.p, 30), des: txt(x && x.des, 600), den: txt(x && x.den, 600) }))
    .filter((x) => x.es || x.en || x.p || x.des || x.den);
  return { nota: par(d.nota, 400), filas, extras, promo: par(d.promo, 1500) };
}
function limpiarCliente(d) {
  d = d || {};
  const wa = soloDigitos(d.wa || d.tel, 16);
  if (!str(d.nombre, 80) || wa.length < 6) return null;
  const c = { nombre: d.nombre.trim(), tel: str(d.tel, 40) ? d.tel.trim() : "+" + wa, wa };
  if (typeof d.notas === "string") c.notas = d.notas.trim().slice(0, 500);
  return c;
}

// Cada reserva suma (o actualiza) a la clienta en la base, sin pisar las notas que haya cargado la administradora
async function guardarClienteDeTurno(t) {
  if (!t.wa || t.wa.length < 6) return;
  try {
    await pool.query(
      `INSERT INTO docs (coll, id, data) VALUES ('clientes', $1, $2)
       ON CONFLICT (coll, id) DO UPDATE SET data = docs.data || jsonb_build_object('ultimo', $3::text), updated = now()`,
      ["c" + t.wa, { nombre: t.nombre, tel: t.tel, wa: t.wa, ultimo: t.fecha, origen: "reserva" }, t.fecha]
    );
  } catch (e) { console.error("No se pudo guardar la clienta:", e.message); }
}

// ---------- Aviso por mail de cada reserva nueva (Resend) ----------
// Variables en Railway: RESEND_API_KEY (obligatoria) y AVISO_EMAIL (opcional, por defecto el mail de Maia)
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const AVISO_EMAIL = (process.env.AVISO_EMAIL || "mapi9221@gmail.com").trim().toLowerCase();
const AVISO_DESDE = process.env.AVISO_DESDE || "Mai Alisados <onboarding@resend.dev>";
const NOMBRES_TRAT = { keratin: "Organic Keratin", nano: "Nanoplastia", botox: "Botox", anti: "Anti-frizz Treatment" };
const DIAS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function fechaLarga(f) {
  const [y, m, d] = f.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DIAS_ES[dt.getDay()]} ${d} de ${MESES_ES[m - 1]}`;
}

async function avisarPorMail(t) {
  if (!RESEND_API_KEY) { console.log("Aviso por mail desactivado: falta RESEND_API_KEY"); return; }
  const trat = NOMBRES_TRAT[t.trat] ? NOMBRES_TRAT[t.trat] + (t.hid ? " + Hidratación" : "") : "Sin especificar";
  const fecha = fechaLarga(t.fecha);
  const fila = (k, v) => `<tr><td style="padding:10px 0;color:#76666b;width:120px;vertical-align:top">${k}</td><td style="padding:10px 0;color:#2a2226;font-weight:600">${v}</td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;background:#f8f1ec;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#fffdfb;border-radius:18px;overflow:hidden;border:1px solid #eddcd4">
    <div style="background:#33262c;padding:22px 24px;color:#e4c58c;font-family:Georgia,serif;font-size:22px;font-style:italic">Mai Alisados</div>
    <div style="padding:24px">
      <div style="font-size:18px;color:#2a2226;margin-bottom:6px">💖 ¡Nueva cita reservada!</div>
      <div style="color:#76666b;font-size:14px;margin-bottom:12px">Una clienta acaba de agendarse desde la página.</div>
      <table style="width:100%;border-collapse:collapse;font-size:15px;border-top:1px solid #eddcd4">
        ${fila("Clienta", escHtml(t.nombre))}
        ${fila("Fecha", escHtml(fecha))}
        ${fila("Hora", escHtml(t.hora))}
        ${fila("Tratamiento", escHtml(trat))}
        ${fila("Teléfono", escHtml(t.tel))}
      </table>
      ${t.wa ? `<a href="https://wa.me/${t.wa}" style="display:inline-block;margin-top:18px;background:#9c4a60;color:#fff;text-decoration:none;padding:12px 22px;border-radius:99px;font-weight:600">Escribirle por WhatsApp</a>` : ""}
    </div>
  </div></div>`;
  const text = `Nueva cita reservada\n\nClienta: ${t.nombre}\nFecha: ${fecha}\nHora: ${t.hora}\nTratamiento: ${trat}\nTeléfono: ${t.tel}\n${t.wa ? "WhatsApp: https://wa.me/" + t.wa : ""}`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: AVISO_DESDE, to: [AVISO_EMAIL], subject: `Nueva cita: ${t.nombre} · ${fecha} ${t.hora}`, html, text }),
    });
    if (!r.ok) console.error("Resend respondió", r.status, await r.text());
    else console.log("Aviso por mail enviado a", AVISO_EMAIL);
  } catch (e) { console.error("No se pudo enviar el aviso por mail:", e.message); }
}

function upsert(coll, id, data) {
  return pool.query(
    "INSERT INTO docs (coll, id, data, updated) VALUES ($1, $2, $3, now()) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated = now()",
    [coll, id, data]
  );
}

function haceDias(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

async function start() {
  await pool.query(`CREATE TABLE IF NOT EXISTS docs (
    coll text NOT NULL,
    id text NOT NULL,
    data jsonb NOT NULL,
    updated timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (coll, id)
  )`);
  // Las clientas de turnos que ya existían se suman a la base
  await pool.query(`INSERT INTO docs (coll, id, data)
    SELECT 'clientes', 'c' || (data->>'wa'), jsonb_build_object('nombre', data->>'nombre', 'tel', data->>'tel', 'wa', data->>'wa', 'ultimo', max(data->>'fecha') OVER (PARTITION BY data->>'wa'), 'origen', 'reserva')
    FROM docs WHERE coll = 'turnos' AND coalesce(data->>'wa', '') ~ '^\\d{6,16}$'
    ON CONFLICT (coll, id) DO NOTHING`);
  app.listen(PORT, () => console.log("Servidor de turnos escuchando en el puerto " + PORT));
}

start().catch((e) => { console.error("No se pudo iniciar:", e); process.exit(1); });
