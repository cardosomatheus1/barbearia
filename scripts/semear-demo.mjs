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
 * com gente, alguém na cadeira e o caixa com dinheiro dentro.
 *
 * Tudo entra **pela API**, com a mesma sessão e as mesmas permissões que a
 * recepção usaria. Escrever direto no banco seria mais curto e mentiria: pularia
 * a validação de borda, a RLS e a máquina de estados, e o dado semeado poderia
 * ser um dado que o produto nunca aceitaria. É também por isso que a senha aqui
 * tem dez caracteres: o domínio recusa menos, e afrouxar a regra para caber numa
 * demonstração seria trocar a segurança do produto pela conveniência de um
 * `login`.
 *
 * ## Idempotente
 *
 * Rodar de novo não duplica: se o login do dono já funciona, a barbearia já
 * existe e o script sai dizendo isso. Semear duas vezes criaria duas barbearias
 * e a segunda roubaria o `slug`.
 */

import { semearDetalhes } from './semear-detalhes.mjs';
import { CARDAPIO, JORNADA_DA_SEMANA, semearFundo } from './semear-fundo.mjs';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

/**
 * A trava de ambiente, e por que ela não é paranoia.
 *
 * Este script cria uma conta de **dono** com senha conhecida e publicada no
 * repositório. A frase que ele imprime no fim — "não servem em lugar nenhum
 * além desta máquina" — era uma suposição sobre onde o comando foi digitado,
 * não uma verificação: `API_URL` vinha do compose e apontava para `api:3000`
 * independentemente de o compose estar num notebook ou num VPS.
 *
 * Quem alcançasse a porta entrava como dono: base de clientes com telefone e
 * ficha, caixa, comanda, fiado, exportação LGPD, chaves de API e cadastro de
 * webhook — que é o ponto de saída de rede do produto.
 *
 * A conferência é pelo **host**, que é o que decide para onde os dados vão.
 */
const LOCAIS = ['localhost', '127.0.0.1', '::1', 'api', 'host.docker.internal'];
const alvo = new URL(API).hostname;
if (!LOCAIS.includes(alvo)) {
  console.error(
    `[semear] recusado: ${alvo} não é uma máquina local.\n` +
      '  Este script cria um dono com senha conhecida e publicada. Ele existe\n' +
      '  para demonstração local — num alvo remoto, seria uma porta aberta.',
  );
  process.exit(1);
}
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3001';

/**
 * A conta de entrada.
 *
 * `teste@teste.com` e não `teste`: o login valida formato de e-mail na borda.
 * `testeteste` e não `teste`: `MIN_PASSWORD` são dez caracteres no domínio, e
 * a demonstração não é motivo para baixar o piso de senha do produto inteiro.
 */
const DONO = {
  name: 'Rogério Menezes',
  email: 'teste@teste.com',
  password: 'testeteste',
  phone: '(71) 99999-0000',
  businessName: 'Barbearia Domari',
};

const SENHA_DA_EQUIPE = 'testeteste';

/**
 * Fotos de verdade, do Unsplash.
 *
 * A página pública é uma escolha visual — corte, ambiente, barbeiro —, e sem
 * imagem ela parece cardápio de texto por mais bem espaçada que esteja
 * (CLAUDE.md §5). São endereços públicos: o navegador de quem abrir é que
 * busca, e o `imagemPublica` do domínio já exige `https`.
 */
const FOTOS = {
  capa: 'https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=1600&q=70',
  rostos: [
    'https://images.unsplash.com/photo-1503443207922-dff7d543fd0e?w=800&q=70',
    'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=800&q=70',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=70',
  ],
  cortes: [
    'https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=600&q=70',
    'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?w=600&q=70',
    'https://images.unsplash.com/photo-1621607512214-68297480165e?w=600&q=70',
  ],
};

const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const cinza = (t) => `\x1b[90m${t}\x1b[0m`;
const passo = (t) => console.log(`    ${t}`);

async function chamar(rota, { metodo = 'GET', corpo, token, cabecalhos } = {}) {
  const resposta = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: {
      ...(corpo ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...cabecalhos,
    },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });
  const texto = await resposta.text();
  const dados = texto ? JSON.parse(texto) : null;
  if (!resposta.ok) throw new Error(`${metodo} ${rota} → ${resposta.status} ${texto.slice(0, 300)}`);
  return dados;
}

