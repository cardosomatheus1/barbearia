/**
 * Uma barbearia de demonstração, com o dia já acontecendo.
 *
 *   node scripts/semear-demo.mjs
 *
 * ## Por que semear, e por que assim
 *
 * Sistema vazio não se avalia. A página pública sem foto, sem serviço e sem
 * barbeiro é a tela de estado vazio — que também precisa existir, mas não é o
 * produto. Quem abre isto pela primeira vez precisa ver a agenda cheia, a fila
 * com gente e o painel do dia com alguém na cadeira.
 *
 * Tudo entra **pela API**, com a mesma sessão e as mesmas permissões que a
 * recepção usaria. Escrever direto no banco seria mais curto e mentiria: pularia
 * a validação de borda, a RLS e a máquina de estados, e o dado semeado poderia
 * ser um dado que o produto nunca aceitaria.
 *
 * ## Idempotente
 *
 * Rodar de novo não duplica: se o login do dono já funciona, a barbearia já
 * existe e o script sai dizendo isso. Semear duas vezes criaria duas barbearias
 * e a segunda roubaria o `slug`.
 */

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3001';

const DONO = {
  name: 'Rogério Menezes',
  email: 'dono@barbearia.local',
  password: 'senha-de-demonstracao',
  phone: '(71) 99999-0000',
  businessName: 'Barbearia Domari',
};

const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const cinza = (t) => `\x1b[90m${t}\x1b[0m`;
const passo = (t) => console.log(`    ${t}`);

async function chamar(rota, { metodo = 'GET', corpo, token } = {}) {
  const resposta = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: {
      ...(corpo ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });
  const texto = await resposta.text();
  const dados = texto ? JSON.parse(texto) : null;
  if (!resposta.ok) {
    throw new Error(`${metodo} ${rota} → ${resposta.status} ${texto.slice(0, 300)}`);
  }
  return dados;
}

/** A jornada de todo dia, das 9h às 22h. Minutos locais desde a meia-noite. */
const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 22 * 60,
}));

async function jaExiste() {
  try {
    await chamar('/v1/admin/login', {
      metodo: 'POST',
      corpo: { email: DONO.email, password: DONO.password },
    });
    return true;
  } catch {
    return false;
  }
}

async function abrirBarbearia() {
  await chamar('/v1/admin/signup', { metodo: 'POST', corpo: DONO });
  const sessao = await chamar('/v1/admin/login', {
    metodo: 'POST',
    corpo: { email: DONO.email, password: DONO.password },
  });
  const token = sessao.token;
  passo('conta do dono criada');

  // Endereço, bairro e comodidades preenchidos de propósito: a página pública
  // do concorrente analisado não tem nenhum dos três (defeitos D8 e D9), e
  // semear vazio faria a demonstração parecer com ele.
  await chamar('/v1/admin/business', {
    metodo: 'PUT',
    token,
    corpo: {
      name: DONO.businessName,
      street: 'Rua Alceu Amoroso Lima, 172',
      district: 'Caminho das Árvores',
      city: 'Salvador',
      state: 'BA',
      postalCode: '41820-770',
      phone: '(71) 3333-4444',
      whatsapp: '(71) 99999-0000',
      instagram: 'barbeariadomari',
      about:
        'Barbearia de bairro desde 2009. Corte, barba e o café enquanto espera. ' +
        'Sem hora marcada também se atende, na ordem da fila.',
      timezone: 'America/Bahia',
      amenities: ['wifi', 'card', 'pix', 'cash', 'accessible'],
    },
  });

  // O catálogo sai dos modelos que o próprio onboarding oferece: são os serviços
  // que a SPEC lista, com preço e duração de barbearia de verdade.
  const { templates } = await chamar('/v1/admin/templates', { token });
  await chamar('/v1/admin/services', { metodo: 'PUT', token, corpo: { services: templates } });
  passo(`${templates.length} serviços no catálogo`);

  await chamar('/v1/admin/professionals', {
    metodo: 'PUT',
    token,
    corpo: {
      professionals: [
        { name: 'Ruan Cavalcante', schedule: JORNADA },
        { name: 'Gleidson Matos', schedule: JORNADA },
        { name: 'Ítalo Prado', schedule: JORNADA },
      ],
    },
  });
  passo('três cadeiras com jornada aberta');

  await chamar('/v1/admin/payments', { metodo: 'PUT', token, corpo: { methods: ['pix', 'cash', 'card'] } });
  await chamar('/v1/admin/publish', { metodo: 'POST', token, corpo: {} });
  passo('barbearia publicada');

  // Uma segunda conta: a lista de equipe com uma linha só não mostra papel,
  // selo e ações convivendo — e é a recepção que abre o balcão todo dia.
  await chamar('/v1/admin/team', {
    metodo: 'POST',
    token,
    corpo: { name: 'Maria Aparecida do Nascimento', email: 'recepcao@barbearia.local', role: 'receptionist' },
  }).catch(() => {});

  return { token, slug: sessao.slug };
}

