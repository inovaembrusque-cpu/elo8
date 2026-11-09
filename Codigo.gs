/**
 * ELO 8 — Gestão de Metas da Rede INOVA
 * Servidor de dados (Google Apps Script) que fica dentro da planilha "Elo 8 — dados".
 *
 * - Os dados ficam nas abas desta planilha (não edite à mão).
 * - As senhas são guardadas só como código (hash) e nunca aparecem no site público.
 * - Cada pessoa recebe apenas as próprias atividades e tarefas; o gestor recebe tudo.
 * - Compromissos da Agenda do Centro e atividades marcadas como importantes são
 *   gravados na Google Agenda desta conta, sempre com o convidado abaixo.
 *
 * Primeira instalação: escolha a função "instalar" e clique em Executar (autorize).
 * Publicação: Implantar → Nova implantação → App da Web →
 *             Executar como: Eu · Quem pode acessar: Qualquer pessoa.
 */
const CONVIDADO = 'gestao@inovaembrusque.com.br';
const PIN_PADRAO = '1234';
const FUSO = 'America/Sao_Paulo';
const COLECOES = ['usuarios', 'funcoes', 'feriados', 'atividades', 'tarefas', 'agenda', 'config'];
const SO_GESTOR = ['funcoes', 'feriados', 'config'];
const LIMITE_CELULA = 45000;
const LIMITE_ITEM = 400000;
const DIAS_SESSAO = 30;

/* ============================== NÚCLEO ============================== */
function chave(c, id) { return c + '|' + id; }
function vivos(db, c) { return Object.keys(db.itens).map(k => db.itens[k]).filter(e => e.c === c && e.item).map(e => e.item); }
function obter(db, c, id) { const e = db.itens[chave(c, id)]; return e ? e.item : null; }
function nomeDe(db, uid) { const u = obter(db, 'usuarios', uid); return u ? u.nome : (uid === 'google' ? 'Google Agenda' : ''); }

function gravarItem(db, c, id, item, por, ctx) {
  const ant = db.itens[chave(c, id)];
  const antItem = ant ? ant.item : null;
  db.rev += 1;
  let antigo = ant ? (ant.antigo || '') : '';
  if (antItem && item && antItem.respId && antItem.respId !== item.respId) antigo = antItem.respId;
  db.itens[chave(c, id)] = {
    c: c, id: id, item: item || null, rev: db.rev,
    dono: item ? (item.respId || '') : (antItem ? (antItem.respId || '') : (ant ? ant.dono : '')),
    antigo: antigo, em: ctx.agora(), por: por || ''
  };
  db.sujo.dados = true;
}

function garantirGestor(db, ctx) {
  if (vivos(db, 'usuarios').length) return;
  gravarItem(db, 'usuarios', 'u-gestor', {
    id: 'u-gestor', nome: 'Gestor(a) do Centro', papel: 'gestor', tipo: 'Pessoa', cor: '#2A6F8F',
    foto: null, funcao: 'Coordenação do Centro de Inovação', email: ''
  }, 'sistema', ctx);
}

function publico(db, ctx) {
  garantirGestor(db, ctx);
  const cfg = obter(db, 'config', 'geral') || {};
  return {
    ok: true,
    usuarios: vivos(db, 'usuarios').map(u => ({ id: u.id, nome: u.nome, cor: u.cor, foto: u.foto || null, papel: u.papel, tipo: u.tipo })),
    config: { nomeCentro: cfg.nomeCentro || '', logo: cfg.logo || null }
  };
}

function confere(db, ctx, uid, pin) {
  const r = db.acesso[uid];
  if (!r) return pin === PIN_PADRAO;
  return ctx.sha(r.salt + '|' + pin) === r.hash;
}
function definirPin(db, ctx, uid, pin) {
  const salt = ctx.uuid();
  db.acesso[uid] = { salt: salt, hash: ctx.sha(salt + '|' + pin) };
  db.sujo.acesso = true;
}

