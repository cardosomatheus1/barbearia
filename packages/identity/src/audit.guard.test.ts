import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A trilha registra **que** mudou, nunca o valor — e a guarda é derivada.
 *
 * ## O defeito que ela existe para pegar
 *
 * `customers.reliability_override_reason` é apagado por `anonimizar_cliente`, e
 * a migração diz por quê com todas as letras: os exemplos do próprio
 * repositório são *"faltou por internação"* e *"sumiu com a chave da
 * barbearia"* — dado de saúde e imputação de crime.
 *
 * O mesmo texto era copiado para `audit_log` no `after`. E `audit_log` é o pior
 * destino possível para dado pessoal: append-only por `REVOKE`, fora do alcance
 * de `anonimizar_cliente`, e **de propósito** fora da exportação do titular. A
 * pessoa exercia o direito à exclusão, o cadastro virava `cliente_anonimizado`,
 * e a narrativa ficava — com o id dela, a hora e o nome de quem escreveu,
 * legível por qualquer papel com `settings.manage`, para sempre.
 *
 * ## Por que varredura, e não uma linha na revisão
 *
 * Porque a próxima ação que auditar um motivo escrito nasce com o mesmo
 * defeito, e ninguém vai lembrar. A varredura lê o **código** e reprova a chave
 * suspeita dentro de `before`/`after` — o mesmo desenho das outras guardas
 * derivadas deste repositório, e pela mesma razão: lista escrita ao lado é a
 * que ninguém atualiza.
 *
 * ## O que ela permite, e por quê
 *
 * `caracteres`/`caracteresDoMotivo` passam: o tamanho não identifica ninguém e
 * responde a única pergunta que a trilha precisa responder — *"escreveram
 * mesmo alguma coisa?"*. Um motivo de **lista fechada** também passa, e é a
 * diferença que o bloco 80 desenhou na contestação: `spam` não nomeia ninguém.
 */

const RAIZ = join(import.meta.dirname, '..', '..');

/** Pacotes que gravam trilha. `apps/` chama o domínio; não escreve `audit()`. */
const PACOTES = ['crm', 'finance', 'identity', 'catalog', 'platform', 'scheduling'];

/**
 * Chaves que carregam texto que uma pessoa digitou.
 *
 * `motivo` e `nota` são as duas formas do produto para "escreva por quê", e são
 * obrigatórias em toda operação irreversível — que é justamente onde alguém
 * descreve o cliente.
 */
const TEXTO_LIVRE = ['motivo', 'nota', 'texto', 'observacao', 'comentario', 'reason'];

/**
 * O recorte: a trilha **de uma pessoa**.
 *
 * A primeira versão desta guarda reprovava texto livre em qualquer trilha, e
 * acusou sete lugares — o motivo da sangria, a descrição da conta a pagar, o
 * porquê do estorno. Nenhum deles fala de um cliente: falam de dinheiro, de
 * fornecedor, de produto. Reprovar o certo é o que faz alguém desligar a
 * guarda, e o alvo aqui não é "texto livre", é **texto sobre alguém que um dia
 * pode pedir para ser apagado**.
 *
 * O corte é a entidade auditada. `customers` é onde `anonimizar_cliente` age;
 * `data_requests` entra porque a recusa de um pedido do titular é escrita sobre
 * ele — e a tabela é excluída da exportação com motivo escrito, então o texto
 * ali seria invisível para quem ele descreve.
 */
const ENTIDADES_DE_PESSOA = ['customer', 'customers', 'data_requests'];

/**
 * As isenções, e cada uma com o motivo escrito.
 *
 * Não é "a lista das que dão trabalho": é a lista das que **não falam de uma
 * pessoa**, e a diferença é conferível linha a linha.
 */
const ISENTAS: Readonly<Record<string, string>> = {
  // O motivo da anonimização é sobre o **pedido** ("pedido do titular por
  // e-mail"), e a migração o escolhe de propósito: a trilha guarda o apelido e
  // o motivo, nunca o nome que saiu. Sem ele, a operação mais destrutiva do
  // produto ficaria sem porquê — e a linha já está anonimizada quando ela grava.
  'crm/src/anonimizacao.ts': 'motivo do pedido, nunca da pessoa — decisão da migração 0034',
};

function fontes(pacote: string): string[] {
  const dir = join(RAIZ, pacote, 'src');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => join(dir, f));
}

/**
 * Os objetos `before:` / `after:` das chamadas a `audit(` cuja entidade é uma
 * pessoa.
 *
 * O recorte é por bloco de chamada: `audit(` até o `});` que a fecha. Sem ele a
 * varredura não saberia de qual entidade é cada carga, e cairia no defeito que
 * ela existe para pegar — acusar o arquivo inteiro por uma linha.
 */
