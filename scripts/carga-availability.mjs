/**
 * Carga em `GET /availability` (SPEC Parte 5 §5.12, CLAUDE.md §3).
 *
 *   node scripts/carga-availability.mjs
 *
 * A meta é **P95 < 800 ms para 7 dias × 5 profissionais**. Este script monta
 * exatamente esse caso e mede.
 *
 * ## Por que a agenda entra cheia
 *
 * Medir a grade vazia mediria o caso fácil. O motor resolve jornada, exceções,
 * recursos e **o que já está marcado**; sem nada marcado, metade do trabalho
 * não acontece, e o número sai bonito por não medir nada. A barbearia que sofre
 * com lentidão é a que está lotada — então a fixture enche a agenda antes de
 * medir, e a taxa de ocupação é um parâmetro, não um acidente.
 *
 * ## Por que ele não vive dentro do `pnpm verify`
 *
 * Carga precisa de máquina estável para o número significar alguma coisa. Num
 * portão que roda em paralelo com build e sete suítes de banco, o P95 mede a
 * contenção do próprio portão. Ele roda sozinho, contra uma API já de pé, e o
 * resultado entra no commit — que é o que CLAUDE.md §3 pede: número antes e
 * depois, nunca "ficou mais rápido".
 *
 * ## O que ele responde além da média
 *
 * P50 diz como está o dia comum; **P95 é o que o cliente sente quando a coisa
 * aperta**, e é por isso que a meta é escrita nele. A saída traz os dois, mais
 * o pior caso, porque uma cauda longa com P95 bom ainda é gente vendo a tela
 * girar.
 */

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

/** Os parâmetros da meta. Mudar aqui muda o que está sendo prometido. */
const ALVO = {
  dias: 7,
  profissionais: 5,
  p95Ms: 800,
};

const REQUISICOES = Number(process.env.CARGA_REQUISICOES ?? 120);
const SIMULTANEAS = Number(process.env.CARGA_SIMULTANEAS ?? 8);
/** Fração dos horários da semana que já estão vendidos quando a medição começa. */
const OCUPACAO = Number(process.env.CARGA_OCUPACAO ?? 0.5);
/** Abaixo disso a medição é descartada: a grade estaria vazia demais. */
const MINIMO_VENDIDO = Number(process.env.CARGA_MINIMO ?? 100);

const json = (r) => r.json();

