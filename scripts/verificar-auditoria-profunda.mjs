#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ler = (p) => readFileSync(p, 'utf8');
const falhas = [];
const exige = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

const pacoteCore = ler('packages/core/src/pacote.ts');
const pacoteFinance = ler('packages/finance/src/pacote.ts');
const dre = ler('packages/finance/src/dre.ts');
const segmento = ler('apps/api/src/admin/segmento.controller.ts');
const churn = ler('apps/api/src/admin/churn.controller.ts');
const insight = ler('apps/api/src/admin/insight.controller.ts');
const secoes = ler('apps/web/src/app/admin/secoes.ts');
const painelWeb = ler('apps/web/src/app/admin/painel/page.tsx');
const timeout = ler('apps/web/src/lib/fetch-com-timeout.ts');
const adminApi = ler('apps/web/src/lib/admin-api/core.ts');
const plataformaApi = ler('apps/web/src/lib/plataforma-api.ts');
const apiPublica = ler('apps/web/src/lib/api.ts');
const otp = ler('packages/identity/src/otp.ts');
const alertas = ler('packages/jobs/src/alertas.ts');
const meus = ler('apps/web/src/app/[slug]/meus-agendamentos/page.tsx');
const pagamento = ler('packages/core/src/pagamento.ts');
const clube = ler('packages/finance/src/cobranca-do-clube.ts');
const metricasPlataforma = ler('packages/platform/src/metricas.ts');
const atribuicaoPlataforma = ler('packages/platform/src/atribuicao.ts');
const seriePlataforma = ler('packages/platform/src/serie.ts');

// Pacotes: centavos exatos, passivo e breakage.
exige(pacoteCore.includes('readonly precoCents: number'), 'P1: PacoteDoCliente perdeu o preço total congelado');
exige(pacoteCore.includes('valorDoProximoConsumo') && pacoteCore.includes('restoDaPrimeiraUnidade'), 'P1: primeira unidade do pacote voltou a perder o resto da divisão');
exige(pacoteCore.includes('precoCents - reconhecidoDoPacote'), 'P1: diferido/reembolso voltou a derivar só de unit_value × restante');
exige(pacoteFinance.includes('vencidoCents') && pacoteFinance.includes('cp.price_cents - COALESCE'), 'P1: saldo vencido do pacote deixou de virar receita');
exige(pacoteFinance.includes('venda.location_id = ${params.locationId}::uuid'), 'P2: receita/passivo de pacote voltou a atravessar unidades');

// DRE: fonte econômica do pagamento, sem dupla contagem.
exige(!dre.includes('+ pacotesReconhecidos') && !dre.includes('package_uses u\n      JOIN orders'), 'P1: DRE voltou a somar package_uses por cima do item de serviço');
exige(dre.includes("p.method = 'assinatura'") && dre.includes('- centavos(cobertoPelaAssinatura'), 'P1: DRE voltou a reconhecer benefício do clube como receita adicional');
exige(dre.includes('pacotesVencidos') && dre.includes('+ centavos(pacotesVencidos'), 'P1: breakage de pacote não entra no DRE');
exige(dre.includes('cp.expires_at <= ${params.agora}'), 'P1: DRE voltou a reconhecer breakage antes do horário exato do vencimento');
exige(pacoteFinance.includes('cp.expires_at <= ${agora}'), 'P1: card de pacotes voltou a reconhecer breakage antes do horário exato');
exige(dre.includes("AT TIME ZONE COALESCE(l.timezone, 'UTC')"), 'P2: mensalidade voltou a usar UTC mesmo quando a assinatura tem unidade');
exige(dre.includes('s.location_id = ${params.locationId}::uuid') && !dre.includes('s.location_id IS NULL\n           OR s.location_id'), 'P2: assinatura histórica sem unidade voltou a ser atribuída a todas as lojas');

// Relacionamento inferido exige a camada de notas/insights.
exige(segmento.includes("@Exige('customers.view', 'customers.view_notes')"), 'P1: Segmentos voltou a furar customers.view_notes');
exige(churn.includes("@Exige('customers.view', 'customers.view_notes', 'reviews.view')"), 'P1: Churn voltou a furar customers.view_notes');
exige(churn.includes("@Exige('finance.view', 'reports.finance', 'customers.view', 'customers.view_notes')"), 'P1: Crescimento voltou a inferir segmentos sem customers.view_notes');
exige(insight.includes("'customers.view_notes'"), 'P1: Insights voltou a inferir segmentos sem customers.view_notes');
exige(painelWeb.includes('const podeVerInsights') && painelWeb.includes("podeNaTela(estado, 'customers.view_notes')"), 'P1: Painel voltou a chamar Insights sem conferir a permissão agregada');
exige(secoes.includes("['customers.view', 'customers.view_notes', 'reviews.view']"), 'P1: navegação de Retenção não acompanha as permissões da rota');

