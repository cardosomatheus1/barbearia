#!/usr/bin/env node
/**
 * Nenhuma consulta escreve a lista de estados de agendamento à mão.
 *
 * `appointment_status` tem dez valores e o produto pergunta três coisas sobre
 * eles: quem **libera a cadeira** (a constraint de exclusão), quem tem
 * **horário marcado e ainda não sentou**, e quem tem **algo em curso**. As três
 * moram em `packages/core/src/attendance.ts`, e as duas últimas são derivadas
 * da primeira — estado novo entra ou sai das três pela mesma linha.
 *
 * Estavam escritas à mão em vinte lugares. O caso mais caro era o motor de
 * disponibilidade: `repository.ts` tinha cópia privada dos quatro terminais, e o
 * comentário do `core` conta que esse defeito **já aconteceu** — três consultas
 * de `ocupacao.ts` escreviam a lista e as três esqueceram `waiting`. O conserto
 * chegou em `ocupacao.ts` e não ali. Divergir naquele arquivo esconde horário
 * livre da página pública (capacidade descartada em silêncio) ou oferece o que a
 * constraint recusa na gravação — "horário indisponível" com o cliente na linha.
 *
 * O corte é a **igualdade com um dos três conjuntos**, e não "enumerou três ou
 * mais estados". A primeira versão usava a contagem e acusava quatro consultas
 * legítimas: `desempenho.ts` exclui três dos quatro terminais de propósito
 * (`no_show` conta como visita que houve), `oferta.ts` monta o histórico de
 * confiabilidade, `metricas.ts` e `ficha.ts` respondem cada uma outra pergunta.
 * Conjunto próprio é decisão de domínio; guarda que o acusa é guarda que alguém
 * desliga — e aí ela para de pegar o caso que importa.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const RAIZ = join(import.meta.dirname, '..');

/** Onde o vocabulário mora — é o único lugar que pode enumerar. */
const DONO = join('packages', 'core', 'src', 'attendance.ts');

/** Os três conjuntos que `core` nomeia — e só eles. */
const CONJUNTOS = {
  ESTADOS_QUE_LIBERAM_A_AGENDA:
    ['cancelled_customer', 'cancelled_business', 'no_show', 'rescheduled'],
  ESTADOS_QUE_OCUPAM_A_AGENDA:
    ['pending', 'confirmed', 'checked_in', 'waiting', 'in_progress', 'completed'],
  ESTADOS_ANTES_DO_ATENDIMENTO: ['pending', 'confirmed', 'checked_in', 'waiting'],
  ESTADOS_EM_CURSO: ['pending', 'confirmed', 'checked_in', 'waiting', 'in_progress'],
};

function fontes(pasta, achados = []) {
  for (const nome of readdirSync(pasta)) {
    if (nome === 'node_modules' || nome === 'dist') continue;
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) fontes(caminho, achados);
    else if (/\.tsx?$/.test(nome) && !nome.includes('.test.')) achados.push(caminho);
  }
  return achados;
}

export function falhasDoEstadoDeAgendamento(raiz = RAIZ) {
  const f = [];
  for (const caminho of [...fontes(join(raiz, 'packages')), ...fontes(join(raiz, 'apps'))]) {
    const curto = relative(raiz, caminho);
    if (curto === DONO) continue;
    // Comentário sai antes de casar: os arquivos consertados **citam** a lista
    // para explicar por que não a escrevem.
    //
    // O bloco vira o **mesmo número de linhas em branco**, e não some: apagá-lo
    // encurta o arquivo e desloca a contagem, e a guarda passa a apontar para
    // uma linha inocente dezenas de posições abaixo. Guarda que aponta errado é
    // pior que guarda nenhuma — quem abre não vê nada e para de confiar nela.
    const fonte = readFileSync(caminho, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (bloco) => '\n'.repeat((bloco.match(/\n/g) ?? []).length))
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // A cláusula pode quebrar em linhas; junta as três seguintes antes de casar.
    const linhas = fonte.split('\n');
    linhas.forEach((_, i) => {
      const trecho = linhas.slice(i, i + 3).join(' ');
      const citados = new Set(
        [...trecho.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
      );
      for (const [nome, conjunto] of Object.entries(CONJUNTOS)) {
        if (conjunto.length !== citados.size) continue;
        if (conjunto.every((e) => citados.has(e))) {
          f.push(`${curto}:${i + 1} escreve ${nome} à mão — importe de @barbearia/core`);
        }
      }
    });
  }
  return f;
}

const direto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direto) {
  const f = falhasDoEstadoDeAgendamento();
  if (f.length) { console.error(f.map((x) => `FAIL: ${x}`).join('\n')); process.exitCode = 1; }
  else console.log('estado de agendamento: nenhuma lista escrita à mão');
}