function login(db, ctx, req) {
  const u = obter(db, 'usuarios', String(req.usuario || ''));
  if (!u || !confere(db, ctx, u.id, String(req.pin || ''))) { ctx.dormir(1500); return { ok: false, erro: 'senha' }; }
  const agora = ctx.agora();
  Object.keys(db.sessoes).forEach(t => { if (db.sessoes[t].exp < agora) delete db.sessoes[t]; });
  const token = ctx.uuid() + ctx.uuid();
  db.sessoes[token] = { u: u.id, exp: agora + DIAS_SESSAO * 864e5 };
  db.sujo.sessoes = true;
  return { ok: true, token: token, usuario: u.id, papel: u.papel };
}

function sessaoDe(db, ctx, token) {
  const s = token && db.sessoes[token];
  if (!s || s.exp < ctx.agora()) return null;
  return obter(db, 'usuarios', s.u);
}

function visivelPara(e, u) {
  if (u.papel === 'gestor') return 'sim';
  if (e.c !== 'atividades' && e.c !== 'tarefas') return 'sim';
  if (e.item ? e.item.respId === u.id : e.dono === u.id) return 'sim';
  if (e.antigo === u.id) return 'remover';
  return 'nao';
}

function sincronizar(db, u, desde) {
  const out = [];
  Object.keys(db.itens).forEach(k => {
    const e = db.itens[k];
    if (e.rev <= desde) return;
    const v = visivelPara(e, u);
    if (v === 'nao') return;
    out.push({ c: e.c, id: e.id, item: v === 'remover' ? null : e.item, rev: e.rev });
  });
  out.sort((a, b) => a.rev - b.rev);
  return { ok: true, rev: db.rev, mudancas: out, usuario: u.id, papel: u.papel };
}

function gravar(db, ctx, u, req) {
  const ops = Array.isArray(req.ops) ? req.ops : [];
  const g = u.papel === 'gestor';
  const rejeitadas = [];
  const rej = (op, m) => { rejeitadas.push({ c: op.c, id: op.id, motivo: m }); };
  ops.forEach(op => {
    const c = op.c, id = String(op.id || '');
    if (COLECOES.indexOf(c) < 0 || !id) return rej(op, 'Registro inválido.');
    if (!g && SO_GESTOR.indexOf(c) >= 0) return rej(op, 'Somente o gestor altera esta informação.');
    const atual = obter(db, c, id);
    if (op.op === 'del') {
      if (!atual) return;
      if (c === 'usuarios') {
        if (!g) return rej(op, 'Somente o gestor remove pessoas.');
        if (id === u.id) return rej(op, 'Você não pode remover o próprio usuário.');
      }
      if (!g && (c === 'atividades' || c === 'tarefas') && atual.respId !== u.id) return rej(op, 'Este registro não é seu.');
      if (!g && c === 'agenda' && atual.criadoPor !== u.id) return rej(op, 'Somente quem criou o compromisso pode excluí-lo.');
      try { ctx.agenda.remover(c, atual, db); } catch (e) { /* segue mesmo sem a agenda */ }
      if (c === 'usuarios') { delete db.acesso[id]; db.sujo.acesso = true; }
      return gravarItem(db, c, id, null, u.id, ctx);
    }
    let novo = op.item;
    if (!novo || typeof novo !== 'object' || Array.isArray(novo)) return rej(op, 'Registro inválido.');
    novo = JSON.parse(JSON.stringify(novo));
    novo.id = id;
    if (JSON.stringify(novo).length > LIMITE_ITEM) return rej(op, 'Registro muito grande (use fotos menores).');
    if (c === 'usuarios') {
      const pin = novo.pin; delete novo.pin;
      if (!g) {
        if (id !== u.id) return rej(op, 'Você só pode alterar o próprio perfil.');
        novo.papel = atual ? atual.papel : 'membro';
        novo.tipo = atual ? atual.tipo : (novo.tipo || 'Pessoa');
      } else if (id === u.id) novo.papel = 'gestor';
      if (pin && String(pin).length >= 4) definirPin(db, ctx, id, String(pin));
    }
    if (!g) {
      if ((c === 'atividades' || c === 'tarefas') && (novo.respId !== u.id || (atual && atual.respId !== u.id))) return rej(op, 'Você só pode alterar as próprias atividades e tarefas.');
      if (c === 'atividades') {
        const st = {};
        ((atual && atual.recursos) || []).forEach(r => { st[r.id] = r.status; });
        (novo.recursos || []).forEach(r => { r.status = st[r.id] || 'solicitado'; });
      }
      if (c === 'agenda') {
        if (atual && atual.criadoPor !== u.id) return rej(op, 'Somente quem criou o compromisso pode alterá-lo.');
        if (!atual) novo.criadoPor = u.id;
      }
    }
    if (atual) ['gcalId', 'gcalAssin', 'gcal', 'origem'].forEach(k => { if (atual[k] !== undefined && novo[k] === undefined) novo[k] = atual[k]; });
    try { ctx.agenda.sincronizar(c, novo, atual, db); delete novo.gcalErro; }
    catch (e) { novo.gcalErro = String((e && e.message) || e).slice(0, 200); }
    gravarItem(db, c, id, novo, u.id, ctx);
  });
  const r = sincronizar(db, u, Number(req.desde) || 0);
  r.rejeitadas = rejeitadas;
  return r;
}