// API interna precisa falhar rápido quando Nest fica pendurado.
exige(timeout.includes('AbortSignal.timeout') && timeout.includes('ApiTimeoutError'), 'P2: wrapper de timeout da API interna sumiu');
exige(adminApi.includes('fetchComTimeout('), 'P2: admin-api voltou a usar fetch sem timeout');
exige(plataformaApi.includes('fetchComTimeout('), 'P2: plataforma-api voltou a usar fetch sem timeout');
exige(apiPublica.includes('fetchComTimeout('), 'P2: API pública server-side voltou a usar fetch sem timeout');

// OTP: falha do provedor não pode invalidar um desafio que já funcionava.
exige(otp.includes('code.anterior') && otp.includes('hashGerado') && otp.includes('DELETE FROM otp_challenges'), 'P2: OTP perdeu a compensação após falha do provedor');
exige(!/export interface GuestIdentity\s*\{[\s\S]*?readonly tenantId:[^\n]+\n\s*readonly tenantId:/.test(otp), 'Semântico: GuestIdentity voltou a declarar tenantId duas vezes');

// Dia operacional é o da unidade, inclusive nos jobs e na tela do cliente.
exige(alertas.includes('AT TIME ZONE l.timezone'), 'P2: alerta de demanda voltou a recortar o dia por UTC');
exige((meus.match(/timeZone: profile\.location\.timezone/g) ?? []).length >= 2, 'P2: datas públicas voltaram a depender do timezone do processo');

// Clube: o contrato obriga o provider real a receber chave de idempotência.
exige(pagamento.includes('readonly idempotencyKey: string') && pagamento.includes('export function chaveDoClube'), 'P2: contrato do clube perdeu a chave de idempotência');
exige(clube.includes('idempotencyKey: chaveDoClube(pedidoBase)'), 'P2: régua do clube não entrega chave de idempotência ao provider');
exige(metricasPlataforma.includes('inteiroSeguroDoBanco') && !metricasPlataforma.includes('mrrCents: Number(') && !metricasPlataforma.includes('receitaCents: Number('), 'P2: métricas globais voltaram a converter agregado monetário sem checar precisão');
exige(atribuicaoPlataforma.includes("inteiroSeguroDoBanco(linhas[0]?.soma"), 'P2: faturamento de marketplace voltou a converter soma monetária sem checar precisão');
exige(atribuicaoPlataforma.includes('Comissão pendente do marketplace') && !atribuicaoPlataforma.includes('const total = Number(linhas[0]?.total'), 'P2: comissão pendente do marketplace voltou a converter soma sem checar precisão');
exige(seriePlataforma.includes("inteiroSeguroDoBanco(l.total, 'MRR mensal')") && !seriePlataforma.includes('mrrCents: Number(l.total)') && !seriePlataforma.includes('Math.max(m, Number(l.total))'), 'P2: série histórica de MRR voltou a converter agregado monetário sem checar precisão');

// Nunca rebaixar soma monetária para int4: quantidade pode continuar ::int.
const fontes = (dir) => {
  const saida = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...fontes(caminho));
    else if (/\.(?:ts|tsx)$/.test(entrada.name)) saida.push(caminho);
  }
  return saida;
};
const arquivos = [
  ...fontes('packages/finance/src'),
  ...fontes('packages/crm/src'),
  ...fontes('packages/platform/src'),
];
const padraoMonetario = /sum\([^\n]*(?:amount_cents|total_cents|balance_cents|fee_cents|unit_price_cents)[^\n]*\)::int/gi;
for (const arquivo of arquivos) {
  const texto = ler(arquivo);
  if (padraoMonetario.test(texto)) falhas.push(`P2: agregado monetário rebaixado para int4 em ${arquivo}`);
  padraoMonetario.lastIndex = 0;
}

// Agregado monetário em bigint também não pode ser convertido com Number(...) cru.
// A função central verifica Number.MAX_SAFE_INTEGER e falha em vez de arredondar centavos.
const conversaoMonetariaCrua = /Number\([^\n)]*(?:faturamento_cents|gorjeta_cents|meta_cents|anterior_cents)[^\n)]*\)/g;
for (const arquivo of arquivos) {
  const texto = ler(arquivo);
  if (conversaoMonetariaCrua.test(texto)) falhas.push(`P2: Number(...) direto em agregado monetário em ${arquivo}`);
  conversaoMonetariaCrua.lastIndex = 0;
}

if (falhas.length) {
  console.error(`Auditoria profunda reprovou (${falhas.length})`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}
console.log('auditoria profunda: invariantes financeiras, timezone, timeout e OTP preservadas');
