#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';
const pagina=readFileSync('apps/web/src/app/admin/cliente/[id]/page.tsx','utf8');
const componentes=readFileSync('apps/web/src/app/admin/cliente/[id]/componentes.tsx','utf8');
const clientesPagina=readFileSync('apps/web/src/app/admin/clientes/page.tsx','utf8');
const crescimento=readFileSync('apps/web/src/app/admin/acoes/crescimento-plataforma.ts','utf8');
const operacao=readFileSync('apps/web/src/app/admin/acoes/operacao.ts','utf8');
const conta=readFileSync('apps/web/src/app/admin/acoes/clientes-conta.ts','utf8');
const produto=readFileSync('apps/web/src/app/admin/acoes/produto.ts','utf8');
const crm=readFileSync('packages/crm/src/ficha.ts','utf8');
const financeiro=readFileSync('packages/finance/src/financeiro.ts','utf8');
const apiFinanceiro=readFileSync('apps/api/src/admin/financeiro.controller.ts','utf8');
const css=lerCssDoApp();
const falhas=[]; const exigir=(c,m)=>{if(!c)falhas.push(m)};
for (const aba of ['Visão geral','Histórico','Fidelidade','Financeiro']) exigir(pagina.includes(aba),`aba ausente: ${aba}`);
exigir(pagina.includes("type AbaDaFicha = 'visao' | 'historico' | 'fidelidade' | 'financeiro'"),'união de abas não está explícita');
exigir(pagina.includes('aria-label="Ações deste cliente"'),'ações contextuais sumiram');
exigir(pagina.includes('>Agendar</a>'),'Agendar não está no topo');
exigir(pagina.includes('>WhatsApp</a>'),'WhatsApp não está no topo');
exigir(pagina.includes('>Nova comanda</button>'),'Nova comanda não está no topo');
exigir(pagina.includes('name="customerId" type="hidden" value={ficha.dados.customerId}'),'Nova comanda não preserva o cliente');
exigir(pagina.includes("hidden={aba !== 'historico'}"),'Histórico não está recortado por aba');
exigir(pagina.includes("hidden={aba !== 'fidelidade'}"),'Fidelidade não está recortada por aba');
exigir(pagina.includes("hidden={aba !== 'financeiro'}"),'Financeiro não está recortado por aba');
exigir(pagina.includes('cliente-resumo'),'resumo de primeira leitura não existe');
exigir(pagina.includes('explicacaoDoSegmento'),'segmento não explica o porquê');
for (const flag of ['visaoAtiva','historicoAtivo','fidelidadeAtiva','financeiroAtivo']) exigir(pagina.includes(flag),`aba não recorta consultas: ${flag}`);
exigir(pagina.includes("const origem = first(query['de']) === 'meu-dia' ? 'meu-dia' : first(query['de']) === 'dia' ? 'dia' : 'clientes'"),'ficha não usa Clientes como origem padrão');
exigir(pagina.includes('`/admin/cliente/${encodeURIComponent(id)}?aba=${item.chave}&de=${origem}`'),'troca de aba perde a origem da ficha');
exigir(operacao.includes('?aba=fidelidade') && operacao.includes('?aba=financeiro'), 'ações de operação não preservam a aba da ficha');
exigir(conta.includes('?aba=fidelidade'), 'ações da conta não preservam a aba Fidelidade');
exigir(produto.includes('?aba=fidelidade') && produto.includes('?aba=financeiro'), 'ações de produto não preservam a aba correspondente');
exigir(css.includes('.cliente-abas__item--ativo'),'aba ativa não tem estado visual');
exigir(/@media (?:\(min-width: 0px\) and )?\(max-width: 640px\)/.test(css),'ficha não tem adaptação mobile');

// Regressão encontrada na auditoria independente: a timeline tem teto de dez
// ocorrências e inclui falta/cancelamento. Ela não pode alimentar nem LTV nem
// "última visita". Dinheiro vem da rota financeira protegida; visita vem só
// de `completed`.
exigir(pagina.includes('resumoFinanceiroDoClienteNaApi(token, id)'), 'V2: gasto total não vem da leitura financeira protegida');
exigir(!pagina.includes("linhaDoTempo.filter((visita) => visita.status === 'completed').reduce"), 'V2: gasto total voltou a somar a timeline limitada');
exigir(pagina.includes('ficha.dados.ultimaVisita'), 'V2: última visita voltou a depender da primeira ocorrência da timeline');
exigir(crm.includes('readonly ultimaVisita: string | null'), 'V2: CRM não expõe última visita concluída de forma explícita');
exigir(crm.includes('ultimaVisita: naBase?.ultimaVisita?.toISOString() ?? null'), 'V2: última visita não deriva dos atendimentos concluídos');
exigir(financeiro.includes('export async function resumoFinanceiroDoCliente'), 'V2: leitura financeira do acumulado não existe');
exigir(financeiro.includes("o.status = 'paid'"), 'V2: acumulado financeiro não está restrito a pedidos pagos');
exigir(apiFinanceiro.includes("@Exige('customers.view', 'finance.view')") && apiFinanceiro.includes("@Get('clientes/:id/resumo')"), 'V2: acumulado financeiro não está protegido por identidade + dinheiro');
exigir(pagina.includes('consentimentos?.ok'), 'V2: consentimentos voltaram a ser acessados sem guarda nula');
exigir(clientesPagina.includes('?de=clientes'), 'V2: Clientes -> ficha não declara a origem explicitamente');
exigir(pagina.includes('de={voltar}') && pagina.includes('<MandarMensagem'), 'V2: WhatsApp não recebe a origem da ficha');
exigir(componentes.includes('name="de"') && componentes.includes('value={de}'), 'V2: formulário do WhatsApp não envia a origem');
exigir(crescimento.includes("brutoDe === '/admin/meu-dia'") && crescimento.includes("brutoDe === '/admin/dia'") && crescimento.includes("de=${de}"), 'V2: envio de WhatsApp não preserva origem fechada');
exigir(operacao.includes("brutoDe === '/admin/meu-dia'") && operacao.includes("brutoDe === '/admin/clientes'"), 'V2: ação financeira não entende as origens reais enviadas pela ficha');
if(falhas.length){console.error(`V2 reprovado (${falhas.length})`);for(const f of falhas)console.error('- '+f);process.exit(1)}
console.log('V2 ok: ficha orientada por intenção, resumo e ações contextuais preservadas.');