function trocarSenha(db, ctx, u, req) {
  const alvo = String(req.usuario || u.id), pin = String(req.pin || '');
  if (u.papel !== 'gestor' && alvo !== u.id) return { ok: false, erro: 'permissao', mensagem: 'Você só pode trocar a própria senha.' };
  if (pin.length < 4) return { ok: false, erro: 'senha_curta', mensagem: 'A senha precisa ter pelo menos 4 caracteres.' };
  definirPin(db, ctx, alvo, pin);
  return { ok: true };
}

function rotear(db, ctx, req) {
  const a = req.acao;
  if (a === 'publico') return publico(db, ctx);
  if (a === 'login') { garantirGestor(db, ctx); return login(db, ctx, req); }
  const u = sessaoDe(db, ctx, String(req.token || ''));
  if (!u) return { ok: false, erro: 'sessao' };
  if (a === 'sync') return sincronizar(db, u, Number(req.desde) || 0);
  if (a === 'gravar') return gravar(db, ctx, u, req);
  if (a === 'senha') return trocarSenha(db, ctx, u, req);
  if (a === 'sair') { delete db.sessoes[req.token]; db.sujo.sessoes = true; return { ok: true }; }
  return { ok: false, erro: 'acao' };
}

/* ============================ GOOGLE AGENDA ============================ */
function gcalAgenda() { return CalendarApp.getDefaultCalendar(); }
function gcalData(data, hora) { return Utilities.parseDate(data + ' ' + (hora || '12:00'), FUSO, 'yyyy-MM-dd HH:mm'); }
function gcalMaisUmaHora(h) { const p = h.split(':').map(Number); return p[0] >= 23 ? '23:59' : ('0' + (p[0] + 1)).slice(-2) + ':' + ('0' + p[1]).slice(-2); }
function gcalEvento(id) { if (!id) return null; try { return gcalAgenda().getEventById(id); } catch (e) { return null; } }
function gcalApagar(id) { const ev = gcalEvento(id); if (ev) { try { ev.deleteEvent(); } catch (e) { } } }
function gcalConvidado(ev) { try { if (!ev.getGuestByEmail(CONVIDADO)) ev.addGuest(CONVIDADO); } catch (e) { } }

function gcalDia(id, titulo, data, descricao, tag) {
  let ev = gcalEvento(id);
  if (!ev) {
    ev = gcalAgenda().createAllDayEvent(titulo, gcalData(data), { description: descricao, guests: CONVIDADO, sendInvites: true });
    ev.setTag('elo8', tag);
  } else {
    ev.setTitle(titulo); ev.setDescription(descricao); ev.setAllDayDate(gcalData(data)); gcalConvidado(ev);
  }
  return ev.getId();
}

