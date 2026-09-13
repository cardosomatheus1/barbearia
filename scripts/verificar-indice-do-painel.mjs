#!/usr/bin/env node
/**
 * O mapa do painel (`/admin/tudo`) é derivado ou não é mapa.
 *
 * Ele existe porque o trilho mostra sete ícones e a faixa mostra só as telas do
 * módulo atual: para responder *"onde fica X?"* sem saber o módulo, não havia
 * caminho senão clicar os sete. O mapa só resolve isso enquanto disser a
 * verdade — e há três maneiras de ele passar a mentir, todas silenciosas.
 *
 * Uma delas não precisa de guarda: "tela nova não aparece no mapa" é impossível
 * por construção, porque a lista sai de `orientacoesVisiveis`. Guarda para isso
 * seria guarda vazia. As três que **podem** acontecer:
 *
 *   A) alguém troca a derivação por uma lista escrita à mão — a sexta lista
 *      paralela deste código, e as cinco anteriores todas divergiram;
 *   B) `RITMO_DO_MOLDE` deixa de ser total e ganha `??`: o molde novo cai calado
 *      num balde que ninguém escolheu, em vez de o compilador cobrar a decisão;
 *   C) o mapa é montado **antes** do recorte de permissão, e passa a oferecer
 *      porta que recusa ao abrir. É o defeito que `modulosVisiveis` documenta
 *      com medição: o barbeiro via 39 destinos e 18 recusavam.
 *
 * (C) é o caro: um mapa que erra ensina a não confiar no mapa, e ele existe
 * exatamente para quem ainda não confia em nada.
 *
 * Corte medido antes de escrever: as três acusam 0 na árvore como está, e cada
 * quebra proposital acusa exatamente 1.
 */
import { readFileSync } from 'node:fs';

const ler = (arquivo) => readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');
const erros = [];
const exigir = (condicao, texto) => { if (!condicao) erros.push(texto); };

const pagina = ler('apps/web/src/app/admin/tudo/page.tsx');
const secoes = ler('apps/web/src/app/admin/secoes.ts');

// A) a lista sai do registro, e não de um literal na página.
exigir(pagina.includes('indicePorRitmo(modulos)'), 'A) o mapa precisa sair de indicePorRitmo(modulos), não de uma lista própria');
for (const achado of pagina.matchAll(/href: '(\/admin[^']*)'/g)) {
  erros.push(`A) ${achado[1]} foi escrito à mão na página; o mapa deriva do registro`);
}

// B) o mapa de ritmo é total sobre a união dos moldes.
exigir(/const RITMO_DO_MOLDE: Record<MoldeDePagina, RitmoDeUso>/.test(secoes),
  'B) RITMO_DO_MOLDE precisa ser Record total sobre MoldeDePagina — com chave larga, o molde novo cai calado');
const corpo = secoes.slice(secoes.indexOf('const RITMO_DO_MOLDE'), secoes.indexOf('export interface RitmoDoPainel'));
exigir(!corpo.includes('??'), 'B) padrão por omissão em RITMO_DO_MOLDE: o molde novo precisa de decisão escrita, não de balde');

// C) o recorte de permissão acontece antes de o mapa ser montado.
/*
  Ancorado na **chamada**, não na grafia dos argumentos: a primeira versão
  exigia `modulosVisiveis(estado.recursos, estado.permissoes)` e reprovou na
  mesma hora, porque a permissão mora em `estado.staff.permissions`. Guarda
  pinada em literal incidental reprova a correção junto com o defeito — é o que
  aconteceu no bloco 141, e o comentário do V11 já conta essa história.
*/
const ordemCerta = pagina.search(/modulosVisiveis\(\s*estado\./);
exigir(ordemCerta !== -1, 'C) o mapa precisa partir de modulosVisiveis(...) sobre o estado da sessão');
exigir(ordemCerta !== -1 && ordemCerta < pagina.indexOf('indicePorRitmo('),
  'C) o mapa é montado antes do recorte de permissão e ofereceria porta que recusa ao abrir');
exigir(!/indicePorRitmo\(\s*MODULOS\s*\)/.test(pagina), 'C) o mapa recebeu o registro bruto: MODULOS ignora recurso e permissão');

if (erros.length) {
  console.error(`Índice do painel reprovado (${erros.length}):`);
  for (const erro of erros) console.error(`- ${erro}`);
  process.exit(1);
}

const portas = [...secoes.matchAll(/href: '\/admin[^']*'/g)].length;
console.log(`Índice do painel ok: ${portas} portas derivadas do registro, ritmo total sobre os moldes, recorte de permissão antes da montagem.`);