/**
 * A jornada e o cardápio saem do simulador, não daqui.
 *
 * Os dois arquivos precisam concordar ou a barbearia fica incoerente consigo
 * mesma: a ocupação tem a jornada cadastrada no denominador, e o histórico
 * simulado precisa casar com o serviço que existe no catálogo pelo **nome**.
 * Duas listas parecidas em dois arquivos é como uma delas fica para trás — é a
 * regra que `secoes.ts` e os rótulos de campanha já cobraram aqui.
 */
const JORNADA = JORNADA_DA_SEMANA;

const somarDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

// -- a barbearia -------------------------------------------------------------

async function abrirBarbearia() {
  await chamar('/v1/admin/signup', { metodo: 'POST', corpo: DONO });
  const sessao = await chamar('/v1/admin/login', {
    metodo: 'POST',
    corpo: { email: DONO.email, password: DONO.password },
  });
  const token = sessao.token;
  passo('conta do dono criada');

  // Endereço, bairro, telefone e comodidades preenchidos de propósito: a página
  // pública do concorrente analisado não tem nenhum deles (defeitos D8 e D9), e
  // semear vazio faria a demonstração parecer com ela.
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

  /**
   * O cardápio da casa, e não o modelo genérico do onboarding.
   *
   * Os templates existem para a barbearia que está abrindo agora e não sabe o
   * que cobrar. Uma demonstração precisa do contrário: preço e duração de
   * verdade, com "Barba terapêutica com toalha quente" e R$ 180 de platinado —
   * é o nome comprido e o preço de três dígitos que quebram layout, e eles só
   * aparecem com conteúdo verdadeiro (CLAUDE.md §5).
   */
  const servicos = CARDAPIO.map((s) => ({
    key: s.chave,
    name: s.nome,
    category: s.categoria,
    durationMinutes: s.min,
    bufferAfterMinutes: s.buffer,
    priceCents: s.preco,
  }));
  await chamar('/v1/admin/services', { metodo: 'PUT', token, corpo: { services: servicos } });
  passo(`${servicos.length} serviços no catálogo`);

  await chamar('/v1/admin/professionals', {
    metodo: 'PUT',
    token,
    corpo: {
      professionals: [
        { name: 'Ruan Cavalcante', bio: 'Degradê e navalha. Doze anos de cadeira.', schedule: JORNADA },
        { name: 'Gleidson Matos', bio: 'Barba desenhada e toalha quente.', schedule: JORNADA },
        { name: 'Ítalo Prado', bio: 'Corte social e infantil.', schedule: JORNADA },
      ],
    },
  });
  passo('três cadeiras com jornada aberta');

  await chamar('/v1/admin/payments', { metodo: 'PUT', token, corpo: { methods: ['pix', 'cash', 'card'] } });
  await chamar('/v1/admin/publish', { metodo: 'POST', token, corpo: {} });

  const alvos = await chamar('/v1/admin/photos', { token });
  await chamar('/v1/admin/photos', {
    metodo: 'PUT',
    token,
    corpo: {
      coverUrl: FOTOS.capa,
      professionals: alvos.professionals.map((p, i) => ({
        id: p.id,
        photoUrl: FOTOS.rostos[i % FOTOS.rostos.length],
      })),
      // Metade sem foto de propósito: é a mistura que se vê numa barbearia de
      // verdade, e é ela que mostra como a lista se comporta nos dois casos.
      services: alvos.services.map((s, i) => ({
        id: s.id,
        photoUrl: i % 2 === 0 ? FOTOS.cortes[i % FOTOS.cortes.length] : '',
      })),
    },
  });
  passo('barbearia publicada, com capa e fotos');

  return { token, slug: sessao.slug };
}

/**
 * A recepcionista, com conta que **entra** — e é ela quem abre o caixa.
 *
 * Ela vem antes do histórico de propósito: cada dia simulado registra quem
 * abriu e fechou a gaveta, e esse nome sai da conta que existe aqui. Sem ela,
 * o extrato do caixa e a trilha nomeariam alguém que não está na tela de
 * equipe — e "quem fez isso?" é a primeira pergunta de quem abre um
 * fechamento com diferença.
 */
