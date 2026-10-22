// Servidor de turnos de Mai Alisados — Node + Express + PostgreSQL (Railway)
const express = require("express");
const cors = require("cors");
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
app.use(express.json({ limit: "50kb" }));

const COLLS = ["dias", "turnos"];
const ID_RE = {
  dias: /^\d{4}-\d{2}-\d{2}$/,
  turnos: /^\d{4}-\d{2}-\d{2}_t[123]$/,
};

const isAdmin = (req) => req.get("x-admin") === ADMIN_PASSWORD;

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
  return true;
}

const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

// La página de turnos se sirve desde el mismo servidor: abrí la URL de Railway y listo
const path = require("path");
app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/api/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  await new Promise((r) => setTimeout(r, 400)); // frena intentos repetidos
  res.json({ ok: (req.body && req.body.password) === ADMIN_PASSWORD });
});

// Listar una colección
app.get("/api/:coll", async (req, res) => {
  if (!checkParams(req, res)) return;
  try {
    const { rows } = await pool.query(
      "SELECT id, data FROM docs WHERE coll = $1 AND (coll <> 'turnos' OR id >= $2) ORDER BY id",
      [req.params.coll, haceDias(60)]
    );
    res.json(rows.map((r) => ({ id: r.id, data: visible(req.params.coll, r.data, req) })));
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// Leer un documento
app.get("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  try {
    const { rows } = await pool.query("SELECT data FROM docs WHERE coll = $1 AND id = $2", [req.params.coll, req.params.id]);
    if (!rows.length) return res.json({ exists: false, data: null });
    res.json({ exists: true, data: visible(req.params.coll, rows[0].data, req) });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// Guardar un documento
app.put("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  const { coll, id } = req.params;
  const d = req.body || {};
  try {
    if (coll === "dias") {
      if (!isAdmin(req)) return res.status(403).json({ error: "solo administradora" });
      const data = { cerrado: !!d.cerrado, t1: !!d.t1, t2: !!d.t2, t3: !!d.t3 };
      await upsert(coll, id, data);
      return res.json({ ok: true });
    }

    // turnos
    if (!str(d.nombre, 80) || !str(d.tel, 40) || !str(d.hora, 5) || !str(d.uid, 60)) {
      return res.status(400).json({ error: "datos incompletos" });
    }
    const data = {
      fecha: id.slice(0, 10), slot: id.slice(11), hora: d.hora.slice(0, 5),
      nombre: d.nombre.trim(), tel: d.tel.trim(), wa: String(d.wa || "").replace(/\D/g, "").slice(0, 20),
      trat: ["keratin", "nano", "botox", "anti"].includes(d.trat) ? d.trat : "",
      hid: !!d.hid,
      lang: d.lang === "es" ? "es" : "en", uid: d.uid,
      estado: d.estado === "pendiente" ? "pendiente" : "confirmado", ts: Date.now(),
    };

    if (isAdmin(req)) { await upsert(coll, id, data); return res.json({ ok: true }); }

    // Clienta: solo puede reservar un horario libre
    data.estado = "confirmado";
    const r = await pool.query(
      "INSERT INTO docs (coll, id, data) VALUES ($1, $2, $3) ON CONFLICT (coll, id) DO NOTHING",
      [coll, id, data]
    );
    if (r.rowCount === 0) return res.status(409).json({ error: "horario ocupado" });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// Borrar (cancelar un turno)
app.delete("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  const { coll, id } = req.params;
  try {
    if (!isAdmin(req)) {
      if (coll !== "turnos") return res.status(403).json({ error: "solo administradora" });
      const { rows } = await pool.query("SELECT data FROM docs WHERE coll = $1 AND id = $2", [coll, id]);
      if (!rows.length) return res.json({ ok: true });
      if (rows[0].data.uid !== String(req.query.uid || "")) return res.status(403).json({ error: "no es tu turno" });
    }
    await pool.query("DELETE FROM docs WHERE coll = $1 AND id = $2", [coll, id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

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
  app.listen(PORT, () => console.log("Servidor de turnos escuchando en el puerto " + PORT));
}

start().catch((e) => { console.error("No se pudo iniciar:", e); process.exit(1); });