/**
 * O dia de hoje, com gente em cada estado.
 *
 * Quatro pessoas e quatro estados, que é o mínimo para o painel do dia mostrar
 * o que ele existe para mostrar: quem ainda vem, quem chegou, quem está na
 * cadeira e quem já foi atendido — este último com o botão de cobrar.
 */
async function encherODia(token, catalogo) {
  const hoje = await chamar('/v1/admin/day', { token });

  const servico = catalogo.services[0];
  const pessoas = [
    { name: 'Maria Aparecida do Nascimento', phone: '(71) 98111-2233', ate: ['check_in'] },
    { name: 'Zé', phone: '(71) 98111-2244', ate: [] },
    { name: 'João Pedro de Albuquerque Filho', phone: '(71) 98111-2255', ate: ['check_in', 'start'] },
    { name: 'Antônio Carlos', phone: '(71) 98111-2266', ate: ['check_in', 'start', 'complete'] },
  ];

  let marcados = 0;
  for (const [i, pessoa] of pessoas.entries()) {
    const profissional = catalogo.professionals[i % catalogo.professionals.length];
    const grade = await chamar(
      `/v1/admin/availability?serviceIds=${servico.id}&professionalId=${profissional.id}` +
        `&dateFrom=${hoje.today}&dateTo=${hoje.today}`,
      { token },
    );
    const horario = grade.days[0]?.slots?.[i];
    if (!horario) continue;

    const criado = await chamar('/v1/admin/appointments', {
      metodo: 'POST',
      token,
      corpo: {
        name: pessoa.name,
        phone: pessoa.phone,
        professionalId: profissional.id,
        serviceIds: [servico.id],
        date: hoje.today,
        start: horario.start,
      },
    }).catch(() => null);
    if (!criado?.id) continue;
    marcados += 1;

    // Em ordem: a máquina de estados recusa pular etapa, e é ela que decide o
    // que a tela oferece em seguida.
    for (const acao of pessoa.ate) {
      await chamar(`/v1/admin/appointments/${criado.id}/attendance`, {
        metodo: 'POST',
        token,
        corpo: { action: acao },
      });
    }
  }
  passo(`${marcados} atendimentos hoje, em quatro estados`);
}

/**
 * O segundo fator, e por que ele aparece numa semeadura.
 *
 * Toda rota de dinheiro exige prova de segundo fator na sessão — a
 * `PermissaoGuard` **deriva** a exigência da permissão declarada, então não há
 * como uma tela de caixa existir sem ela. Semear o caixa sem passar por aqui
 * simplesmente não funciona, e o `.catch` que engolisse o erro deixaria a
 * demonstração dizendo "caixa aberto" com a gaveta fechada.
 *
 * O segredo é impresso no fim para quem quiser cadastrar num aplicativo
 * autenticador e abrir o caixa pela tela. É banco local e descartável; o
 * produto não tem segredo padrão em lugar nenhum.
 */