async function convidarRecepcao(token) {
  const email = 'recepcao@teste.com';
  const convite = await chamar('/v1/admin/team', {
    metodo: 'POST',
    token,
    corpo: { name: 'Maria Aparecida do Nascimento', email, role: 'receptionist' },
  });
  if (convite?.senhaInicial) await estrear(email, convite.senhaInicial);
  passo('recepcionista na equipe, e é ela quem abre o caixa');
  return { papel: 'recepção', email };
}

// -- o dia -------------------------------------------------------------------

/**
 * Hoje, com gente em cada estado, e os próximos dias com agenda.
 *
 * Um dia com quatro linhas todas iguais não mostra o que o painel existe para
 * mostrar. Aqui há quem ainda vem, quem chegou, quem está na cadeira e quem já
 * foi atendido — o último com o botão de cobrar, que só aparece nele.
 */
async function encherODia(token, catalogo) {
  const { today } = await chamar('/v1/admin/day', { token });

  const gente = [
    ['Antônio Carlos Ribeiro', '(71) 98111-2266', ['check_in', 'start', 'complete']],
    ['Wesley Nunes', '(71) 98111-2277', ['check_in', 'start', 'complete']],
    ['João Pedro de Albuquerque Filho', '(71) 98111-2255', ['check_in', 'start']],
    ['Rafael Andrade', '(71) 98111-2288', ['check_in', 'start']],
    ['Maria Aparecida do Nascimento', '(71) 98111-2233', ['check_in']],
    ['Zé', '(71) 98111-2244', []],
    ['Marcos Vinícius Tavares', '(71) 98111-2299', []],
    ['Cauã Oliveira', '(71) 98111-2211', ['no_show']],
  ];

  const feitos = [];
  for (const [i, [name, phone, ate]] of gente.entries()) {
    const profissional = catalogo.professionals[i % catalogo.professionals.length];
    const servico = catalogo.services[i % Math.min(4, catalogo.services.length)];
    const grade = await chamar(
      `/v1/admin/availability?serviceIds=${servico.id}&professionalId=${profissional.id}` +
        `&dateFrom=${today}&dateTo=${today}`,
      { token },
    );
    const horario = grade.days[0]?.slots?.[Math.floor(i / catalogo.professionals.length)];
    if (!horario) continue;

    const criado = await chamar('/v1/admin/appointments', {
      metodo: 'POST',
      token,
      corpo: {
        name,
        phone,
        professionalId: profissional.id,
        serviceIds: [servico.id],
        date: today,
        start: horario.start,
      },
    }).catch(() => null);
    if (!criado?.id) continue;

    // Em ordem: a máquina de estados recusa pular etapa, e é ela que decide o
    // que a tela oferece em seguida.
    for (const acao of ate) {
      await chamar(`/v1/admin/appointments/${criado.id}/attendance`, {
        metodo: 'POST',
        token,
        corpo: { action: acao },
      });
    }
    feitos.push({ id: criado.id, name, atendido: ate.includes('complete') });
  }
  passo(`${feitos.length} atendimentos hoje, em cinco estados`);

  // Os próximos dias, para a agenda de semana não ser uma coluna só.
  let futuros = 0;
  for (const daqui of [1, 2, 3]) {
    const dia = somarDias(today, daqui);
    for (const [i, [name, phone]] of gente.slice(0, 4).entries()) {
      const profissional = catalogo.professionals[(i + daqui) % catalogo.professionals.length];
      const servico = catalogo.services[i % Math.min(4, catalogo.services.length)];
      const grade = await chamar(
        `/v1/admin/availability?serviceIds=${servico.id}&professionalId=${profissional.id}` +
          `&dateFrom=${dia}&dateTo=${dia}`,
        { token },
      );
      const horario = grade.days[0]?.slots?.[i * 2];
      if (!horario) continue;
      const ok = await chamar('/v1/admin/appointments', {
        metodo: 'POST',
        token,
        corpo: {
          name,
          phone,
          professionalId: profissional.id,
          serviceIds: [servico.id],
          date: dia,
          start: horario.start,
        },
      }).catch(() => null);
      if (ok?.id) futuros += 1;
    }
  }
  passo(`${futuros} horários marcados nos próximos dias`);

  return { today, feitos };
}

