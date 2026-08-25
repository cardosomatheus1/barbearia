#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const ler = (p) => readFileSync(p, 'utf8');
const falhas = [];
const exige = (c, m) => { if (!c) falhas.push(m); };

const clientesApi = ler('apps/api/src/admin/clientes.controller.ts');
const clientesDom = ler('packages/crm/src/clientes.ts');
const ficha = ler('apps/web/src/app/admin/cliente/[id]/page.tsx');
const fichaApi = ler('apps/web/src/lib/admin-api/financeiro.ts');
const crmFicha = ler('packages/crm/src/ficha.ts');
const financeiro = ler('packages/finance/src/financeiro.ts');
const financeiroController = ler('apps/api/src/admin/financeiro.controller.ts');
const mediaController = ler('apps/api/src/admin/admin.controller.ts');
const mediaStorage = ler('apps/api/src/media/storage.ts');
const conflito = ler('packages/crm/src/resolucao-de-conflito.ts');
const onboarding = ler('packages/onboarding/src/onboarding.ts');
const painel = ler('apps/web/src/app/admin/painel/page.tsx');
const clientesPagina = ler('apps/web/src/app/admin/clientes/page.tsx');
const componentes = ler('apps/web/src/app/admin/cliente/[id]/componentes.tsx');
const crescimento = ler('apps/web/src/app/admin/acoes/crescimento-plataforma.ts');
const operacao = ler('apps/web/src/app/admin/acoes/operacao.ts');
const middleware = ler('apps/web/src/middleware.ts');
const shell = ler('apps/web/src/app/styles/60-admin-shell.css');
const primitives = ler('apps/web/src/app/styles/70-admin-primitives.css');
const platform = ler('apps/web/src/app/styles/80-platform-admin.css');
const dashboard = ler('apps/web/src/app/styles/90-business-dashboard.css');
const booking = ler('apps/web/src/app/styles/00-public-booking.css');

// Autorização: segmento é relacionamento, não identidade básica.
exige(clientesApi.includes("customers.view_notes") && clientesApi.includes('podeVerSegmento'), 'P1: segmento voltou a pegar carona em customers.view');
exige(clientesDom.includes('podeVerSegmento') && clientesDom.includes('segmento: params.podeVerSegmento'), 'P1: domínio de Clientes voltou a calcular/devolver segmento sem permissão');

// Ficha: total real e visita concluída, nunca timeline visual limitada.
exige(ficha.includes('resumoFinanceiroDoClienteNaApi(token, id)'), 'P1: ficha perdeu o acumulado financeiro real');
exige(!ficha.includes("linhaDoTempo.filter((visita) => visita.status === 'completed').reduce"), 'P1: ficha voltou a somar apenas a timeline como total');
exige(ficha.includes('ficha.dados.ultimaVisita'), 'P1: última visita voltou a usar a primeira ocorrência da timeline');
exige(crmFicha.includes('readonly ultimaVisita: string | null') && crmFicha.includes('ultimaVisita: naBase?.ultimaVisita?.toISOString() ?? null'), 'P1: CRM perdeu a última visita concluída explícita');
exige(fichaApi.includes('/v1/admin/financeiro/clientes/${customerId}/resumo'), 'P1: frontend perdeu a rota de acumulado financeiro');
exige(financeiro.includes('export async function resumoFinanceiroDoCliente') && financeiro.includes("o.status = 'paid'"), 'P1: domínio financeiro perdeu o total de todos os pedidos pagos');
exige(financeiroController.includes("@Exige('customers.view', 'finance.view')") && financeiroController.includes("@Get('clientes/:id/resumo')"), 'P1: rota de LTV perdeu a dupla de permissões');

// Mídia: pós-commit é limpeza best effort.
exige(mediaStorage.includes('export async function tentarApagarImagemPublica'), 'P1: limpeza best-effort de mídia sumiu');
exige((mediaController.match(/tentarApagarImagemPublica\(anterior, staff\.tenantId\)/g) ?? []).length >= 2, 'P1: troca/remoção de mídia voltou a propagar unlink após commit');

// Importação: terceiro conflito aponta para o canônico atual.
exige(conflito.includes('conflitaCom: conflito.nome'), 'P2: conflito repetido mantém nome canônico obsoleto');

// Origem da ficha deve sobreviver a navegação e POST.
exige(clientesPagina.includes('?de=clientes'), 'P2: Clientes não declara origem ao abrir ficha');
exige(ficha.includes("'clientes'" ) && ficha.includes('de={voltar}'), 'P2: ficha perdeu a origem Clientes/Meu Dia');
exige(componentes.includes('name="de"') && componentes.includes('value={de}'), 'P2: WhatsApp não envia origem no POST');
exige(crescimento.includes("brutoDe === '/admin/meu-dia'") && crescimento.includes('de=${de}'), 'P2: WhatsApp não normaliza/preserva origem');
exige(operacao.includes("brutoDe === '/admin/clientes'"), 'P2: ajuste financeiro não entende origem Clientes');

// Multiunidade: locationId é obrigatório e usado em leitura + escrita de profissional.
exige(onboarding.includes('getPhotoTargets(tenantId: string, locationId: string)'), 'P2: getPhotoTargets voltou a aceitar unidade ausente');
exige(onboarding.includes("kind = 'professional' AND location_id = ${locationId}::uuid"), 'P2: equipe de fotos atravessa unidades');
exige(onboarding.includes('WHERE id = ${pessoa.id}::uuid AND location_id = ${locationId}::uuid'), 'P2: escrita de foto de profissional atravessa unidades');

// Painel: {dias:1} é uma janela de dia-calendário, não 24h rolantes.
exige(!painel.includes('Últimas 24 horas') && !painel.includes('nas últimas 24 horas'), 'P3: painel chama um dia-calendário de 24h rolantes');

// V9: danger não vira decoração/navegação.
exige(!shell.includes('var(--color-danger)'), 'P2: shell usa danger como navegação/decoração');
const numero = primitives.match(/\.numero::after\s*\{[\s\S]*?\}/)?.[0] ?? '';
exige(!numero.includes('var(--color-danger)'), 'P2: número usa danger decorativamente');
const filtro = dashboard.match(/\.painel-periodos \.filtro--ativo\s*\{[\s\S]*?\}/)?.[0] ?? '';
exige(!filtro.includes('var(--color-danger)'), 'P2: filtro ativo mistura danger');
const open = platform.match(/\.plano-fatura__estado--open\s*\{[^}]+\}/)?.[0] ?? '';
const paid = platform.match(/\.plano-fatura__estado--paid\s*\{[^}]+\}/)?.[0] ?? '';
exige(open.includes('var(--color-warning)'), 'P2: fatura aberta não usa warning');
exige(paid.includes('var(--color-success)'), 'P2: fatura paga não usa success');
const acima = booking.match(/\.hora__preco--acima\s*\{[^}]+\}/)?.[0] ?? '';
exige(acima.includes('var(--color-warning)'), 'P2: preço acima da base não usa warning');

// Segurança/documentação: não voltar a afirmar zero JS de cliente.
exige(!middleware.includes('regra de zero componente de cliente continua valendo'), 'P3: middleware documenta falsamente zero Client Components');

if (falhas.length) {
  console.error(`Invariantes da auditoria reprovaram (${falhas.length})`);
  for (const f of falhas) console.error(`- ${f}`);
  process.exit(1);
}
console.log('invariantes da auditoria: correções críticas preservadas');