function cargasDeTrilhaDePessoa(codigo: string): string[] {
  const blocos: string[] = [];
  const abre = /\baudit\s*\(/g;
  let inicio: RegExpExecArray | null;
  while ((inicio = abre.exec(codigo)) !== null) {
    let profundidade = 1;
    let i = inicio.index + inicio[0].length;
    while (i < codigo.length && profundidade > 0) {
      if (codigo[i] === '(') profundidade += 1;
      else if (codigo[i] === ')') profundidade -= 1;
      i += 1;
    }
    const bloco = codigo.slice(inicio.index, i);
    if (ENTIDADES_DE_PESSOA.some((e) => new RegExp(`entity:\\s*'${e}'`).test(bloco))) {
      blocos.push(bloco);
    }
  }
  return blocos.flatMap(cargas);
}

/** Os objetos `before:` / `after:` de um trecho. */
function cargas(codigo: string): string[] {
  const cargas: string[] = [];
  const re = /\b(?:before|after):\s*\{/g;
  let casa: RegExpExecArray | null;
  while ((casa = re.exec(codigo)) !== null) {
    let profundidade = 1;
    let i = casa.index + casa[0].length;
    while (i < codigo.length && profundidade > 0) {
      if (codigo[i] === '{') profundidade += 1;
      else if (codigo[i] === '}') profundidade -= 1;
      i += 1;
    }
    cargas.push(codigo.slice(casa.index, i));
  }
  return cargas;
}

/**
 * `motivo: x` **e** `motivo` abreviado.
 *
 * A forma abreviada é exatamente como o defeito original estava escrito —
 * `after: { score: entrada.score, motivo }` —, e a primeira versão desta guarda
 * não a via. O autoteste abaixo é quem cobrou.
 */
function carregaTextoLivre(carga: string): string | null {
  for (const chave of TEXTO_LIVRE) {
    const declarada = new RegExp(`(?:^|[{,\\s])${chave}\\s*:`, 'i');
    const abreviada = new RegExp(`(?:^|[{,\\s])${chave}\\s*(?:,|\\})`, 'i');
    if (declarada.test(carga) || abreviada.test(carga)) return chave;
  }
  return null;
}

describe('a trilha não guarda o que a anonimização apaga', () => {
  it('nenhum before/after carrega texto que alguém digitou', () => {
    const achados: string[] = [];

    for (const pacote of PACOTES) {
      for (const arquivo of fontes(pacote)) {
        const relativo = `${pacote}/src/${arquivo.split('/').pop()}`;
        if (ISENTAS[relativo]) continue;

        const codigo = readFileSync(arquivo, 'utf8');
        if (!/\baudit\s*\(/.test(codigo)) continue;

        for (const carga of cargasDeTrilhaDePessoa(codigo)) {
          /**
           * `motivo` reprova; `caracteresDoMotivo` não.
           *
           * A âncora é o **começo** da chave — sem ela, `caracteresDoMotivo`
           * casaria com `motivo` e a guarda reprovaria justamente o conserto
           * que ela pede.
           */
          const chave = carregaTextoLivre(carga);
          if (chave) {
            achados.push(`${relativo} · ${chave} · ${carga.slice(0, 90).replace(/\s+/g, ' ')}`);
          }
        }
      }
    }

    expect(
      achados,
      'texto digitado dentro de before/after: audit_log é append-only, a anonimização não o alcança e a exportação do titular o deixa de fora',
    ).toEqual([]);
  });

  it('a guarda enxerga o defeito que a motivou', () => {
    /**
     * Guarda que não alcança o defeito que a motivou é pior que guarda nenhuma
     * — foi a lição da varredura de permissão do bloco 68. Esta prova o alcance
     * com o código exato que existia antes do conserto.
     */
    const antes = `await audit(tx, { entity: 'customer', after: { score: entrada.score, motivo } });`;
    const depois = `await audit(tx, { entity: 'customer', after: { score: s, caracteresDoMotivo: motivo.length } });`;
    // E a trilha que não é de pessoa passa: o motivo da sangria fala de
    // dinheiro, não de quem cortou o cabelo.
    const outraEntidade = `await audit(tx, { entity: 'cash_sessions', after: { reason: params.reason } });`;

    const reprova = (codigo: string) =>
      cargasDeTrilhaDePessoa(codigo).some((carga) => carregaTextoLivre(carga) !== null);

    expect(reprova(antes), 'a guarda não enxerga a forma abreviada').toBe(true);
    expect(reprova(depois)).toBe(false);
    expect(reprova(outraEntidade)).toBe(false);
  });
});