/** Um bloqueio e uma folga: agenda sem exceção não mostra o hachurado. */
async function marcarExcecoes(token, catalogo, hoje) {
  const amanha = somarDias(hoje, 1);
  await chamar('/v1/admin/agenda/blocks', {
    metodo: 'POST',
    token,
    corpo: {
      kind: 'block',
      date: amanha,
      startMinute: 13 * 60,
      endMinute: 14 * 60,
      professionalId: catalogo.professionals[0]?.id,
      reason: 'Consulta no dentista',
      confirmarConflitos: true,
    },
  });
  await chamar('/v1/admin/agenda/exceptions', {
    metodo: 'POST',
    token,
    corpo: {
      kind: 'day_off',
      date: somarDias(hoje, 2),
      professionalId: catalogo.professionals[2]?.id,
      reason: 'Folga combinada',
      confirmarConflitos: true,
    },
  });
  passo('um bloqueio e uma folga na agenda');
}

/** A fila de quem chegou sem hora marcada, com um já chamado. */
async function encherAFila(token, catalogo) {
  const servico = catalogo.services[0];
  for (const pessoa of [
    { name: 'Sebastião Farias', phone: '(71) 98111-3311' },
    { name: 'Igor', phone: '(71) 98111-3322', professionalId: catalogo.professionals[0]?.id },
    { name: 'Débora Cristina Menezes', phone: '(71) 98111-3333' },
  ]) {
    await chamar('/v1/admin/queue', {
      metodo: 'POST',
      token,
      corpo: { ...pessoa, serviceIds: [servico.id] },
    }).catch(() => null);
  }

  const fila = await chamar('/v1/admin/queue', { token });
  const primeira = fila.entries?.[0];
  if (primeira) {
    await chamar(`/v1/admin/queue/${primeira.id}/move`, {
      metodo: 'POST',
      token,
      corpo: { para: 'called' },
    });
  }
  passo('três na fila, um já chamado');
}

// -- o dinheiro --------------------------------------------------------------

/**
 * O segundo fator, e por que ele **não** aparece mais por padrão.
 *
 * Até o bloco 37 a exigência era imposta: toda rota de dinheiro pedia prova de
 * segundo fator, e a semeadura tinha que ligá-la para conseguir abrir o caixa.
 * O efeito colateral era o pior possível para uma demonstração — quem instalava
 * o produto para *olhar* encontrava "digite o código de seis dígitos" antes de
 * ver a primeira tela de dinheiro, com um segredo impresso no terminal e sem
 * aplicativo autenticador à mão.
 *
 * Agora a exigência é decisão da barbearia e nasce desligada. A semeadura segue
 * o padrão: nada de código para ver a demonstração. Quem quiser exercitar o
 * caminho com segundo fator liga na tela — `/admin/seguranca` — ou pede a
 * semeadura com `--com-2fa`.
 */
async function ligarSegundoFator(token) {
  const { codigoDoPasso, passoAgora } = await import(
    new URL('../packages/identity/dist/mfa.js', import.meta.url)
  );

  const { segredoBase32 } = await chamar('/v1/admin/mfa/setup', { metodo: 'POST', token });
  // O passo confirmado é queimado, então a verificação usa o seguinte — que já
  // é aceito agora, dentro da tolerância de ±1. Dormir 30s não traria nada.
  const agora = passoAgora(new Date());
  const { codigosDeRecuperacao } = await chamar('/v1/admin/mfa/confirm', {
    metodo: 'POST',
    token,
    corpo: { codigo: codigoDoPasso(segredoBase32, agora) },
  });
  await chamar('/v1/admin/mfa/verify', {
    metodo: 'POST',
    token,
    corpo: { codigo: codigoDoPasso(segredoBase32, agora + 1) },
  });
  passo('segundo fator cadastrado nesta conta');
  // Os códigos de recuperação são a saída que a própria tela promete — "perdeu
  // o celular? digite um código que você anotou". Descartá-los aqui deixaria a
  // promessa sem lastro para quem perder o segredo, e a única saída seria
  // recomeçar tudo com --zerar.
  return { segredoBase32, codigosDeRecuperacao };
}

/**
 * Liga a exigência para a barbearia inteira.
 *
 * Separado de `ligarSegundoFator`, que é sobre **uma conta**: cadastrar o TOTP
 * do dono não faz o caixa pedir código. Quem decide isso é a barbearia, e a
 * decisão nasce desligada — então a semeadura com `--com-2fa` precisa das duas
 * coisas, e nesta ordem: ligar a exigência antes de cadastrar trancaria a
 * própria semeadura para fora do caixa.
 */
