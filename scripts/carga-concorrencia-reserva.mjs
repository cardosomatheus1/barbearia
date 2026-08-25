/**
 * Ensaio destrutivo do slot mais disputado.
 *
 * Dispara 100 reservas diferentes, ao mesmo tempo, para o mesmo profissional e
 * início. A propriedade é simples e não admite média: exatamente uma vence,
 * todas as outras recebem conflito de domínio e o banco termina com uma linha.
 *
 *   API_URL=http://127.0.0.1:3000 \
 *   DEMO_DATABASE_URL=postgres://... \
 *   node scripts/carga-concorrencia-reserva.mjs
 */

import { execFileSync } from 'node:child_process';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const BANCO = process.env.DEMO_DATABASE_URL ?? process.env.ADMIN_DATABASE_URL;
const DISPUTANTES = Number(process.env.CARGA_RESERVAS_SIMULTANEAS ?? 100);

if (!Number.isInteger(DISPUTANTES) || DISPUTANTES < 50 || DISPUTANTES > 500) {
  throw new Error('CARGA_RESERVAS_SIMULTANEAS deve ser um inteiro entre 50 e 500');
}
if (!BANCO) throw new Error('DEMO_DATABASE_URL é obrigatória para conferir o estado final no banco');

function headers(token, extras = {}) {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extras,
  };
}

async function corpo(resposta) {
  const texto = await resposta.text();
  if (!texto) return null;
  try { return JSON.parse(texto); } catch { return { texto: texto.slice(0, 300) }; }
}

async function chamar(metodo, rota, { token, body, extras } = {}) {
  const resposta = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: headers(token, extras),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { resposta, body: await corpo(resposta) };
}

function exigirOk(resultado, etapa) {
  if (resultado.resposta.ok) return resultado.body;
  throw new Error(`${etapa} respondeu ${resultado.resposta.status}: ${JSON.stringify(resultado.body)}`);
}

function diaFuturo(dias = 2) {
  const data = new Date();
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

function inteiroDoBanco(sql) {
  const saida = execFileSync('psql', [BANCO, '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  }).trim();
  if (!/^\d+$/.test(saida)) throw new Error(`consulta de conferência devolveu valor inesperado: ${saida}`);
  return Number(saida);
}

async function montarFixture() {
  const carimbo = `${Date.now()}-${process.pid}`;
  const email = `concorrencia-${carimbo}@teste.invalid`;
  const password = 'senha-concorrencia-bem-comprida';
  const businessName = `Concorrência ${carimbo}`;

  exigirOk(await chamar('POST', '/v1/admin/signup', {
    body: {
      name: 'Dono da carga', email, password, phone: '(71) 99999-0101', businessName,
    },
  }), 'signup');

  const login = exigirOk(await chamar('POST', '/v1/admin/login', {
    body: { email, password },
  }), 'login');
  const token = login?.token;
  if (typeof token !== 'string' || !token) throw new Error('login não devolveu token');

  exigirOk(await chamar('PUT', '/v1/admin/business', {
    token, body: { name: businessName, city: 'Salvador', timezone: 'America/Bahia' },
  }), 'cadastro da empresa');

  const catalogo = exigirOk(await chamar('GET', '/v1/admin/templates', { token }), 'templates');
  if (!Array.isArray(catalogo?.templates) || catalogo.templates.length === 0) {
    throw new Error('fixture não recebeu templates de serviço');
  }
  exigirOk(await chamar('PUT', '/v1/admin/services', {
    token, body: { services: catalogo.templates },
  }), 'serviços');

  exigirOk(await chamar('PUT', '/v1/admin/professionals', {
    token,
    body: {
      professionals: [{
        name: 'Barbeiro da disputa',
        schedule: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday, startMinute: 540, endMinute: 1260,
        })),
      }],
    },
  }), 'profissional');
  exigirOk(await chamar('PUT', '/v1/admin/payments', {
    token, body: { methods: ['pix', 'cash'] },
  }), 'pagamentos');
  exigirOk(await chamar('POST', '/v1/admin/publish', { token, body: {} }), 'publicação');

  const estado = exigirOk(await chamar('GET', '/v1/admin/state', { token }), 'estado do admin');
  const perfil = exigirOk(await chamar('GET', `/v1/b/${estado.slug}`), 'perfil público');
  const service = perfil?.categories?.flatMap((c) => c.services ?? [])[0];
  const professional = perfil?.professionals?.[0];
  const locationId = perfil?.location?.id;
  if (!service?.id || !professional?.id || !locationId) {
    throw new Error('fixture pública incompleta: serviço, profissional ou unidade ausente');
  }

  const date = diaFuturo();
  const disponibilidade = exigirOk(await chamar(
    'GET',
    `/v1/b/${estado.slug}/availability?locationId=${locationId}` +
      `&serviceIds=${service.id}&dateFrom=${date}&professionalId=${professional.id}`,
  ), 'disponibilidade');
  const slot = disponibilidade?.days?.[0]?.slots?.[0];
  if (!slot?.start) throw new Error(`nenhum horário disponível em ${date}`);

  return { token, date, start: slot.start, serviceId: service.id, professionalId: professional.id };
}

