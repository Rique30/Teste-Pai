// API do banco de dados do site (Vercel + Neon Postgres).
// Guarda tudo numa tabela "docs" (coleção, id, dados em JSON), no mesmo formato que a página já usava.
// Login feito aqui no servidor: a senha é conferida com o hash PBKDF2 e a resposta traz um token assinado.
// Segurança: as senhas só são transformadas em hash aqui no servidor, o login bloqueia depois de várias
// tentativas erradas, quem está com senha provisória só pode trocar a senha e trocar/resetar a senha
// derruba as sessões abertas daquela conta.
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const URL_DB = process.env.HANGAR_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const sql = URL_DB ? neon(URL_DB) : null;
const SEGREDO = process.env.SESSION_SECRET || crypto.createHash("sha256").update("hangar-os:" + URL_DB).digest();
const SESSAO_HORAS = 12;
const COLECOES = new Set(["solicitacoes", "notas", "config", "usuarios"]);
// campos de senha e sessão: só o servidor grava; o que vier da página é ignorado
const CAMPOS_SENHA = ["salt", "iter", "hash", "trocarSenha", "senhaTrocadaEm", "sessaoVer"];
const ITER = 600000; // PBKDF2-SHA256, como recomenda a OWASP
const SENHA_MIN = 8, PROVISORIA_MIN = 10;
// bloqueio do login: 5 erros seguidos no mesmo e-mail ou 30 no mesmo aparelho/rede → 15 minutos parado
const MAX_ERROS_EMAIL = 5, MAX_ERROS_IP = 30, BLOQUEIO_MIN = 15;
const DOC_MAX = 500 * 1024; // tamanho máximo de um registro (OS, nota...)

let pronto = null;
const iniciar = () => (pronto ??= (async () => {
  await sql`create table if not exists docs (
    coll text not null, id text not null, data jsonb not null,
    atualizado timestamptz not null default now(), primary key (coll, id))`;
  // arquivos anexados às notas fiscais (PDF ou foto)
  await sql`create table if not exists anexos (
    id text primary key, nome text not null, tipo text not null, tamanho integer not null,
    dados bytea not null, por text, criado timestamptz not null default now())`;
  // tentativas de login erradas, por e-mail e por IP
  await sql`create table if not exists tentativas (
    chave text primary key, falhas integer not null default 0,
    desde timestamptz not null default now(), bloqueado_ate timestamptz)`;
})());
const ANEXO_MAX = 3 * 1024 * 1024; // 3 MB (o limite de envio da Vercel é 4,5 MB, e o arquivo vai em base64)
const TIPOS_ANEXO = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

class Erro extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const b64u = b => Buffer.from(b).toString("base64url");
const assinar = txt => crypto.createHmac("sha256", SEGREDO).update(txt).digest("base64url");
function criarToken(email, v = 0) {
  const corpo = b64u(JSON.stringify({ email, v, ate: Date.now() + SESSAO_HORAS * 36e5 }));
  return corpo + "." + assinar(corpo);
}
function lerToken(cabecalho) {
  const t = String(cabecalho || "").replace(/^Bearer\s+/i, "");
  const [corpo, sig] = t.split(".");
  if (!corpo || !sig) return null;
  const esperado = assinar(corpo);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try { const p = JSON.parse(Buffer.from(corpo, "base64url").toString()); return p.ate > Date.now() ? { email: p.email, v: p.v || 0 } : null; } catch { return null; }
}
function hashSenha(senha, salt, iter) {
  return crypto.pbkdf2Sync(String(senha), Buffer.from(salt, "base64"), iter, 32, "sha256").toString("base64");
}
// senha nova: salt aleatório e hash feito aqui
function novaSenha(senha) {
  const salt = crypto.randomBytes(16).toString("base64");
  return { salt, iter: ITER, hash: hashSenha(senha, salt, ITER) };
}
const SALT_FALSO = crypto.randomBytes(16).toString("base64");
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