async function exigirSegundoFatorNaBarbearia(token) {
  await chamar('/v1/admin/mfa/policy', {
    metodo: 'PUT',
    token,
    corpo: { exigir: true },
  });
  passo('a barbearia passou a exigir o código no financeiro');
}

/**
 * Caixa, vendas fechadas, um fiado e uma comanda em aberto.
 *
 * Sem venda fechada o painel do dono mostra zero, a comissão fica vazia e o
 * fechamento de caixa não tem o que conferir — três telas medindo o estado
 * vazio, que é justamente o que não revela nada.
 */
async function moverDinheiro(token, catalogo) {
  await chamar('/v1/admin/cash/open', { metodo: 'POST', token, corpo: { openingCents: 20000 } });

  await chamar('/v1/admin/commission/rules', {
    metodo: 'PUT',
    token,
    corpo: { modo: 'percent', valor: 4000 },
  });
  // Uma regra por profissional e uma com faixas: é assim que a tela mostra que
  // a específica vence a geral, e que a faixa é marginal.
  await chamar('/v1/admin/commission/rules', {
    metodo: 'PUT',
    token,
    corpo: { professionalId: catalogo.professionals[0]?.id, modo: 'percent', valor: 4500 },
  }).catch(() => null);
  await chamar('/v1/admin/commission/rules', {
    metodo: 'PUT',
    token,
    corpo: {
      professionalId: catalogo.professionals[1]?.id,
      modo: 'tiers',
      valor: 0,
      faixas: [
        { ateCents: 500000, pontosBase: 4000 },
        { ateCents: 800000, pontosBase: 4500 },
        { ateCents: null, pontosBase: 5000 },
      ],
    },
  }).catch(() => null);
  passo('caixa aberto e três regras de comissão');

  const vender = async ({ itens, pagamentos, customerId }) => {
    const comanda = await chamar('/v1/admin/orders', {
      metodo: 'POST',
      token,
      corpo: customerId ? { customerId } : {},
      cabecalhos: { 'idempotency-key': `demo-${Math.abs(Date.now() % 1e9)}-${itens[0].descricao.length}` },
    });
    for (const item of itens) {
      await chamar(`/v1/admin/orders/${comanda.id}/items`, {
        metodo: 'POST',
        token,
        corpo: { tipo: 'service', quantidade: 1, professionalId: catalogo.professionals[0]?.id, ...item },
      });
    }
    if (pagamentos) {
      await chamar(`/v1/admin/orders/${comanda.id}/close`, {
        metodo: 'POST',
        token,
        corpo: { pagamentos },
        cabecalhos: { 'idempotency-key': `fecha-${comanda.id}` },
      });
    }
    return comanda.id;
  };

  // Três vendas fechadas, uma por meio de pagamento: o fechamento de caixa só
  // faz sentido quando dinheiro, Pix e cartão discordam entre si — só o
  // primeiro entra na gaveta.
  await vender({
    itens: [{ descricao: 'Corte degradê com máquina e tesoura', precoUnitarioCents: 6500 }],
    pagamentos: [{ forma: 'cash', valorCents: 10000 }],
  });
  await vender({
    itens: [
      { descricao: 'Corte social', precoUnitarioCents: 5500 },
      { descricao: 'Barba terapêutica com toalha quente', precoUnitarioCents: 4900 },
    ],
    pagamentos: [{ forma: 'pix', valorCents: 10400 }],
  });
  await vender({
    itens: [{ descricao: 'Corte + barba', precoUnitarioCents: 9900 }],
    pagamentos: [{ forma: 'credit', valorCents: 9900 }],
  });
  passo('três vendas fechadas: dinheiro, Pix e cartão de crédito');

  /**
   * O fiado **não** é semeado, e não é esquecimento.
   *
   * `customers.credit_limit_cents` nasce em 0 e **nenhuma tela ou rota do
   * produto o escreve** — então toda venda fiada é recusada por estourar um
   * limite que ninguém consegue levantar. A SPEC §3.10 marca o fiado como
   * obrigatório para migrar do incumbente, e a tela `/admin/fiado` existe.
   *
   * Semear por fora escondendo isso seria pior que a tela vazia: a
   * demonstração mostraria um recurso que o produto não entrega. Está
   * declarado em ROADMAP.md, nas lacunas.
   */

  await chamar('/v1/admin/cash/movements', {
    metodo: 'POST',
    token,
    corpo: { kind: 'withdrawal', amountCents: 15000, reason: 'Depósito no banco da avenida' },
  }).catch(() => null);

  // E uma comanda **aberta**, para a tela de cobrar ter o que mostrar.
  await vender({
    itens: [
      { descricao: 'Corte degradê com máquina e tesoura', precoUnitarioCents: 6500 },
      { descricao: 'Sobrancelha na navalha', precoUnitarioCents: 2000 },
    ],
  });
  passo('uma sangria e uma comanda em aberto');
}

