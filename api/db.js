// API do banco de dados do site (Vercel + Neon Postgres).
// Guarda tudo numa tabela "docs" (coleção, id, dados em JSON), no mesmo formato que a página já usava.
// Login feito aqui no servidor: a senha é conferida com o hash PBKDF2 e a resposta traz um token assinado.
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const URL_DB = process.env.HANGAR_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const sql = URL_DB ? neon(URL_DB) : null;
const SEGREDO = process.env.SESSION_SECRET || crypto.createHash("sha256").update("hangar-os:" + URL_DB).digest();
const SESSAO_HORAS = 12;
const COLECOES = new Set(["solicitacoes", "notas", "config", "usuarios"]);
const CAMPOS_SENHA = new Set(["salt", "iter", "hash", "trocarSenha", "senhaTrocadaEm"]);

let pronto = null;
const iniciar = () => (pronto ??= sql`create table if not exists docs (
  coll text not null, id text not null, data jsonb not null,
  atualizado timestamptz not null default now(), primary key (coll, id))`);

class Erro extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const b64u = b => Buffer.from(b).toString("base64url");
const assinar = txt => crypto.createHmac("sha256", SEGREDO).update(txt).digest("base64url");
function criarToken(email) {
  const corpo = b64u(JSON.stringify({ email, ate: Date.now() + SESSAO_HORAS * 36e5 }));
  return corpo + "." + assinar(corpo);
}
function lerToken(cabecalho) {
  const t = String(cabecalho || "").replace(/^Bearer\s+/i, "");
  const [corpo, sig] = t.split(".");
  if (!corpo || !sig) return null;
  const esperado = assinar(corpo);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try { const p = JSON.parse(Buffer.from(corpo, "base64url").toString()); return p.ate > Date.now() ? p.email : null; } catch { return null; }
}
function hashSenha(senha, salt, iter) {
  return crypto.pbkdf2Sync(String(senha), Buffer.from(salt, "base64"), iter, 32, "sha256").toString("base64");
}
const iguais = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function lerDoc(coll, id) {
  const r = await sql`select data from docs where coll = ${coll} and id = ${id}`;
  return r[0]?.data ?? null;
}
async function gravarDoc(coll, id, data) {
  await sql`insert into docs (coll, id, data) values (${coll}, ${id}, ${JSON.stringify(data)}::jsonb)
    on conflict (coll, id) do update set data = excluded.data, atualizado = now()`;
}
// conta sem os dados de senha
const limpo = u => { if (!u) return u; const { hash, salt, iter, ...resto } = u; return resto; };
const gestor = u => u?.papel === "admin" || u?.papel === "dev";

async function rota(b, auth) {
  const op = b.op;
  if (op === "ping") return { ok: true };

  if (op === "login") {
    const email = String(b.email || "").trim().toLowerCase();
    const u = email ? await lerDoc("usuarios", email) : null;
    if (!u || !u.hash || !iguais(hashSenha(b.senha || "", u.salt, u.iter), u.hash)) throw new Erro(401, "E-mail ou senha incorretos.");
    return { token: criarToken(email), user: limpo(u) };
  }

  const email = lerToken(auth);
  const eu = email ? await lerDoc("usuarios", email) : null;
  if (!eu) throw new Erro(401, "Sessão expirada. Entre de novo.");
  if (op === "me") return { user: limpo(eu) };

  const coll = String(b.c || "");
  if (!COLECOES.has(coll)) throw new Erro(400, "Coleção inválida.");
  const id = b.id == null ? null : String(b.id);
  if (op !== "list" && (!id || id.length > 200 || id.includes("/"))) throw new Erro(400, "Documento inválido.");
  const ehUsuarios = coll === "usuarios";

  if (op === "list") {
    if (ehUsuarios && !gestor(eu)) throw new Erro(403, "Só administradores veem a equipe.");
    const r = await sql`select id, data from docs where coll = ${coll}`;
    let docs = r.map(x => ({ id: x.id, data: ehUsuarios ? limpo(x.data) : x.data }));
    if (b.ord?.f) {
      const f = b.ord.f, s = b.ord.dir === "desc" ? -1 : 1;
      docs.sort((a, c) => ((a.data?.[f] ?? 0) > (c.data?.[f] ?? 0) ? 1 : (a.data?.[f] ?? 0) < (c.data?.[f] ?? 0) ? -1 : 0) * s);
    }
    return { docs };
  }

  if (op === "get") {
    if (ehUsuarios && id !== email && !gestor(eu)) throw new Erro(403, "Sem permissão.");
    const d = await lerDoc(coll, id);
    return { data: ehUsuarios ? limpo(d) : d };
  }

  if (op === "set" || op === "update") {
    if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) throw new Erro(400, "Dados inválidos.");
    const atual = await lerDoc(coll, id);
    let novo = op === "update" ? { ...(atual || {}), ...b.data } : b.data;
    if (ehUsuarios) {
      if (!gestor(eu)) {
        // quem não é administrador só pode trocar a própria senha
        if (id !== email || op !== "update" || Object.keys(b.data).some(k => !CAMPOS_SENHA.has(k)) || b.data.trocarSenha !== false)
          throw new Erro(403, "Sem permissão para alterar contas.");
      } else {
        if (atual?.papel === "dev" && eu.papel !== "dev") throw new Erro(403, "Só um desenvolvedor pode alterar uma conta de desenvolvedor.");
        if (novo.papel === "dev" && atual?.papel !== "dev" && eu.papel !== "dev") {
          const devs = await sql`select 1 from docs where coll = 'usuarios' and data->>'papel' = 'dev' limit 1`;
          if (devs.length) throw new Erro(403, "Só um desenvolvedor pode criar outra conta de desenvolvedor.");
        }
        if (id === email && novo.papel !== eu.papel) throw new Erro(403, "Você não pode mudar o próprio perfil.");
        // os dados de senha só mudam quando vêm na gravação; senão ficam os atuais
        if (atual && !b.data.hash) novo = { ...novo, salt: atual.salt, iter: atual.iter, hash: atual.hash };
      }
      novo.email = id;
    }
    await gravarDoc(coll, id, novo);
    return { ok: true };
  }

  if (op === "delete") {
    if (!gestor(eu)) throw new Erro(403, "Só administradores podem excluir.");
    if (ehUsuarios) {
      if (id === email) throw new Erro(403, "Você não pode remover a própria conta.");
      const alvo = await lerDoc(coll, id);
      if (alvo?.papel === "dev" && eu.papel !== "dev") throw new Erro(403, "Só um desenvolvedor pode remover uma conta de desenvolvedor.");
    }
    await sql`delete from docs where coll = ${coll} and id = ${id}`;
    return { ok: true };
  }

  throw new Erro(400, "Operação desconhecida.");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // GET só diz se o banco está ligado (para conferir a configuração na Vercel)
  if (req.method === "GET") return res.status(200).json({ banco: sql ? "ligado" : "não configurado" });
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
  if (!sql) return res.status(503).json({ erro: "Banco de dados não configurado no Vercel.", code: 503 });
  try {
    await iniciar();
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    res.status(200).json(await rota(b, req.headers.authorization));
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ erro: e.status ? e.message : "Erro no servidor.", code: e.status || 500 });
  }
}
