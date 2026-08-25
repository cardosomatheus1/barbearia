import { readFileSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';

const pagina = readFileSync('apps/web/src/app/admin/dia/page.tsx', 'utf8');
const resumo = readFileSync('apps/web/src/app/admin/dia/hoje.ts', 'utf8');
const css = lerCssDoApp();

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

// A primeira dobra é operação, não um dashboard.
exigir(pagina.includes('Hoje você tem {resumo.marcados} atendimentos'), 'a abertura de Hoje não diz quantos atendimentos existem');
exigir(pagina.includes('className="hoje-proximo"'), 'o próximo cliente não tem destaque próprio');
exigir(pagina.includes('<ProximoCliente resumo={resumo} />'), 'o próximo cliente não aparece antes da linha do tempo');
exigir(pagina.includes('aria-label="Leituras rápidas de hoje"'), 'faltam as leituras rápidas da operação');
for (const titulo of ['Agora', 'Hoje', 'Caixa', 'Atenção']) {
  exigir(pagina.includes(`>${titulo}</h2>`), `leitura rápida desapareceu: ${titulo}`);
}
exigir(pagina.includes('Linha do tempo'), 'a sequência de atendimentos deixou de ser identificada como linha do tempo');

// V5 não pode puxar o papel do painel do dono de volta para o balcão.
exigir(!pagina.includes('<svg'), 'Hoje ganhou SVG/gráfico; gráfico pertence ao painel do dono');
exigir(!/Grafico|gr[aá]fico/i.test(pagina), 'Hoje voltou a falar em gráfico');

// Dinheiro continua sob a permissão que já existia. Operar caixa não é ver faturamento.
exigir(pagina.includes("const podeVerDinheiro = podeNaTela(estado, 'finance.view')"), 'faturamento não está condicionado a finance.view');
exigir(pagina.includes('éHoje && podeVerDinheiro ? faturamentoDeHoje(token, dia.date) : Promise.resolve(null)'), 'Hoje consulta faturamento mesmo sem finance.view');
exigir(pagina.includes("const podeOperarCaixa = podeCobrar"), 'estado do caixa não reutiliza a permissão operacional existente');
exigir(pagina.includes('éHoje && podeOperarCaixa ? caixaDaUnidade(token) : Promise.resolve(null)'), 'Hoje consulta caixa para perfil sem cashier.open');

// O próximo é derivado do payload do dayboard; nenhuma segunda consulta/ordenação.
exigir(resumo.includes('export function proximoDoBalcao'), 'regra do próximo cliente não está isolada/testável');
exigir(resumo.includes("const chegou = linhas.find((linha) => ESPERANDO.has(linha.status))"), 'quem já chegou não tem prioridade como próximo do balcão');
exigir(!resumo.includes('.sort('), 'resumo reordena a agenda e cria segunda fonte de ordenação');

// O desenho precisa manter o próximo primeiro no celular e leituras ao lado no notebook.
exigir(css.includes('.hoje-resumo'), 'layout operacional V5 não existe no CSS');
exigir(css.includes('.hoje-proximo'), 'destaque visual do próximo não existe');
exigir(css.includes('.hoje-leituras'), 'grade de leituras rápidas não existe');
exigir(/@media \(min-width: 960px\)[\s\S]*?\.hoje-resumo[\s\S]*?grid-template-columns/.test(css), 'notebook não põe próximo e leituras lado a lado');
exigir(/@media (?:\(min-width: 0px\) and )?\(max-width: 479px\)[\s\S]*?\.hoje-proximo/.test(css), 'não há tratamento da primeira dobra em celular');

if (falhas.length) {
  console.error(`V5: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log('V5: Hoje é centro operacional; próximo em destaque, quatro leituras e nenhum gráfico');