// -- o barbeiro --------------------------------------------------------------

/**
 * A conta do barbeiro, que tem tela própria (`/admin/meu-dia`).
 *
 * Ela é metade do produto e não se vê com o cookie do dono: com ele a tela
 * renderiza, mas mostrando o salão inteiro — que é justamente o layout que ela
 * existe para não ter.
 */
/** Destranca a conta recém-criada: a senha de primeiro acesso é de uso único. */
async function estrear(email, senhaInicial) {
  const primeira = await chamar('/v1/admin/login', {
    metodo: 'POST',
    corpo: { email, password: senhaInicial },
  });
  await chamar('/v1/admin/me/password', {
    metodo: 'PUT',
    token: primeira.token,
    corpo: { currentPassword: senhaInicial, newPassword: SENHA_DA_EQUIPE },
  });
}

/**
 * Uma conta por cadeira, e uma meta para cada uma.
 *
 * As três, e não uma: o histórico simulado tem três barbeiros com procura
 * diferente, e é entrando com cada um que se vê o que a §4.21 da SPEC promete —
 * o indicador comparado com o **próprio** passado. Com uma conta só, duas das
 * três telas de barbeiro que existem no produto ficam por conta da imaginação.
 *
 * A meta é do mês e por pessoa (bloco 22): sem ela a tela mostra "sem meta",
 * que é o estado mais curto e o menos parecido com uma casa em operação.
 */
async function convidarEquipe(token, catalogo, hoje, fundo) {
  const contas = [];

  for (const [i, cadeira] of catalogo.professionals.entries()) {
    const email = `barbeiro${i + 1}@teste.com`;
    const convite = await chamar('/v1/admin/team/invite', {
      metodo: 'POST',
      token,
      corpo: { professionalId: cadeira.id, email },
    }).catch(() => null);
    if (!convite) continue;

    await estrear(email, convite.senhaInicial);

    /**
     * A meta sai do que **aquela** cadeira faturou nos últimos trinta dias.
     *
     * É o que o produto já sugere na tela (bloco 22), e é a única forma de a
     * meta conversar com a pessoa que a recebeu: um número igual para os três
     * faria o barbeiro que entrou há quatro meses abrir o mês com 40% do alvo
     * e o mais procurado com 110% — e a §4.21 diz que o indicador se compara
     * com o próprio passado, não com o do colega.
     */
    const ultimoMes = fundo?.cadeiras?.find((c) => c.id === cadeira.id)?.ultimoMesCents ?? 0;
    const meta = Math.max(300_000, Math.round((ultimoMes * 1.1) / 10_000) * 10_000);
    await chamar('/v1/admin/pro/goals', {
      metodo: 'PUT',
      token,
      corpo: { professionalId: cadeira.id, mes: `${hoje.slice(0, 7)}-01`, metaCents: meta },
    }).catch(() => null);

    contas.push({ papel: `barbeiro — ${cadeira.name}`, email });
  }

  /**
   * E o gerente, que é o papel do meio e o mais fácil de esquecer.
   *
   * Ele tem o financeiro e a operação e **não** tem a margem, o custo de
   * insumo nem o limite de fiado — é assim que o dono delega o dia a dia sem
   * entregar a estratégia. Entrar com ele é a única forma de ver que a tela
   * esconde o que a guarda recusaria, em vez de mostrar botão que dá 403.
   */
  const gerente = 'gerente@teste.com';
  const conviteDoGerente = await chamar('/v1/admin/team', {
    metodo: 'POST',
    token,
    corpo: { name: 'Simone Andrade Requião', email: gerente, role: 'manager' },
  }).catch(() => null);
  if (conviteDoGerente?.senhaInicial) {
    await estrear(gerente, conviteDoGerente.senhaInicial);
    contas.push({ papel: 'gerente', email: gerente });
  }

  passo(`${contas.length} contas de equipe, cada uma com a tela dela`);
  return contas;
}

