import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULOS } from './secoes.js';

/**
 * O menu chama a tela pelo nome que a tela usa.
 *
 * ## O defeito
 *
 * O menu dizia **"Pendências"** e a tela dizia **"Fiado"** — `<h1>Fiado</h1>`,
 * `metadata.title: 'Fiado'`, a rota `/admin/fiado`, a função `quemEstaDevendo`,
 * "Pagamento de fiado" no extrato do caixa e "o padrão é **não fiar**" no
 * estado vazio. Só o item do menu divergia.
 *
 * Quando o dono fala *"abre o Fiado"*, a recepção procura "Fiado" no menu e não
 * acha. É o defeito "Iniciar / Começar / Sentou" da §6 pergunta 2, com um nome
 * só divergindo — e ele reapareceu em "Comandas" contra `<h1>Cobrar</h1>`.
 *
 * ## Por que uma guarda, e não só o conserto
 *
 * `vocabulario.test.ts` guarda os mapas de estado do atendimento e não olha
 * para cá: nada comparava `MODULOS[].nome` com o título da tela de destino. Sem
 * guarda, o próximo item de menu nasce livre para divergir.
 *
 * ## O que ela **não** vê
 *
 * Ela lê o fonte, e casa o `<h1>` literal. Um título montado por variável
 * aparece como não encontrado, e por isso a ausência de `<h1>` é ignorada em
 * vez de reprovada — o que se prova aqui é a **divergência**, nunca a presença.
 * Guarda em que se confia mais do que ela alcança é pior que guarda nenhuma.
 */

const RAIZ = join(process.cwd(), 'src/app');

/**
 * Sinônimos aceitos, com o motivo escrito ao lado de cada um.
 *
 * Nasce **vazia**, e isso é a decisão: quando a guarda entrou, as sete
 * divergências que ela achou eram todas defeito, nenhuma sinônimo legítimo. A
 * lista existe porque um dia haverá um par em que forçar a igualdade produziria
 * um nome pior dos dois lados — e aí a exceção entra aqui com o motivo escrito,
 * que é o único jeito de ela não virar a lista que ninguém revisa.
 *
 * A direção do conserto foi sempre a mesma: o título da tela passou a ser o
 * nome do menu. O menu é o índice do produto, e é por ele que quem opera
 * procura — alinhar ao contrário faria a busca falhar do mesmo jeito.
 */
const SINONIMOS: Readonly<Record<string, string>> = {};

function tituloDaTela(href: string): string | null {
  const rota = href.replace(/^\/admin\/?/, '');
  const caminho = join(RAIZ, 'admin', rota, 'page.tsx');
  let fonte: string;
  try {
    fonte = readFileSync(caminho, 'utf8');
  } catch {
    return null;
  }
  const achado = /<h1[^>]*>([^<{]+)<\/h1>/.exec(fonte);
  return achado?.[1]?.trim() ?? null;
}


/**
 * Contém, e não igual: "Fiado" no menu e "Fiado do mês" na tela é a mesma coisa
 * dita com mais contexto, e não é o defeito. Os dois testes deste arquivo usam
 * esta regra — duas noções de "casa" no mesmo arquivo divergiriam no primeiro
 * ajuste, que é o defeito que este arquivo inteiro existe para vigiar.
 */
function casa(a: string, b: string): boolean {
  return a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());
}

/** `undefined` = não há `page.tsx`; `null` = há, e ele não declara `title`. */
function tituloDoNavegador(href: string): string | null | undefined {
  const rota = href.replace(/^\/admin\/?/, '');
  let fonte: string;
  try {
    fonte = readFileSync(join(RAIZ, 'admin', rota, 'page.tsx'), 'utf8');
  } catch {
    return undefined;
  }
  return /title:\s*'([^']+)'/.exec(fonte)?.[1]?.trim() ?? null;
}

describe('o nome do menu e o título da tela', () => {
  it('a varredura encontra os títulos que deveria vigiar', () => {
    /**
     * Sem esta guarda, um `page.tsx` que mudasse de lugar faria o teste abaixo
     * passar sobre zero telas — verde por não ter olhado.
     */
    let achados = 0;
    for (const modulo of MODULOS) {
      for (const item of modulo.telas) {
        if (tituloDaTela(item.href) !== null) achados += 1;
      }
    }
    expect(achados).toBeGreaterThan(15);
  });

  it('nenhum item do menu manda para uma tela com outro nome', () => {
    const divergentes: string[] = [];

    for (const modulo of MODULOS) {
      for (const item of modulo.telas) {
        const titulo = tituloDaTela(item.href);
        if (titulo === null) continue;

        const esperado = SINONIMOS[item.nome] ?? item.nome;
        if (!casa(titulo, esperado)) {
          divergentes.push(`${item.href}: menu "${item.nome}" × tela "${titulo}"`);
        }
      }
    }

    expect(
      divergentes,
      'o menu manda para um nome e a tela se apresenta com outro — quem opera procura e não acha',
    ).toEqual([]);
  });

  it('a aba do navegador também chama a tela pelo nome do menu', () => {
    /**
     * O irmão acima lê o `<h1>`, que é o nome **dentro** da tela. Este lê o
     * `metadata.title`, que é o nome que sai **para fora** dela: a aba do
     * navegador, o favorito que alguém salva, o título que aparece quando a
     * recepção tem seis abas abertas e procura a certa.
     *
     * Corte medido antes de a guarda existir: **7 das 41 telas do menu** — seis
     * divergiam ("Auditoria" abrindo a aba "Trilha", "Importar dados" abrindo
     * "Trazer minha base") e uma não declarava `title` nenhum.
     *
     * A ausência é reprovada aqui, ao contrário do `<h1>`, e o motivo é que ela
     * não produz ausência: o Next cai no `title` do layout, então a aba de
     * `Preferências` dizia **"Painel"**. Não é uma tela sem nome, é uma tela com
     * o nome errado — que é exatamente o que este arquivo vigia.
     */
    const problemas: string[] = [];

    for (const modulo of MODULOS) {
      for (const item of modulo.telas) {
        const titulo = tituloDoNavegador(item.href);
        if (titulo === undefined) continue;
        if (titulo === null) {
          problemas.push(`${item.href}: sem \`title\`, então a aba herda o nome do layout`);
          continue;
        }
        const esperado = SINONIMOS[item.nome] ?? item.nome;
        if (!casa(titulo, esperado)) {
          problemas.push(`${item.href}: menu "${item.nome}" × aba "${titulo}"`);
        }
      }
    }

    expect(problemas, 'a aba do navegador chama a tela por outro nome').toEqual([]);
  });
});
