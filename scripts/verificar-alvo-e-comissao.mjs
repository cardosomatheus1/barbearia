#!/usr/bin/env node
/**
 * Duas telas que a medição nunca vê no estado que importa.
 *
 * A medição entra como **dono**: ela fotografa a agenda com "A barbearia toda"
 * disponível e o formulário de comissão com o catálogo inteiro. O barbeiro — que
 * é quem os dois consertos deste bloco servem — não aparece em print nenhum, e
 * o estado dele não é alcançável por navegador sem uma segunda semeadura.
 *
 * É a regra do elemento que a medição não alcança: quem responde é guarda que
 * lê o fonte. Ela confere o que o código **diz**, nunca o que é desenhado — e o
 * limite vai escrito aqui, porque guarda em que se confia mais do que ela
 * alcança é pior que guarda nenhuma.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ =
  process.env['ALVO_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tira comentário antes de casar: guarda que reprova a frase que a explica é guarda que alguém apaga. */
const semComentario = (texto) =>
  texto
    .replace(/\/\*[\s\S]*?\*\//g, (bloco) => bloco.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_todo, antes) => antes);

export function falhasDoAlvoEComissao(raiz = RAIZ) {
  const ler = (p) => semComentario(readFileSync(join(raiz, p), 'utf8'));
  const problemas = [];
  const cobrar = (ok, msg) => {
    if (!ok) problemas.push(msg);
  };

  const agenda = ler('apps/web/src/app/admin/agenda/page.tsx');

  // 1. "A barbearia toda" é a única opção que a API sempre recusa para quem só
  //    enxerga a própria agenda. Solta, ela volta a ser o padrão dele.
  cobrar(
    /appointments\.view_all_professionals/.test(agenda),
    'a agenda não deriva mais quem pode fechar a casa toda de `appointments.view_all_professionals`',
  );
  cobrar(
    /podeFecharACasa\s*\?\s*<option value="">A barbearia toda<\/option>\s*:\s*null/.test(agenda),
    '"A barbearia toda" voltou a ser oferecida a quem não pode fechar a casa toda',
  );

  // 2. Um alvo só não é escolha: campo oculto e rótulo afirmativo, derivado do
  //    tamanho da lista — nunca de um nome de papel escrito ao lado.
  cobrar(
    /const umAlvoSo\s*=\s*!podeFecharACasa\s*&&\s*agenda\.professionals\.length === 1/.test(agenda),
    'o seletor de alvo único deixou de ser derivado do tamanho da lista',
  );
  // Ancorado em `value={alvoUnico}`: há outro `professionalId` oculto nesta
  // tela — o da confirmação de conflito, na linha 795 — e uma regex frouxa
  // casaria com ele. Foi o que aconteceu ao provar que a guarda fica vermelha:
  // a quebra trocou o primeiro dos dois e a guarda continuou verde, parecendo
  // que ela não prestava quando quem não prestou foi a quebra.
  cobrar(
    /umAlvoSo\s*\?[\s\S]{0,400}?<input name="professionalId" type="hidden" value=\{alvoUnico\}/.test(
      agenda,
    ),
    'o alvo único voltou a ser um seletor de uma opção em vez de campo oculto',
  );

  // 3. `commission_rules.category_id` existe desde o bloco 19 e o motor a
  //    resolve com peso 1. Sem porta na tela, é coluna que ninguém preenche.
  const regras = ler('apps/web/src/app/admin/comissao/regras/page.tsx');
  cobrar(
    /catalogo\.dados\.categories/.test(regras),
    'o formulário de comissão parou de ler as categorias do catálogo',
  );
  cobrar(
    /value={`cat:\$\{categoria\.id\}`}/.test(regras),
    'o formulário de comissão parou de oferecer regra por categoria',
  );
  cobrar(
    /value={`srv:\$\{servico\.id\}`}/.test(regras),
    'o formulário de comissão parou de oferecer regra por serviço',
  );

  // 4. Serviço e categoria juntos produzem regra que só casa quando o serviço
  //    está naquela categoria — na prática, regra que nunca dispara.
  const acao = ler('apps/web/src/app/admin/acoes/agenda-financeiro.ts');
  cobrar(
    /alvo\.startsWith\('srv:'\)/.test(acao) && /alvo\.startsWith\('cat:'\)/.test(acao),
    'a ação parou de separar serviço de categoria pelo prefixo',
  );
  cobrar(
    !/name="serviceId"/.test(regras) && !/name="categoryId"/.test(regras),
    'voltaram dois campos para a mesma pergunta: dá para marcar serviço e categoria juntos',
  );

  return problemas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problemas = falhasDoAlvoEComissao();
  if (problemas.length > 0) {
    console.error(`alvo do bloqueio e regra de comissão: ${problemas.length} problema(s)\n`);
    for (const p of problemas) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('alvo do bloqueio e regra de comissão: as duas telas dizem o que a API aceita');
}