function gcalSincronizar(c, item, antigo, db) {
  if (c === 'agenda') return gcalSincronizarEvento(item, db);
  if (c === 'atividades') return gcalSincronizarAtividade(item, db);
}

function gcalSincronizarEvento(e, db) {
  const assin = [e.titulo, e.data, e.hora || '', e.horaFim || '', e.local || '', e.descricao || ''].join('|');
  if (e.gcalId && e.gcalAssin === assin) return;
  const desc = (e.descricao ? e.descricao + '\n\n' : '') + 'Agenda do Centro de Inovação · registrado no Elo 8' + (e.criadoPor && e.criadoPor !== 'google' ? ' por ' + nomeDe(db, e.criadoPor) : '');
  let ev = gcalEvento(e.gcalId);
  if (!ev) {
    const op = { description: desc, location: e.local || '', guests: CONVIDADO, sendInvites: true };
    ev = e.hora ? gcalAgenda().createEvent(e.titulo, gcalData(e.data, e.hora), gcalData(e.data, e.horaFim || gcalMaisUmaHora(e.hora)), op)
                : gcalAgenda().createAllDayEvent(e.titulo, gcalData(e.data), op);
    if (e.origem !== 'google') ev.setTag('elo8', 'agenda:' + e.id);
  } else {
    ev.setTitle(e.titulo); ev.setDescription(desc); ev.setLocation(e.local || '');
    if (e.hora) ev.setTime(gcalData(e.data, e.hora), gcalData(e.data, e.horaFim || gcalMaisUmaHora(e.hora)));
    else ev.setAllDayDate(gcalData(e.data));
    gcalConvidado(ev);
  }
  e.gcalId = ev.getId(); e.gcalAssin = assin;
}

function gcalSincronizarAtividade(a, db) {
  const gc = a.gcal || { prazo: '', marcos: {}, assin: '' };
  gc.marcos = gc.marcos || {};
  const ativa = !!a.naAgendaGoogle && a.planejada !== false && a.statusManual !== 'cancelada';
  if (!ativa) {
    if (gc.prazo) gcalApagar(gc.prazo);
    Object.keys(gc.marcos).forEach(k => gcalApagar(gc.marcos[k]));
    if (a.gcal) a.gcal = { prazo: '', marcos: {}, assin: '' };
    return;
  }
  const assin = [a.titulo, a.fim, a.respId, a.kpi, a.meta, (a.marcos || []).map(m => m.id + m.data + m.titulo + (m.feito ? 1 : 0)).join(',')].join('|');
  if (gc.prazo && gc.assin === assin) return;
  const desc = (a.kpi || '') + ' — meta ' + a.meta + '\nResponsável: ' + nomeDe(db, a.respId) + '\nAtividade registrada no Elo 8 (Centro de Inovação).';
  const prazo = gcalDia(gc.prazo, 'Prazo: ' + a.titulo, a.fim, desc, 'prazo:' + a.id);
  const novos = {};
  (a.marcos || []).forEach(m => {
    if (m.feito) { if (gc.marcos[m.id]) gcalApagar(gc.marcos[m.id]); return; }
    novos[m.id] = gcalDia(gc.marcos[m.id], m.titulo + ' — ' + a.titulo, m.data, desc, 'etapa:' + m.id);
  });
  Object.keys(gc.marcos).forEach(k => { if (!(k in novos) && gc.marcos[k]) gcalApagar(gc.marcos[k]); });
  a.gcal = { prazo: prazo, marcos: novos, assin: assin };
}

function gcalRemover(c, item) {
  if (c === 'agenda' && item.gcalId) gcalApagar(item.gcalId);
  if (c === 'atividades' && item.gcal) {
    if (item.gcal.prazo) gcalApagar(item.gcal.prazo);
    Object.keys(item.gcal.marcos || {}).forEach(k => gcalApagar(item.gcal.marcos[k]));
  }
}

