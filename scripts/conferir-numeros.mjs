/**
 * O mesmo fato, perguntado por caminhos diferentes — e por papéis diferentes.
 *
 *   DEMO_DATABASE_URL=... API_URL=... node scripts/conferir-numeros.mjs
 *
 * ## O que só isto pega
 *
 * `conferir-telas.mjs` responde "o dado está no banco e está na tela?".
 * Esta responde a outra metade, que é a §6 pergunta 6: **duas telas que mostram
 * o mesmo fato concordam?**
 *
 * Ele não aparece olhando uma tela de cada vez, porque cada uma é coerente
 * sozinha. Foi assim que o painel passou meses somando a gorjeta no faturamento
 * enquanto o DRE não somava, e assim que o desconto sumia do resultado — os dois
 * achados vieram de comparar dois números que ninguém tinha comparado.
 *
 * E o recorte por papel importa: a comissão que o gerente vê da equipe e a que o
 * barbeiro vê de si mesmo saem de rotas diferentes. Se elas divergirem, um dos
 * dois está sendo enganado sobre o próprio dinheiro — e é o tipo de divergência
 * que só aparece quando alguém reclama.
 */

import { execFileSync } from 'node:child_process';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const BANCO = process.env.DEMO_DATABASE_URL;
if (!BANCO) throw new Error('DEMO_DATABASE_URL é obrigatória');
const SENHA = process.env.MEDICAO_SENHA ?? 'testeteste';

const consultar = (sql) =>
  execFileSync('psql', [BANCO, '-tAc', sql], { encoding: 'utf8' }).trim();

async function chamar(rota, token) {
  const r = await fetch(`${API}${rota}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${rota} → ${r.status} ${texto.slice(0, 160)}`);
  return texto ? JSON.parse(texto) : null;
}