async function main() {
  const saude = await fetch(`${API}/health/pronto`).catch(() => null);
  if (!saude?.ok) throw new Error(`API não está pronta em ${API}`);

  console.log(`concorrência: preparando um slot para ${DISPUTANTES} reservas simultâneas...`);
  const fixture = await montarFixture();
  const inicio = process.hrtime.bigint();

  const pedidos = Array.from({ length: DISPUTANTES }, (_, i) => ({
    token: fixture.token,
    body: {
      serviceIds: [fixture.serviceId],
      professionalId: fixture.professionalId,
      date: fixture.date,
      start: fixture.start,
      name: `Disputante ${i + 1}`,
      phone: `(71) 9${String(70000000 + i).padStart(8, '0')}`,
    },
    key: `carga-slot-${Date.now()}-${i}`,
  }));

  const respostas = await Promise.all(pedidos.map(async (pedido) => {
    const resultado = await chamar('POST', '/v1/admin/appointments', {
      token: pedido.token,
      body: pedido.body,
      extras: { 'idempotency-key': pedido.key },
    });
    return { ...resultado, pedido };
  }));

  const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
  const vencedoras = respostas.filter((r) => r.resposta.ok);
  const conflitos = respostas.filter((r) => r.resposta.status === 409);
  const inesperadas = respostas.filter((r) => !r.resposta.ok && r.resposta.status !== 409);

  if (vencedoras.length !== 1 || conflitos.length !== DISPUTANTES - 1 || inesperadas.length !== 0) {
    const amostra = inesperadas.slice(0, 5).map((r) => ({
      status: r.resposta.status, body: r.body,
    }));
    throw new Error(
      `disputa inválida: ${vencedoras.length} sucesso(s), ${conflitos.length} conflito(s), ` +
      `${inesperadas.length} resposta(s) inesperada(s): ${JSON.stringify(amostra)}`,
    );
  }
  for (const conflito of conflitos) {
    const code = conflito.body?.error?.code;
    if (!['slot_taken', 'slot_not_available'].includes(code)) {
      throw new Error(`conflito sem erro de domínio reconhecido: ${JSON.stringify(conflito.body)}`);
    }
  }

  const vencedor = vencedoras[0];
  const appointmentId = vencedor.body?.id;
  const startsAt = vencedor.body?.startsAt;
  if (!/^[0-9a-f-]{36}$/i.test(appointmentId ?? '') || Number.isNaN(Date.parse(startsAt ?? ''))) {
    throw new Error(`reserva vencedora incompleta: ${JSON.stringify(vencedor.body)}`);
  }

  // A mesma chave precisa devolver a mesma reserva, não criar outra nem conflitar.
  const replay = await chamar('POST', '/v1/admin/appointments', {
    token: vencedor.pedido.token,
    body: vencedor.pedido.body,
    extras: { 'idempotency-key': vencedor.pedido.key },
  });
  if (!replay.resposta.ok || replay.body?.id !== appointmentId) {
    throw new Error(`replay idempotente divergiu: ${replay.resposta.status} ${JSON.stringify(replay.body)}`);
  }

  const professionalId = fixture.professionalId;
  if (!/^[0-9a-f-]{36}$/i.test(professionalId)) throw new Error('professionalId inválido na fixture');
  const instante = new Date(startsAt).toISOString();
  const totalNoBanco = inteiroDoBanco(
    `SELECT count(*) FROM appointments ` +
      `WHERE professional_id = '${professionalId}'::uuid ` +
      `AND service_starts_at = '${instante}'::timestamptz ` +
      `AND status NOT IN ('cancelled_customer','cancelled_business','no_show','rescheduled')`,
  );
  if (totalNoBanco !== 1) throw new Error(`banco terminou com ${totalNoBanco} reservas ativas no mesmo slot`);

  console.log(`concorrência: PASS — 1 criada, ${conflitos.length} recusadas com 409, 0 respostas 500`);
  console.log(`concorrência: banco confirmou 1 linha ativa; replay idempotente preservou ${appointmentId}`);
  console.log(`concorrência: ${DISPUTANTES} respostas em ${ms.toFixed(0)} ms`);
}

await main();