/* Traz para a Agenda do Centro os eventos criados direto no Google Agenda (gatilho a cada 15 min). */
function importarGoogle() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const db = carregarDb(), ctx = contexto();
    const ini = new Date(Date.now() - 30 * 864e5), fim = new Date(Date.now() + 400 * 864e5);
    const iniStr = Utilities.formatDate(ini, FUSO, 'yyyy-MM-dd');
    const vistos = {};
    gcalAgenda().getEvents(ini, fim).forEach(ev => {
      if (ev.getTag('elo8')) return;
      let meu = false; try { meu = ev.isOwnedByMe(); } catch (e) { }
      if (!meu) return;
      const gid = ev.getId();
      const id = 'g' + Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, gid).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('').slice(0, 16);
      vistos[id] = true;
      gcalConvidado(ev);
      const dia = ev.isAllDayEvent();
      const s = dia ? ev.getAllDayStartDate() : ev.getStartTime();
      const item = {
        id: id, titulo: ev.getTitle(), data: Utilities.formatDate(s, FUSO, 'yyyy-MM-dd'),
        hora: dia ? '' : Utilities.formatDate(s, FUSO, 'HH:mm'), horaFim: dia ? '' : Utilities.formatDate(ev.getEndTime(), FUSO, 'HH:mm'),
        local: ev.getLocation() || '', descricao: ev.getDescription() || '', criadoPor: 'google', origem: 'google', gcalId: gid
      };
      item.gcalAssin = [item.titulo, item.data, item.hora, item.horaFim, item.local, item.descricao].join('|');
      const atual = obter(db, 'agenda', id);
      if (!atual || atual.gcalAssin !== item.gcalAssin) gravarItem(db, 'agenda', id, item, 'google', ctx);
    });
    vivos(db, 'agenda').forEach(e => {
      if (e.origem === 'google' && !vistos[e.id] && e.data >= iniStr) gravarItem(db, 'agenda', e.id, null, 'google', ctx);
    });
    salvarDb(db);
  } finally { lock.releaseLock(); }
}

/* ============================ PLANILHA (BANCO) ============================ */
const CAB_DADOS = ['colecao', 'id', 'parte', 'json', 'rev', 'dono', 'antigo', 'atualizado_em', 'por'];
const CAB_ACESSO = ['usuario', 'salt', 'hash'];
const CAB_SESSOES = ['token', 'usuario', 'expira'];