async function entrar(email) {
  const r = await fetch(`${API}/v1/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: SENHA }),
  });
  if (!r.ok) throw new Error(`login de ${email} → ${r.status}`);
  return (await r.json()).token;
}

const falhas = [];
const reais = (c) => `R$ ${(Number(c) / 100).toFixed(2)}`;

/**
 * Compara, e **diz o que cada lado respondeu**.
 *
 * Um relatório que só diz "não bate" manda quem lê reproduzir tudo à mão.
 */
function bate(assunto, a, b, formatar = reais) {
  const iguais = Number(a.valor) === Number(b.valor);
  console.log(
    `${iguais ? '\x1b[32mok   \x1b[0m' : '\x1b[31mDIFERE\x1b[0m'} ${assunto.padEnd(42)} ` +
      `${a.quem}: ${formatar(a.valor)}   ${b.quem}: ${formatar(b.valor)}`,
  );
  if (!iguais) {
    falhas.push(
      `${assunto}: ${a.quem} diz ${formatar(a.valor)} e ${b.quem} diz ${formatar(b.valor)} ` +
        `(diferença de ${formatar(Math.abs(Number(a.valor) - Number(b.valor)))})`,
    );
  }
}

const dono = await entrar('teste@teste.com');
const gerente = await entrar('gerente@teste.com');
const barbeiro = await entrar('barbeiro2@teste.com');

const mes = consultar(`SELECT to_char(date_trunc('month', current_date), 'YYYY-MM-DD')`);
const fim = consultar(`SELECT to_char(current_date, 'YYYY-MM-DD')`);

// ---------------------------------------------------------------------------
// 1 — quanto a casa faturou no mês
// ---------------------------------------------------------------------------

const painel = await chamar('/v1/admin/dashboard/revenue?periodo=mes', dono);
const dre = await chamar(`/v1/admin/dre?de=${mes}&ate=${fim}`, dono);
const noBanco = Number(
  consultar(
    `SELECT coalesce(sum(total_cents - tip_cents), 0) FROM orders
      WHERE status='paid' AND business_day BETWEEN '${mes}' AND '${fim}'`,
  ),
);

bate(
  'faturamento do mês: painel × banco',
  { quem: 'painel', valor: painel.faturamentoCents?.valor ?? painel.faturamentoCents ?? 0 },
  { quem: 'banco', valor: noBanco },
);

/**
 * O DRE e o painel **não somam a mesma coisa**, e a diferença é escrita.
 *
 * O DRE reconhece a receita do pacote no **consumo**, não na venda: é o que a
 * SPEC §4.7 manda, e sem isso o relatório mostraria um mês excelente seguido de
 * meses falsamente ruins. O painel soma a comanda paga. Então a conta que tem
 * que fechar é: bruto do DRE menos desconto = comanda paga + pacote
 * reconhecido. Se sobrar diferença, é defeito de verdade.
 */
const pacoteReconhecido = Number(
  consultar(
    `SELECT coalesce(sum(value_cents), 0) FROM package_uses
      WHERE business_day BETWEEN '${mes}' AND '${fim}'`,
  ),
);
/**
 * E a mensalidade do clube, que também não passa pela comanda.
 *
 * `club_invoices` é o que o cliente paga à barbearia, reconhecido pela fatura
 * **paga** com o valor congelado na emissão. O painel soma comanda; o DRE soma
 * os três fatos. A conta que fecha é a soma dos três.
 */
const assinaturaReconhecida = Number(
  consultar(
    `SELECT coalesce(sum(amount_cents), 0) FROM club_invoices
      WHERE status = 'paga' AND (paid_at AT TIME ZONE 'UTC')::date BETWEEN '${mes}' AND '${fim}'`,
  ),
);
bate(
  'faturamento do mês: DRE × comanda + pacote + clube',
  { quem: 'o DRE', valor: dre.atual.receitaBrutaCents - dre.atual.descontosCents },
  {
    quem: 'a soma dos três',
    valor: (painel.faturamentoCents?.valor ?? 0) + pacoteReconhecido + assinaturaReconhecida,
  },
);

// ---------------------------------------------------------------------------
// 2 — a comissão do barbeiro, por ele e pelo gerente
// ---------------------------------------------------------------------------

const meuNome = consultar(
  `SELECT p.name FROM staff_users s JOIN professionals p ON p.id = s.professional_id
    WHERE s.email = 'barbeiro2@teste.com'`,
);
const minha = await chamar(`/v1/admin/commission/mine?de=${mes}&ate=${fim}`, barbeiro);
const daCasa = await chamar(`/v1/admin/commission?de=${mes}&ate=${fim}`, gerente);

const somar = (extrato) =>
  (extrato.linhas ?? extrato.profissionais ?? []).reduce(
    (s, l) => s + Number(l.totalCents ?? l.comissaoCents ?? 0),
    0,
  );
const doGerente = (daCasa.linhas ?? daCasa.profissionais ?? []).filter(
  (l) => (l.profissional ?? l.nome ?? l.professionalName) === meuNome,
);

bate(
  `comissão de ${meuNome} no mês: ele × gerente`,
  { quem: 'o barbeiro', valor: somar(minha) },
  { quem: 'o gerente', valor: somar({ linhas: doGerente }) },
);

// ---------------------------------------------------------------------------
// 3 — a nota da casa, por dentro e por fora
// ---------------------------------------------------------------------------

const slug = consultar(`SELECT slug FROM tenant_slugs ORDER BY created_at LIMIT 1`);
// A nota mora na rota de avaliações, não no perfil: são duas leituras
// diferentes da mesma casa, e é a de avaliações que a página desenha.
const publica = await chamar(`/v1/b/${slug}/avaliacoes`);
const naVitrine = Number(consultar(`SELECT coalesce(rating_bps, 0) FROM marketplace_listings LIMIT 1`));
/**
 * Com **uma casa decimal**, que é a convenção do produto desde o bloco 43.
 *
 * A primeira versão desta consulta arredondava para duas e acusava a página de
 * dizer 4,70 onde "o banco" dizia 4,69. Uma conferência que impõe a própria
 * precisão vira o terceiro número sobre o mesmo fato — exatamente o que ela
 * existe para não deixar acontecer.
 */
const publicadas = Number(
  consultar(
    `SELECT coalesce(round(avg(rating) * 10) * 10, 0) FROM reviews
      WHERE contested_at IS NULL AND (rating >= 4 OR created_at < now() - interval '48 hours')`,
  ),
);

const notaPublica = Math.round((publica.media ?? 0) * 100);
bate(
  'nota pública: página × vitrine do marketplace',
  { quem: 'a página', valor: notaPublica },
  { quem: 'a vitrine', valor: naVitrine },
  (v) => (Number(v) / 100).toFixed(2),
);
bate(
  'nota pública: página × o que é publicável no banco',
  { quem: 'a página', valor: notaPublica },
  { quem: 'o banco', valor: publicadas },
  (v) => (Number(v) / 100).toFixed(2),
);

// ---------------------------------------------------------------------------
// 4 — o que um cliente deve, na tela do fiado e no cadastro
// ---------------------------------------------------------------------------

const devedor = consultar(
  `SELECT id FROM customers WHERE balance_cents > 0 ORDER BY balance_cents DESC LIMIT 1`,
);
if (devedor) {
  const extrato = await chamar(`/v1/admin/financeiro/clientes/${devedor}/fiado`, gerente);
  const noCadastro = Number(consultar(`SELECT balance_cents FROM customers WHERE id = '${devedor}'`));
  const noRazao = Number(
    consultar(`SELECT coalesce(sum(amount_cents), 0) FROM customer_ledger WHERE customer_id = '${devedor}'`),
  );
  bate(
    'fiado do cliente: extrato × razão',
    { quem: 'o extrato', valor: extrato.saldoCents ?? extrato.saldo ?? 0 },
    { quem: 'o razão', valor: noRazao },
  );
  bate(
    'fiado do cliente: cadastro × razão',
    { quem: 'o cadastro', valor: noCadastro },
    { quem: 'o razão', valor: noRazao },
  );
}

// ---------------------------------------------------------------------------
// 5 — o saldo de fidelidade, na ficha e no razão
// ---------------------------------------------------------------------------

const comPontos = consultar(
  `SELECT customer_id FROM loyalty_entries GROUP BY 1 ORDER BY sum(amount) DESC LIMIT 1`,
);
if (comPontos) {
  const ficha = await chamar(`/v1/admin/fidelidade/clientes/${comPontos}`, gerente);
  const noRazao = Number(
    consultar(`SELECT coalesce(sum(amount), 0) FROM loyalty_entries WHERE customer_id = '${comPontos}'`),
  );
  bate(
    'saldo de fidelidade: ficha × razão',
    { quem: 'a ficha', valor: ficha.saldo ?? ficha.saldoAtual ?? 0 },
    { quem: 'o razão', valor: noRazao },
    (v) => `${v} pts`,
  );
}

// ---------------------------------------------------------------------------
// 6 — o estoque, na tela e na soma dos movimentos
// ---------------------------------------------------------------------------

const estoque = await chamar('/v1/admin/estoque/produtos', gerente).catch(() => null);
if (estoque?.produtos?.length) {
  const primeiro = estoque.produtos[0];
  const noBancoSaldo = Number(
    consultar(`SELECT coalesce(sum(quantity), 0) FROM stock_movements WHERE product_id = '${primeiro.id}'`),
  );
  bate(
    `estoque de "${String(primeiro.nome ?? primeiro.name).slice(0, 24)}": tela × movimentos`,
    { quem: 'a tela', valor: primeiro.saldo },
    { quem: 'os movimentos', valor: noBancoSaldo },
    (v) => `${v} un`,
  );
}

// ---------------------------------------------------------------------------

console.log('');
if (falhas.length > 0) {
  console.log(`\x1b[31mnúmeros: ${falhas.length} divergência(s).\x1b[0m`);
  for (const f of falhas) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('\x1b[32mnúmeros: todos os fatos batem por todos os caminhos.\x1b[0m');