// Banco novo, sem nenhuma conta: o primeiro acesso usa o e-mail e a senha das variáveis
// HANGAR_ADMIN_EMAIL e HANGAR_ADMIN_SENHA da Vercel e cria um administrador com senha provisória.
async function primeiroAdmin(email, senha) {
  const e = String(process.env.HANGAR_ADMIN_EMAIL || "").trim().toLowerCase(), s = String(process.env.HANGAR_ADMIN_SENHA || "");
  if (!e || s.length < PROVISORIA_MIN || email !== e || !iguais(senha, s)) return null;
  const algum = await sql`select 1 from docs where coll = 'usuarios' limit 1`;
  if (algum.length) return null;
  const u = { email, nome: "Administrador", papel: "admin", ...novaSenha(s), trocarSenha: true, sessaoVer: 1, criadoEm: new Date().toISOString(), criadoPor: "primeiro acesso" };
  await gravarDoc("usuarios", email, u);
  return u;
}

// --- bloqueio de tentativas de login ---
async function conferirBloqueio(chaves) {
  const r = await sql`select 1 from tentativas where chave = any(${chaves}) and bloqueado_ate > now() limit 1`;
  if (r.length) throw new Erro(429, `Muitas tentativas erradas. Espere ${BLOQUEIO_MIN} minutos e tente de novo.`);
}
async function registrarErro(chave, max) {
  const r = await sql`insert into tentativas (chave, falhas, desde) values (${chave}, 1, now())
    on conflict (chave) do update set
      falhas = case when tentativas.desde < now() - make_interval(mins => ${BLOQUEIO_MIN}) then 1 else tentativas.falhas + 1 end,
      desde = case when tentativas.desde < now() - make_interval(mins => ${BLOQUEIO_MIN}) then now() else tentativas.desde end
    returning falhas`;
  if (r[0].falhas >= max)
    await sql`update tentativas set falhas = 0, desde = now(), bloqueado_ate = now() + make_interval(mins => ${BLOQUEIO_MIN}) where chave = ${chave}`;
}
const limparErros = chave => sql`delete from tentativas where chave = ${chave}`;
// confere a senha com proteção contra tentativas repetidas; sem conta, faz o mesmo trabalho para não revelar se o e-mail existe
async function conferirSenha(email, senha, u, ip) {
  const chaves = ["e:" + email, "i:" + ip];
  await conferirBloqueio(chaves);
  const certo = u?.hash ? iguais(hashSenha(senha, u.salt, u.iter), u.hash) : (hashSenha(senha, SALT_FALSO, ITER), false);
  if (!certo) {
    await registrarErro(chaves[0], MAX_ERROS_EMAIL); await registrarErro(chaves[1], MAX_ERROS_IP);
    return false;
  }
  await limparErros(chaves[0]);
  return true;
}
function validarSenha(senha, min) {
  senha = String(senha || "");
  if (senha.length < min) throw new Erro(400, `A senha precisa ter pelo menos ${min} caracteres.`);
  if (senha.length > 200) throw new Erro(400, "A senha é longa demais.");
  return senha;
}