/**
 * A ficha de um cliente de verdade, escolhido por ter história.
 *
 * Ele é o quinto papel da demonstração — quem entra pela página pública e vê a
 * própria agenda —, e por isso não pode ser um cadastro qualquer: precisa ser
 * alguém com meses de atendimento, saldo de fidelidade e barbeiro de sempre,
 * senão a tela do cliente abre no estado vazio enquanto o painel do dono está
 * cheio. Duas telas contando histórias diferentes sobre a mesma casa é o que a
 * §6 pergunta 6 proíbe.
 *
 * A escolha é **por dado**, não por nome: quem mais voltou.
 */
async function encherUmaFicha(token, vitrine) {
  if (!vitrine) return null;
  const cliente = { id: vitrine.id, name: vitrine.nome, phone: vitrine.telefone };

  await chamar(`/v1/admin/customers/${cliente.id}/preferences`, {
    metodo: 'PUT',
    token,
    corpo: {
      produtosEvitar: 'Pós-barba com álcool e qualquer produto com mentol',
      maquinaLaterais: 'Máquina 1 com pente de meio',
      tipoDegrade: 'Degradê médio, começando na altura da orelha',
      topo: 'Tesoura, deixando comprimento',
      barbaEstilo: 'Aparar sem navalha, manter o desenho do queixo',
      conversa: 'silencioso',
      observacoes:
        'Redemoinho do lado direito abre para cima. Não gosta de espelho na frente durante o corte.',
    },
  }).catch(() => null);
  passo(`ficha preenchida: ${cliente.name}, ${vitrine.visitas} atendimentos`);
  return cliente;
}

// -- fim ---------------------------------------------------------------------

async function main() {
  if (await jaExiste()) {
    console.log(cinza('    a barbearia de demonstração já existe; nada a semear'));
    contar({});
    return;
  }

  const { token, slug } = await abrirBarbearia();
  const recepcao = await convidarRecepcao(token);

  /**
   * O passado, antes do dia de hoje.
   *
   * Ele vem primeiro porque o resto da semeadura monta **hoje** pela API, e
   * hoje precisa cair sobre uma casa que já tem clientela, histórico e ritmo —
   * senão a demonstração abre num painel onde todo indicador é o primeiro do
   * seu tipo e todo comparativo é contra o nada.
   *
   * Sem `ADMIN_DATABASE_URL` isto é pulado com aviso, e não com erro: a
   * demonstração continua funcionando, só que rasa. Dizer isso é obrigatório —
   * uma semeadura que silenciosamente entrega menos é como alguém conclui que
   * o produto não tem relatório.
   */
  const bancoAdmin = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  let fundo = null;
  if (bancoAdmin) {
    fundo = await semearFundo({ url: bancoAdmin, slug });
    passo(
      `${fundo.dias} dias de história: ${fundo.atendimentos} atendimentos, ` +
        `${fundo.clientes} clientes, ${fundo.vendas} vendas, ${fundo.avaliacoes} avaliações`,
    );

    /**
     * E o resto da casa, que o movimento não produz sozinho.
     *
     * Área vazia não é área neutra: o DRE com "Produtos R$ 0,00" ao lado de uma
     * agenda cheia diz que a barbearia não vende na prateleira, e quem olha
     * conclui que o relatório não funciona.
     */
    const detalhes = semearDetalhes({ url: bancoAdmin, slug });
    passo(
      `prateleira, clube, pacote, financeiro e integrações: ` +
        `${detalhes.produtos} produtos e ${detalhes.fieis} clientes com histórico`,
    );
  } else {
    console.log(cinza('    sem ADMIN_DATABASE_URL: a barbearia nasce sem histórico'));
  }

  const catalogo = await chamar('/v1/admin/catalog', { token });
  const { today } = await encherODia(token, catalogo);
  await marcarExcecoes(token, catalogo, today);
  await encherAFila(token, catalogo);

  /**
   * Ligar o segundo fator é opcional, e desligado é o padrão.
   *
   * A demonstração existe para a pessoa **ver o produto**. Um código de seis
   * dígitos entre ela e a primeira tela de caixa não demonstra segurança:
   * demonstra atrito. Quem quiser exercitar o caminho protegido passa
   * `--com-2fa`, e aí a semeadura liga a exigência da barbearia junto — senão o
   * segredo impresso no terminal não protegeria nada.
   */
  const com2fa = process.argv.includes('--com-2fa');
  const segundoFator = com2fa ? await ligarSegundoFator(token) : {};
  if (com2fa) await exigirSegundoFatorNaBarbearia(token);
  const { segredoBase32: segredo, codigosDeRecuperacao: recuperacao } = segundoFator;

  await moverDinheiro(token, catalogo);

  const equipe = await convidarEquipe(token, catalogo, today, fundo);
  const vitrine = await encherUmaFicha(token, fundo?.vitrine);

  contar({ slug, segredo, recuperacao, contas: [recepcao, ...equipe], vitrine });
}

