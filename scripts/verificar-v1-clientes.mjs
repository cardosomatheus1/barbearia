import { readFileSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';
import { fonteAdminApi } from './fonte-admin.mjs';

const secoes = readFileSync('apps/web/src/app/admin/secoes.ts', 'utf8');
const casco = readFileSync('apps/web/src/app/admin/casco.tsx', 'utf8');
const pagina = readFileSync('apps/web/src/app/admin/clientes/page.tsx', 'utf8');
const api = readFileSync('apps/api/src/admin/clientes.controller.ts', 'utf8');
const crm = readFileSync('packages/crm/src/clientes.ts', 'utf8');
const clienteApi = fonteAdminApi();
const appModule = readFileSync('apps/api/src/app.module.ts', 'utf8');
const crmIndex = readFileSync('packages/crm/src/index.ts', 'utf8');
const css = lerCssDoApp();

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

// A porta existe e é uma área de primeira ordem. A ficha pertence a ela, não a Atendimento.
exigir(/id: 'clientes'[\s\S]{0,260}href: '\/admin\/clientes'/.test(secoes), 'Clientes não é área de primeira ordem');
exigir(/id: 'clientes'[\s\S]{0,520}dentro: \[\{ secao: 'cliente'/.test(secoes), 'ficha do cliente não pertence à área Clientes');
const atendimento = secoes.match(/id: 'atendimento'[\s\S]*?\n  \},\n  \{\n    id: 'financeiro'/)?.[0] ?? '';
exigir(!atendimento.includes("'cliente'"), 'ficha do cliente ainda está ancorada em Atendimento');
exigir(secoes.includes("permissao: ['customers.view']"), 'porta Clientes não declara customers.view no menu');
exigir(casco.includes("clientes: traco("), 'Clientes não tem identidade no trilho');
exigir((secoes.match(/href: '\/admin\/clientes'/g) ?? []).length === 1, 'porta Clientes duplicada ou ausente no registro');

// A API não transforma customers.view em atalho para agenda ou dinheiro.
exigir(/@Exige\('customers\.view'\)[\s\S]{0,80}@Get\('directory'\)/.test(api), 'directory não exige customers.view');
exigir(appModule.includes('ClientesController'), 'ClientesController existe mas não foi registrado no AppModule');
exigir(crmIndex.includes("export * from './clientes.js'"), 'domínio Clientes não foi exportado pelo pacote CRM');
exigir(api.includes("appointments.view_all_professionals"), 'agenda da equipe não tem permissão própria na porta');
exigir(api.includes("customers.view_notes") && api.includes('podeVerSegmento'), 'segmentação pegou carona em customers.view');
exigir(api.includes("cashier.open") && api.includes("finance.view"), 'fiado não tem permissão financeira própria');
exigir(api.includes("['em_risco', 'vip', 'assinantes'].includes(query.filtro)"), 'filtros de segmento não recusam acesso direto');
exigir(api.includes("query.filtro === 'hoje'") && api.includes("query.filtro === 'fiado'"), 'filtros sensíveis não recusam acesso direto');

// O dado que atravessa a API continua sendo o mínimo necessário.
exigir(crm.includes('telefoneMascarado'), 'lista não mascara o telefone');
exigir(!/telefoneCompleto|phoneE164:/.test(crm), 'lista criou campo de telefone completo');
exigir(crm.includes('tryNormalizePhone'), 'busca por telefone não usa a chave E.164 normalizada');
exigir(/c\.phone_e164\s*=\s*\$\{params\.buscaTelefone\}/.test(crm), 'busca por telefone não é exata no SQL');
exigir(crm.includes("c.anonymized_at IS NULL"), 'cadastro anonimizado voltou a ser listável');
exigir(crm.includes('segmentosDaBase'), 'segmento da lista não vem da fonte derivada existente');
exigir(/LIMIT \$\{params\.limite\} OFFSET \$\{params\.offset\}/.test(crm), 'porta voltou a paginar depois de carregar a base inteira');
exigir(crm.includes('count(*)::bigint AS total_count'), 'paginação SQL perdeu o total da base filtrada');
exigir(crm.includes('params.podeVerSegmento ?') && crm.includes('segmento: params.podeVerSegmento'), 'domínio calcula/devolve segmento mesmo sem permissão');

for (const filtro of ['todos', 'recentes', 'hoje', 'em_risco', 'vip', 'assinantes', 'fiado']) {
  exigir(crm.includes(`'${filtro}'`), `filtro ${filtro} não existe no domínio`);
  exigir(pagina.includes(`${filtro}:`) || pagina.includes(`'${filtro}'`), `filtro ${filtro} não chegou à tela`);
}
exigir(pagina.includes("item !== 'hoje' || podeVerAgenda"), 'tela oferece Hoje sem permissão de agenda da equipe');
exigir(pagina.includes("item !== 'fiado' || podeVerFiado"), 'tela oferece Fiado sem permissão financeira');
exigir(pagina.includes("customers.view_notes") && pagina.includes("['em_risco', 'vip', 'assinantes'].includes(item)"), 'tela oferece filtros de segmento sem permissão');
exigir(pagina.includes('Ordenados pela atividade mais recente'), 'estado Todos não explica a ordenação');
exigir(pagina.includes('Buscar por nome ou telefone completo'), 'busca não diz o contrato do telefone');
exigir(clienteApi.includes("'assinante' | null"), 'contrato web não admite segmento protegido/nulo');
exigir(clienteApi.includes('/v1/admin/customers/directory'), 'web não chama a porta nova da API');

// O casco precisa reconhecer a nova área em todas as larguras.
for (const forma of [
  ".trilho__botao[data-modulo='clientes']",
  ".contexto__bloco[data-modulo='clientes']",
]) {
  exigir(css.includes(forma), `CSS não reconhece Clientes: ${forma}`);
}
exigir(css.includes('.clientes__lista') && css.includes('.clientes__link'), 'tela Clientes não tem hierarquia visual própria');
exigir(css.includes('@media (min-width: 720px)'), 'lista não declara adaptação de largura');

if (falhas.length) {
  console.error(`V1: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log('V1: porta Clientes, permissões agregadas, busca, filtros e navegação coerentes');