async function ligarSegundoFator(token) {
  const { codigoDoPasso, passoAgora } = await import(
    new URL('../packages/identity/dist/mfa.js', import.meta.url)
  );

  const { segredoBase32 } = await chamar('/v1/admin/mfa/setup', { metodo: 'POST', token });
  // O passo confirmado é queimado, então a verificação usa o seguinte — que já
  // é aceito agora, dentro da tolerância de ±1. Dormir 30s não traria nada.
  const agora = passoAgora(new Date());
  await chamar('/v1/admin/mfa/confirm', {
    metodo: 'POST',
    token,
    corpo: { codigo: codigoDoPasso(segredoBase32, agora) },
  });
  await chamar('/v1/admin/mfa/verify', {
    metodo: 'POST',
    token,
    corpo: { codigo: codigoDoPasso(segredoBase32, agora + 1) },
  });
  passo('segundo fator ligado (as telas de dinheiro exigem)');
  return segredoBase32;
}

/** O caixa aberto: sem gaveta aberta, nenhuma venda entra (desde o bloco 18). */
async function abrirOCaixa(token, catalogo) {
  await chamar('/v1/admin/cash/open', { metodo: 'POST', token, corpo: { openingCents: 20000 } });
  passo('caixa aberto com R$ 200,00 de troco');

  await chamar('/v1/admin/commission/rules', {
    metodo: 'PUT',
    token,
    corpo: { modo: 'percent', valor: 4000 },
  });
  passo('comissão geral de 40%');

  // Uma comanda aberta, para a tela de dinheiro não ser avaliada vazia.
  const comanda = await chamar('/v1/admin/orders', { metodo: 'POST', token, corpo: {} });
  for (const item of [
    { descricao: 'Corte degradê com máquina e tesoura', precoUnitarioCents: 6500 },
    { descricao: 'Barba terapêutica com toalha quente', precoUnitarioCents: 4900 },
  ]) {
    await chamar(`/v1/admin/orders/${comanda.id}/items`, {
      metodo: 'POST',
      token,
      corpo: { tipo: 'service', quantidade: 1, professionalId: catalogo.professionals[0]?.id, ...item },
    });
  }
  passo('uma comanda aberta, com dois itens');
}

async function main() {
  if (await jaExiste()) {
    console.log(cinza('    a barbearia de demonstração já existe; nada a semear'));
    contar();
    return;
  }

  const { token, slug } = await abrirBarbearia();
  const catalogo = await chamar('/v1/admin/catalog', { token });
  await encherODia(token, catalogo);
  const segredo = await ligarSegundoFator(token);
  await abrirOCaixa(token, catalogo);
  contar(slug, segredo);
}

function contar(slug, segredo) {
  console.log('');
  console.log(`    ${verde('entre no painel')}  ${WEB}/admin/entrar`);
  console.log(`      e-mail ${DONO.email}`);
  console.log(`      senha  ${DONO.password}`);
  if (slug) {
    console.log('');
    console.log(`    ${verde('a página do cliente')}  ${WEB}/${slug}`);
  }
  if (segredo) {
    console.log('');
    console.log(`    ${verde('segundo fator')}  ${segredo}`);
    console.log(cinza('      As telas de dinheiro — caixa, comanda, fiado, comissão — exigem prova'));
    console.log(cinza('      de segundo fator, e a prova vence em 30 min. Cadastre este segredo em'));
    console.log(cinza('      qualquer aplicativo autenticador (chave manual, base32).'));
  }
  console.log('');
  console.log(cinza('    Credenciais de demonstração, em banco local. Não servem em lugar nenhum'));
  console.log(cinza('    além desta máquina, e o produto não tem senha padrão.'));
}

main().catch((erro) => {
  console.error(`\n    falhou: ${erro.message}\n`);
  process.exit(1);
});