function contar({ slug, segredo, recuperacao, contas = [], vitrine }) {
  const linha = (rotulo, valor) => console.log(`      ${rotulo.padEnd(11)}${valor}`);

  console.log('');
  console.log(`    ${verde('painel da barbearia')}  ${WEB}/admin/entrar`);
  linha('e-mail', DONO.email);
  linha('senha', DONO.password);

  /**
   * Uma linha por papel, porque **cada papel vê outra coisa**.
   *
   * O produto não é uma tela com permissões: o barbeiro tem `/admin/meu-dia`, o
   * gerente tem o financeiro sem a margem, a recepção tem o balcão sem o
   * relatório, e o cliente tem a própria agenda. Entregar só a conta do dono é
   * demonstrar um quarto do que foi construído — e é o dono a única pessoa que
   * nunca vai operar o balcão o dia inteiro.
   */
  if (contas.length > 0) {
    console.log('');
    console.log(`    ${verde('a mesma casa, pelo olho de cada um')}  (senha: ${SENHA_DA_EQUIPE})`);
    for (const conta of contas) {
      const largura = Math.max(...contas.map((c) => c.papel.length)) + 2;
      console.log(`      ${conta.papel.padEnd(largura)}${conta.email}`);
    }
  }

  if (slug) {
    console.log('');
    console.log(`    ${verde('a página do cliente')}  ${WEB}/${slug}`);
    if (vitrine?.phone) {
      linha('entre com', `${vitrine.phone}  (${vitrine.name})`);
    }
    console.log(cinza(`      O código de acesso do cliente sai no log da API — não há SMS aqui.`));
  }

  if (segredo) {
    console.log('');
    console.log(`    ${verde('segundo fator')}  ${segredo}`);
    console.log(cinza('      Você pediu --com-2fa: as telas de dinheiro — caixa, comanda, fiado,'));
    console.log(cinza('      comissão — exigem prova, e a prova vence em 30 min.'));
    console.log(cinza(''));
    console.log(cinza('      Cadastre em qualquer aplicativo autenticador (chave manual, base32) —'));
    console.log(cinza('      ou, em máquina onde não dá para instalar aplicativo, peça o código aqui:'));
    console.log(cinza(''));
    console.log(`      node scripts/codigo-2fa.mjs ${segredo}`);
    console.log(cinza(''));
    console.log(cinza('      Se o código for recusado logo depois desta mensagem, espere 30s: a'));
    console.log(cinza('      semeadura consome dois passos, e o passo usado não vale duas vezes.'));
    console.log(cinza(''));
    console.log(cinza('      \u26a0  Anote este segredo. Ele é impresso uma vez só — depois fica'));
    console.log(cinza('         cifrado no banco, e recuperá-lo exige recomeçar com --zerar.'));
    if (recuperacao?.length) {
      console.log(cinza(''));
      console.log(`      códigos de recuperação: ${recuperacao.join('  ')}`);
      console.log(cinza('      Cada um serve uma vez, no lugar do código de seis dígitos.'));
    }
  }

  console.log('');
  // A frase agora é verdade porque foi conferida: o script recusa alvo remoto
  // logo na subida. Antes ela era uma suposição sobre onde o comando foi
  // digitado — e era a única coisa protegendo a conta de dono.
  console.log(cinza(`    Credenciais de demonstração, contra ${new URL(API).hostname}.`));
  console.log(cinza('    O script recusa alvo que não seja local, e o produto não tem senha padrão.'));
}

main().catch((erro) => {
  console.error(`\n    falhou: ${erro.message}\n`);
  if (erro.cause) console.error(`    causa: ${erro.cause.message ?? erro.cause}\n`);
  console.error(erro.stack);
  process.exit(1);
});