async function rota(b, auth, ip) {
  const op = b.op;
  if (op === "ping") return { ok: true };

  if (op === "login") {
    const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
    const senha = String(b.senha || "").slice(0, 200);
    if (!email || !senha) throw new Erro(401, "E-mail ou senha incorretos.");
    let u = await lerDoc("usuarios", email);
    if (!u) u = await primeiroAdmin(email, senha);
    if (!(await conferirSenha(email, senha, u, ip))) throw new Erro(401, "E-mail ou senha incorretos.");
    // senha antiga com hash mais fraco: refaz com o padrão atual
    if (u.iter < ITER) { u = { ...u, ...novaSenha(senha) }; await gravarDoc("usuarios", email, u); }
    return { token: criarToken(email, u.sessaoVer || 0), user: limpo(u) };
  }

  const sessao = lerToken(auth);
  const email = sessao?.email;
  const eu = email ? await lerDoc("usuarios", email) : null;
  // conta removida, senha trocada ou resetada: o token antigo deixa de valer
  if (!eu || (eu.sessaoVer || 0) !== sessao.v) throw new Erro(401, "Sessão expirada. Entre de novo.");
  if (op === "me") return { user: limpo(eu) };

  if (op === "definirSenha") {
    const nova = validarSenha(b.senha, SENHA_MIN);
    if (!(await conferirSenha(email, String(b.senhaAtual || "").slice(0, 200), eu, ip))) throw new Erro(401, "A senha atual não confere.");
    if (iguais(hashSenha(nova, eu.salt, eu.iter), eu.hash)) throw new Erro(400, "Escolha uma senha diferente da atual.");
    const novo = { ...eu, ...novaSenha(nova), trocarSenha: false, senhaTrocadaEm: new Date().toISOString(), sessaoVer: (eu.sessaoVer || 0) + 1 };
    await gravarDoc("usuarios", email, novo);
    return { token: criarToken(email, novo.sessaoVer), user: limpo(novo) };
  }
  // com a senha provisória, a conta só pode trocar a senha
  if (eu.trocarSenha) throw new Erro(403, "Troque a senha provisória antes de continuar.");

  if (op === "anexar") {
    const tipo = String(b.tipo || ""), nome = String(b.nome || "arquivo").slice(0, 200);
    if (!TIPOS_ANEXO.has(tipo)) throw new Erro(400, "Envie um PDF ou uma foto (JPG, PNG ou WEBP).");
    const dados = Buffer.from(String(b.dados || ""), "base64");
    if (!dados.length) throw new Erro(400, "O arquivo está vazio.");
    if (dados.length > ANEXO_MAX) throw new Erro(413, "O arquivo passa de 3 MB. Envie um arquivo menor.");
    const id = "a" + crypto.randomUUID().replace(/-/g, "");
    await sql`insert into anexos (id, nome, tipo, tamanho, dados, por) values (${id}, ${nome}, ${tipo}, ${dados.length}, decode(${dados.toString("base64")}, 'base64'), ${email})`;
    return { anexo: { id, nome, tipo, tamanho: dados.length } };
  }
  if (op === "baixarAnexo") {
    const r = await sql`select nome, tipo, encode(dados, 'base64') as dados from anexos where id = ${String(b.id || "")}`;
    if (!r.length) throw new Erro(404, "Arquivo não encontrado.");
    return r[0];
  }
  if (op === "excluirAnexo") {
    const r = await sql`select por from anexos where id = ${String(b.id || "")}`;
    if (!r.length) return { ok: true };
    if (!gestor(eu) && r[0].por !== email) throw new Erro(403, "Só quem anexou ou um administrador pode remover o arquivo.");
    await sql`delete from anexos where id = ${String(b.id || "")}`;
    return { ok: true };
  }

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
    if (JSON.stringify(b.data).length > DOC_MAX) throw new Erro(413, "Registro grande demais.");
    const atual = await lerDoc(coll, id);
    let novo = op === "update" ? { ...(atual || {}), ...b.data } : b.data;
    if (ehUsuarios) {
      // a própria senha é trocada pela operação definirSenha; contas só os administradores alteram
      if (!gestor(eu)) throw new Erro(403, "Sem permissão para alterar contas.");
      {
        const { senhaProvisoria, ...resto } = b.data;
        novo = op === "update" ? { ...(atual || {}), ...resto } : resto;
        // dados de senha e sessão nunca vêm da página: ficam os atuais
        for (const k of CAMPOS_SENHA) { if (atual && k in atual) novo[k] = atual[k]; else delete novo[k]; }
        if (senhaProvisoria != null) {
          // conta nova ou senha resetada: o servidor faz o hash e derruba as sessões abertas
          Object.assign(novo, novaSenha(validarSenha(senhaProvisoria, PROVISORIA_MIN)), { trocarSenha: true, sessaoVer: (atual?.sessaoVer || 0) + 1 });
        } else if (!atual) throw new Erro(400, "Informe a senha provisória da conta nova.");
        if (atual?.papel === "dev" && eu.papel !== "dev") throw new Erro(403, "Só um desenvolvedor pode alterar uma conta de desenvolvedor.");
        if (novo.papel === "dev" && atual?.papel !== "dev" && eu.papel !== "dev") {
          const devs = await sql`select 1 from docs where coll = 'usuarios' and data->>'papel' = 'dev' limit 1`;
          if (devs.length) throw new Erro(403, "Só um desenvolvedor pode criar outra conta de desenvolvedor.");
        }
        if (id === email && novo.papel !== eu.papel) throw new Erro(403, "Você não pode mudar o próprio perfil.");
        if (!["operador", "admin", "dev"].includes(novo.papel)) novo.papel = "operador";
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
    const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
    res.status(200).json(await rota(b, req.headers.authorization, ip));
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ erro: e.status ? e.message : "Erro no servidor.", code: e.status || 500 });
  }
}