function cabecalho(token) {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

const post = (rota, corpo, token, extras = {}) =>
  fetch(`${API}${rota}`, {
    method: 'POST',
    headers: { ...cabecalho(token), ...extras },
    body: JSON.stringify(corpo),
  });

const put = (rota, corpo, token) =>
  fetch(`${API}${rota}`, { method: 'PUT', headers: cabecalho(token), body: JSON.stringify(corpo) });

/** aaaa-mm-dd de hoje + n, no fuso da unidade (que é o fuso da fixture). */
function dia(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const SEMANA = [0, 1, 2, 3, 4, 5, 6];

async function montarBarbearia() {
  const carimbo = Date.now();
  const conta = {
    name: 'Carga',
    email: `carga${carimbo}@teste.com`,
    password: 'senha-bem-comprida',
    phone: '(71) 99999-0000',
    businessName: `Carga ${carimbo % 10000}`,
  };

  await post('/v1/admin/signup', conta);
  const { token } = await json(
    await post('/v1/admin/login', { email: conta.email, password: conta.password }),
  );
  if (!token) throw new Error('login da fixture falhou');

  await put('/v1/admin/business', { name: conta.businessName, city: 'Salvador', timezone: 'America/Bahia' }, token);

  const { templates } = await json(
    await fetch(`${API}/v1/admin/templates`, { headers: cabecalho(token) }),
  );
  await put('/v1/admin/services', { services: templates }, token);

  // Cinco cadeiras, jornada de doze horas nos sete dias: é o número da meta, e
  // uma jornada curta esconderia o custo por reduzir a grade.
  await put(
    '/v1/admin/professionals',
    {
      professionals: Array.from({ length: ALVO.profissionais }, (_, i) => ({
        name: `Barbeiro ${i + 1}`,
        schedule: SEMANA.map((weekday) => ({ weekday, startMinute: 540, endMinute: 1260 })),
      })),
    },
    token,
  );
  await put('/v1/admin/payments', { methods: ['pix', 'cash'] }, token);
  await post('/v1/admin/publish', {}, token);

  const slug = (await json(await fetch(`${API}/v1/admin/state`, { headers: cabecalho(token) }))).slug;
  const perfil = await json(await fetch(`${API}/v1/b/${slug}`));

  return {
    token,
    slug,
    locationId: perfil.location.id,
    servicos: perfil.categories.flatMap((c) => c.services),
    profissionais: perfil.professionals,
  };
}

/**
 * Vende parte da semana.
 *
 * Marca pelo balcão porque é o caminho que não exige OTP; o efeito no banco —
 * e portanto no que `/availability` precisa considerar — é o mesmo de um
 * agendamento vindo da página pública.
 */
async function encherAgenda(casa) {
  const servico = casa.servicos.find((s) => s.durationMinutes >= 20) ?? casa.servicos[0];
  let marcados = 0;
  let recusados = 0;
  let primeiraRecusa = null;

  const grade = async (data, proId) =>
    json(
      await fetch(
        `${API}/v1/b/${casa.slug}/availability?locationId=${casa.locationId}` +
          `&serviceIds=${servico.id}&dateFrom=${data}&professionalId=${proId}`,
      ),
    );

  for (let d = 0; d < ALVO.dias; d++) {
    const data = dia(d);
    for (const pro of casa.profissionais) {
      const primeira = await grade(data, pro.id);
      const disponiveis = primeira.days?.[0]?.slots?.length ?? 0;
      const alvo = Math.floor(disponiveis * OCUPACAO);

      let feitos = 0;
      // Teto de voltas: sem ele, um motor que passa a recusar tudo faria o
      // laço girar para sempre em vez de a medição reprovar dizendo por quê.
      for (let volta = 0; feitos < alvo && volta < alvo * 3; volta++) {
        // A grade é relida a cada marcação. A primeira versão lia uma vez e
        // marcava `livres[i * 2]` dali, o que só funciona se marcar não mudar
        // a grade — e muda: na estratégia ancorada, o horário vendido desloca
        // todos os seguintes. Nesta máquina ainda entravam 840; na esteira,
        // com o fuso da unidade em outro dia, entraram **7 de 1400**, e a
        // guarda do mínimo reprovou a medição em vez de deixá-la mentir.
        const atual = await grade(data, pro.id);
        const livres = atual.days?.[0]?.slots ?? [];
        if (livres.length === 0) break;

        // O segundo, quando existe: deixa um buraco entre uma venda e outra.
        // Agenda cheia em bloco contíguo é mais barata para o motor do que a
        // esburacada, e a esburacada é a que a barbearia real tem.
        const slot = livres[1] ?? livres[0];

        const r = await post(
          '/v1/admin/appointments',
          {
            serviceIds: [servico.id],
            professionalId: pro.id,
            date: data,
            start: slot.start,
            name: `Cliente ${d}-${feitos}`,
            phone: `(71) 9${String(80000000 + marcados).slice(0, 8)}`,
          },
          casa.token,
          { 'idempotency-key': `carga-${d}-${pro.id}-${feitos}-${volta}` },
        );

        if (r.ok) {
          marcados++;
          feitos++;
        } else {
          recusados++;
          // A primeira recusa carrega o motivo. Sem guardá-la, uma mudança de
          // contrato vira "agenda vazia" e o número passa a medir o caso fácil.
          if (!primeiraRecusa) primeiraRecusa = `${r.status} ${JSON.stringify(await r.json())}`;
        }
      }
    }
  }

  return { marcados, recusados, primeiraRecusa };
}

/** Uma medição: a consulta que a meta descreve, com o relógio em volta. */
async function medirUma(casa, servicoIds) {
  const url =
    `${API}/v1/b/${casa.slug}/availability?locationId=${casa.locationId}` +
    `&serviceIds=${servicoIds}&dateFrom=${dia(0)}&dateTo=${dia(ALVO.dias - 1)}&anyProfessional=true`;

  const inicio = process.hrtime.bigint();
  const resposta = await fetch(url);
  await resposta.arrayBuffer();
  const ms = Number(process.hrtime.bigint() - inicio) / 1e6;

  return { ms, ok: resposta.ok, status: resposta.status };
}

function percentil(ordenados, p) {
  if (ordenados.length === 0) return 0;
  // Método do índice mais próximo, como a maioria das ferramentas de carga: com
  // 120 amostras, interpolar mudaria o número na terceira casa e daria falsa
  // precisão a uma medição que varia mais que isso entre execuções.
  const i = Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1);
  return ordenados[i];
}

async function main() {
  const saude = await fetch(`${API}/health`).catch(() => null);
  if (!saude) {
    console.error(`carga: nenhuma API em ${API}. Suba-a antes (node apps/api/dist/main.js).`);
    process.exit(2);
  }

  console.log(`carga: montando ${ALVO.profissionais} cadeiras × ${ALVO.dias} dias...`);
  const casa = await montarBarbearia();
  const { marcados, recusados, primeiraRecusa } = await encherAgenda(casa);
  console.log(`carga: ${marcados} horários vendidos (${recusados} recusados pelo motor)`);

  // Agenda vazia é o caso fácil: sem nada marcado, metade do trabalho do motor
  // não acontece e o P95 sai bonito por não medir nada. Melhor não ter número
  // do que ter um que mente.
  if (marcados < MINIMO_VENDIDO) {
    console.error(
      `carga: só ${marcados} horários entraram (mínimo ${MINIMO_VENDIDO}). ` +
        'A grade ficaria vazia e o P95 mediria o caso fácil.',
    );
    if (primeiraRecusa) console.error(`carga: primeira recusa — ${primeiraRecusa}`);
    process.exit(2);
  }

  const servicoIds = casa.servicos[0].id;

  // Aquecimento fora da amostra: a primeira consulta paga plano de query e
  // conexão do pool, e medi-la seria medir a partida, não o regime.
  for (let i = 0; i < 5; i++) await medirUma(casa, servicoIds);

  const amostras = [];
  const falhas = [];
  let proxima = 0;

  const inicioTudo = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: SIMULTANEAS }, async () => {
      while (proxima < REQUISICOES) {
        proxima++;
        const r = await medirUma(casa, servicoIds);
        if (r.ok) amostras.push(r.ms);
        else falhas.push(r.status);
      }
    }),
  );
  const totalS = Number(process.hrtime.bigint() - inicioTudo) / 1e9;

  const ordenados = [...amostras].sort((a, b) => a - b);
  const p50 = percentil(ordenados, 50);
  const p95 = percentil(ordenados, 95);
  const p99 = percentil(ordenados, 99);
  const pior = ordenados[ordenados.length - 1] ?? 0;
  const ms = (n) => `${n.toFixed(0)} ms`;

  console.log('');
  console.log(`  amostras     ${amostras.length} (${SIMULTANEAS} simultâneas, ${totalS.toFixed(1)}s)`);
  console.log(`  agenda       ${marcados} horários vendidos na semana`);
  console.log(`  P50          ${ms(p50)}`);
  console.log(`  P95          ${ms(p95)}   meta < ${ALVO.p95Ms} ms`);
  console.log(`  P99          ${ms(p99)}`);
  console.log(`  pior         ${ms(pior)}`);
  console.log(`  vazão        ${(amostras.length / totalS).toFixed(1)} req/s`);
  if (falhas.length > 0) console.log(`  falhas       ${falhas.length} (${[...new Set(falhas)].join(', ')})`);
  console.log('');

  // Uma falha invalida o número: P95 de uma amostra que devolveu erro mede a
  // velocidade de errar.
  if (falhas.length > 0) {
    console.error(`carga: ${falhas.length} requisição(ões) falharam — o número não vale.`);
    process.exit(1);
  }

  if (p95 >= ALVO.p95Ms) {
    console.error(`carga: P95 ${ms(p95)} acima da meta de ${ALVO.p95Ms} ms.`);
    process.exit(1);
  }

  console.log(`carga: dentro da meta (P95 ${ms(p95)} < ${ALVO.p95Ms} ms).`);
}

main().catch((erro) => {
  console.error('carga:', erro.message);
  process.exit(2);
});