function planilha() { return SpreadsheetApp.getActiveSpreadsheet(); }
function aba(nome, cab) {
  const ss = planilha();
  let sh = ss.getSheetByName(nome);
  if (!sh) {
    sh = ss.insertSheet(nome);
    sh.getRange(1, 1, 1, cab.length).setNumberFormat('@').setValues([cab]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function linhas(sh) { const v = sh.getDataRange().getValues(); return v.slice(1).filter(r => r[0] !== '' && r[0] !== null); }

function carregarDb() {
  const db = { itens: {}, rev: 0, acesso: {}, sessoes: {}, sujo: {} };
  const partes = {};
  linhas(aba('dados', CAB_DADOS)).forEach(r => {
    const k = chave(String(r[0]), String(r[1]));
    const p = partes[k] || (partes[k] = { c: String(r[0]), id: String(r[1]), rev: Number(r[4]) || 0, dono: String(r[5] || ''), antigo: String(r[6] || ''), em: Number(r[7]) || 0, por: String(r[8] || ''), p: [] });
    p.p[Number(r[2]) || 0] = String(r[3] || '');
  });
  Object.keys(partes).forEach(k => {
    const e = partes[k], js = e.p.join('');
    db.itens[k] = { c: e.c, id: e.id, item: js ? JSON.parse(js) : null, rev: e.rev, dono: e.dono, antigo: e.antigo, em: e.em, por: e.por };
    if (e.rev > db.rev) db.rev = e.rev;
  });
  linhas(aba('acesso', CAB_ACESSO)).forEach(r => { db.acesso[String(r[0])] = { salt: String(r[1]), hash: String(r[2]) }; });
  linhas(aba('sessoes', CAB_SESSOES)).forEach(r => { db.sessoes[String(r[0])] = { u: String(r[1]), exp: Number(r[2]) || 0 }; });
  return db;
}

function fatiar(js) {
  const out = []; let i = 0;
  while (i < js.length) {
    let f = Math.min(js.length, i + LIMITE_CELULA);
    while (f < js.length && '=+-@'.indexOf(js.charAt(f)) >= 0) f--; // nenhuma parte começa com caractere de fórmula
    out.push(js.slice(i, f)); i = f;
  }
  return out.length ? out : [''];
}
function escrever(sh, cab, dados) {
  sh.clearContents();
  const tudo = [cab].concat(dados.map(l => l.map(v => String(v))));
  sh.getRange(1, 1, tudo.length, cab.length).setNumberFormat('@').setValues(tudo);
}
function salvarDb(db) {
  if (db.sujo.dados) {
    const out = [];
    Object.keys(db.itens).forEach(k => {
      const e = db.itens[k];
      fatiar(e.item ? JSON.stringify(e.item) : '').forEach((parte, i) => out.push([e.c, e.id, i, parte, e.rev, e.dono || '', e.antigo || '', e.em || 0, e.por || '']));
    });
    escrever(aba('dados', CAB_DADOS), CAB_DADOS, out);
  }
  if (db.sujo.acesso) escrever(aba('acesso', CAB_ACESSO), CAB_ACESSO, Object.keys(db.acesso).map(u => [u, db.acesso[u].salt, db.acesso[u].hash]));
  if (db.sujo.sessoes) escrever(aba('sessoes', CAB_SESSOES), CAB_SESSOES, Object.keys(db.sessoes).map(t => [t, db.sessoes[t].u, db.sessoes[t].exp]));
}

function contexto() {
  return {
    agora: () => Date.now(),
    uuid: () => Utilities.getUuid().replace(/-/g, ''),
    dormir: ms => Utilities.sleep(ms),
    sha: s => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''),
    agenda: { sincronizar: gcalSincronizar, remover: gcalRemover }
  };
}

/* ============================== WEB ============================== */
function saida(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return saida({ ok: true, app: 'Elo 8', mensagem: 'Servidor do Elo 8 ativo. Use o link do sistema para acessar.' }); }
function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { return saida({ ok: false, erro: 'requisicao' }); }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(28000)) return saida({ ok: false, erro: 'ocupado' });
  try {
    const db = carregarDb();
    const r = rotear(db, contexto(), req);
    salvarDb(db);
    return saida(r);
  } catch (err) {
    return saida({ ok: false, erro: 'servidor', detalhe: String((err && err.message) || err) });
  } finally { lock.releaseLock(); }
}

/* ============================== INSTALAÇÃO ============================== */
function instalar() {
  const ss = planilha();
  aba('dados', CAB_DADOS); aba('acesso', CAB_ACESSO); aba('sessoes', CAB_SESSOES);
  ['Página1', 'Sheet1', 'Planilha1'].forEach(n => { const s = ss.getSheetByName(n); if (s && ss.getSheets().length > 1) ss.deleteSheet(s); });
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'importarGoogle') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('importarGoogle').timeBased().everyMinutes(15).create();
  Logger.log('Agenda: ' + gcalAgenda().getName());
  const db = carregarDb(); garantirGestor(db, contexto()); salvarDb(db);
  Logger.log('Elo 8 instalado. Gestor inicial: "Gestor(a) do Centro", senha ' + PIN_PADRAO + ' (troque no primeiro acesso).');
}

if (typeof module !== 'undefined') module.exports = { rotear, gravar, sincronizar, login, publico, garantirGestor, fatiar };
