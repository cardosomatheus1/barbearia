import { celula, type Csv } from './csv.js';
import { tryNormalizePhone, type PhoneError } from './phone.js';

/**
 * O importador de base — SPEC §5.8.
 *
 * > "Barbearia estabelecida não começa do zero: ela tem base de clientes,
 * > histórico e agenda futura. **Sem importador, a venda morre na objeção 'vou
 * > perder meus clientes'.**"
 *
 * Tudo aqui é puro: recebe o arquivo já lido e a base que já existe, devolve o
 * veredito de cada linha. Quem grava é `packages/crm`. A separação é o que
 * permite a tela do preview mostrar exatamente o que a aplicação vai fazer —
 * porque é literalmente a mesma função, com o mesmo resultado.
 *
 * ## O telefone é a identidade
 *
 * A deduplicação é por E.164 normalizado, como a SPEC manda. `(71) 98888-7777`,
 * `71988887777` e `+55 71 98888-7777` são a mesma pessoa, e é assim que a base
 * do sistema antigo chega: três formatos na mesma coluna, porque foram digitados
 * por pessoas diferentes ao longo de seis anos.
 */

/** O que cada linha vira. A ordem importa: é a ordem de gravidade na tela. */
export type Veredito =
  /** Telefone que não existe. Não entra — sem telefone não há como avisar ninguém. */
  | 'telefone_invalido'
  /** Sem nome. Entra como "Cliente" seria mentira na agenda do barbeiro. */
  | 'sem_nome'
  /** Mesmo telefone que outra linha do arquivo, com nome diferente. Pede olho humano. */
  | 'conflito'
  /** Mesmo telefone que outra linha do arquivo, mesmo nome. Some, sem alarde. */
  | 'repetido_no_arquivo'
  /** Já existe na base com este telefone. Atualiza o que estiver vazio. */
  | 'ja_existe'
  /** Entra. */
  | 'novo';

export interface LinhaAnalisada {
  /** Número da linha no arquivo, contando o cabeçalho como 1. Para a tela citar. */
  readonly linha: number;
  readonly veredito: Veredito;
  readonly nome: string;
  /** E.164 quando válido; o que veio no arquivo quando não. */
  readonly telefone: string;
  readonly nascimento: string | null;
  readonly observacao: string | null;
  /** Só quando `telefone_invalido`: por quê. A tela mostra, a pessoa corrige. */
  readonly motivo?: PhoneError | undefined;
  /** Só quando `conflito`: o outro nome visto para o mesmo telefone. */
  readonly conflitaCom?: string | undefined;
}

export interface Analise {
  readonly linhas: readonly LinhaAnalisada[];
  readonly resumo: Readonly<Record<Veredito, number>>;
  /** Total de linhas de dado no arquivo. `resumo` soma exatamente isto. */
  readonly total: number;
}

export const VEREDITOS: readonly Veredito[] = [
  'telefone_invalido',
  'sem_nome',
  'conflito',
  'repetido_no_arquivo',
  'ja_existe',
  'novo',
];

// -- detecção de coluna -------------------------------------------------------

export type Campo = 'nome' | 'telefone' | 'nascimento' | 'observacao';

/**
 * Como cada sistema chama a mesma coluna.
 *
 * A lista sai de exportações reais das fontes que a SPEC §5.8 prioriza. É
 * comparada sem acento e sem caixa, então `Aniversário` e `aniversario` são o
 * mesmo alias — e não precisam dos dois aqui.
 *
 * Ordem importa dentro de cada campo: o primeiro alias que casar vence. Por isso
 * `celular` vem antes de `telefone` — numa base com as duas colunas, o celular é
 * o que recebe WhatsApp, e o fixo não serve para nada neste produto.
 */
const ALIASES: Readonly<Record<Campo, readonly string[]>> = {
  nome: ['nome', 'nome completo', 'cliente', 'nome do cliente', 'name', 'razao social'],
  telefone: [
    'celular',
    'whatsapp',
    'telefone celular',
    'fone celular',
    'telefone',
    'fone',
    'contato',
    'phone',
    'mobile',
  ],
  nascimento: [
    'nascimento',
    'data de nascimento',
    'data nascimento',
    'aniversario',
    'dt nascimento',
    'birthday',
    'birth date',
  ],
  observacao: ['observacao', 'observacoes', 'obs', 'anotacao', 'anotacoes', 'notas', 'notes'],
};

/**
 * Os cabeçalhos que o produto reconhece, para a tela mostrar (bloco 83).
 *
 * Derivado de `ALIASES`, nunca escrito ao lado: a tela dizia só "precisa ter
 * uma coluna de nome e uma de celular", e a pessoa ficava adivinhando se
 * `WhatsApp` ou `Nome do Cliente` serviam — quando os dois servem. Uma lista
 * escrita à mão na tela ficaria para trás no primeiro alias novo, que é o
 * defeito que este repositório já pagou cinco vezes.
 */
export const CABECALHOS_ACEITOS: Readonly<Record<Campo, readonly string[]>> = ALIASES;

/**
 * O cabeçalho do arquivo modelo, e ele **é** um cabeçalho aceito.
 *
 * O primeiro alias de cada campo: por construção, o modelo que a barbearia
 * baixa passa pela detecção. Um modelo escrito à mão poderia divergir do
 * parser, e aí o produto entregaria um arquivo que ele próprio recusa.
 */
export function cabecalhoDoModelo(): readonly string[] {
  return (Object.keys(ALIASES) as Campo[]).map((campo) => {
    const primeiro = ALIASES[campo][0];
    if (primeiro === undefined) throw new Error(`campo sem alias: ${campo}`);
    return primeiro;
  });
}

/**
 * O arquivo modelo inteiro, com duas linhas de exemplo.
 *
 * Conteúdo real e não `João da Silva / 11111111111`: telefone com máscara e
 * nome composto são o que revela se a importação entende o que a pessoa
 * realmente tem na planilha antiga.
 */
export function csvDoModelo(): string {
  const linhas = [
    cabecalhoDoModelo().join(','),
    'Carlos Souza,(71) 98888-7777,1990-03-14,Prefere máquina 2 dos lados',
    'Ana Paula Ribeiro,+55 71 97777-6666,,',
  ];
  return `${linhas.join('\n')}\n`;
}

/** Sem acento, sem caixa, sem pontuação — o cabeçalho real tem de tudo. */
export function normalizarCabecalho(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type Colunas = Readonly<Record<Campo, number | null>>;

/**
 * Qual coluna do arquivo é qual campo.
 *
 * Devolve `null` para o que não achou, e é de propósito que isso não seja erro:
 * só `nome` e `telefone` são obrigatórios, e quem decide é quem chama — a tela
 * precisa poder mostrar "não achei a coluna de telefone" junto com a lista de
 * cabeçalhos lidos, para a pessoa apontar a certa.
 */
export function detectarColunas(cabecalho: readonly string[]): Colunas {
  const normalizados = cabecalho.map(normalizarCabecalho);
  const usadas = new Set<number>();

  const achar = (campo: Campo): number | null => {
    for (const alias of ALIASES[campo]) {
      const indice = normalizados.indexOf(alias);
      if (indice >= 0 && !usadas.has(indice)) {
        usadas.add(indice);
        return indice;
      }
    }
    // Nada exato: aceita o cabeçalho que *contém* o alias, porque exportador
    // gosta de "Telefone (WhatsApp)" e "Nome do Cliente (obrigatório)".
    for (const alias of ALIASES[campo]) {
      const indice = normalizados.findIndex(
        (texto, i) => !usadas.has(i) && texto.includes(alias),
      );
      if (indice >= 0) {
        usadas.add(indice);
        return indice;
      }
    }
    return null;
  };

  // Ordem de resolução, não de importância. Quem resolve primeiro fica com a
  // coluna na passada do "contém", e é lá que mora o estrago: `Observação do
  // cliente` contém `cliente`, que é alias de nome. Com `nome` correndo antes,
  // a anotação do cliente viraria o nome dele em toda a base.
  //
  // O que protege `Nome da mãe` é outra coisa — a passada exata roda inteira
  // antes da do "contém", então `Nome` casa exato e a coluna da mãe nunca é
  // considerada.
  const nascimento = achar('nascimento');
  const observacao = achar('observacao');
  const telefone = achar('telefone');
  const nome = achar('nome');

  return { nome, telefone, nascimento, observacao };
}

// -- data ---------------------------------------------------------------------

/**
 * Data de nascimento em qualquer dos formatos que chegam.
 *
 * `dd/mm/aaaa` é o brasileiro, `aaaa-mm-dd` é o de quem exportou de um banco, e
 * `dd/mm/aa` existe em base antiga. Devolve `YYYY-MM-DD` ou `null`.
 *
 * **`mm/dd/aaaa` não é aceito, e é uma decisão.** Não existe como distinguir
 * `03/04/1990` de `04/03/1990` sem perguntar, e adivinhar erraria em silêncio
 * numa data que ninguém confere — o cliente só descobre quando recebe "feliz
 * aniversário" no mês errado. O arquivo em formato americano é recusado linha a
 * linha (dia > 12 vira data inválida) em vez de importado torto.
 */
export function lerNascimento(texto: string, anoLimite: number): string | null {
  const limpo = texto.trim();
  if (limpo === '') return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(limpo);
  if (iso) return montarData(Number(iso[1]), Number(iso[2]), Number(iso[3]), anoLimite);

  const br = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(limpo);
  if (!br) return null;

  const dia = Number(br[1]);
  const mes = Number(br[2]);
  let ano = Number(br[3]);

  if ((br[3] ?? '').length === 2) {
    // Dois dígitos: o pivô é o ano corrente. `05` é 2005 se já passou, senão
    // 1905 — e para nascimento de cliente de barbearia o passado é sempre a
    // leitura certa.
    const seculo = Math.floor(anoLimite / 100) * 100;
    ano = seculo + ano > anoLimite ? seculo - 100 + ano : seculo + ano;
  }

  return montarData(ano, mes, dia, anoLimite);
}

function montarData(ano: number, mes: number, dia: number, anoLimite: number): string | null {
  if (!Number.isInteger(ano) || !Number.isInteger(mes) || !Number.isInteger(dia)) return null;
  if (ano < 1900 || ano > anoLimite) return null;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;

  // O calendário decide, não a faixa: 31/02 tem dia e mês plausíveis e não
  // existe. Comparar com o que o Date devolve pega isso sem tabela de meses.
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) {
    return null;
  }

  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// -- análise ------------------------------------------------------------------

const TETO_OBSERVACAO = 500;

/**
 * O veredito de cada linha, na ordem do arquivo.
 *
 * `jaExistem` é o conjunto de telefones E.164 que a barbearia já tem. Vem de uma
 * consulta só — a alternativa, perguntar ao banco por linha, seria N+1 sobre um
 * arquivo de mil e duzentos clientes.
 *
 * `anoLimite` é o ano corrente da unidade. Entra por parâmetro porque relógio
 * não mora na lógica (CLAUDE.md §1): a suíte roda igual em qualquer fuso e em
 * qualquer dia.
 */
export function analisar(params: {
  readonly csv: Csv;
  readonly colunas: Colunas;
  readonly jaExistem: ReadonlySet<string>;
  readonly anoLimite: number;
}): Analise {
  const linhas: LinhaAnalisada[] = [];
  /** Telefone já visto no próprio arquivo -> nome com que foi visto. */
  const vistos = new Map<string, string>();

  params.csv.linhas.forEach((bruta, indice) => {
    const numero = indice + 2; // +1 pelo cabeçalho, +1 porque humano conta de 1.
    const nome = celula(bruta, params.colunas.nome);
    const telefoneBruto = celula(bruta, params.colunas.telefone);
    const nascimento = lerNascimento(celula(bruta, params.colunas.nascimento), params.anoLimite);
    const observacaoBruta = celula(bruta, params.colunas.observacao);
    const observacao = observacaoBruta === '' ? null : observacaoBruta.slice(0, TETO_OBSERVACAO);

    const telefone = tryNormalizePhone(telefoneBruto);

    if (!telefone.ok) {
      linhas.push({
        linha: numero,
        veredito: 'telefone_invalido',
        nome,
        telefone: telefoneBruto,
        nascimento,
        observacao,
        motivo: telefone.code,
      });
      return;
    }

    if (nome === '') {
      linhas.push({
        linha: numero,
        veredito: 'sem_nome',
        nome,
        telefone: telefone.phone,
        nascimento,
        observacao,
      });
      return;
    }

    const anterior = vistos.get(telefone.phone);
    if (anterior !== undefined) {
      // Mesma pessoa duas vezes com o mesmo nome é ruído do exportador. Com nome
      // diferente é decisão de gente: pode ser marido e mulher no mesmo celular,
      // e escolher sozinho apagaria um dos dois.
      const mesmoNome = normalizarCabecalho(anterior) === normalizarCabecalho(nome);
      linhas.push({
        linha: numero,
        veredito: mesmoNome ? 'repetido_no_arquivo' : 'conflito',
        nome,
        telefone: telefone.phone,
        nascimento,
        observacao,
        ...(mesmoNome ? {} : { conflitaCom: anterior }),
      });
      return;
    }

    vistos.set(telefone.phone, nome);

    linhas.push({
      linha: numero,
      veredito: params.jaExistem.has(telefone.phone) ? 'ja_existe' : 'novo',
      nome,
      telefone: telefone.phone,
      nascimento,
      observacao,
    });
  });

  const resumo = Object.fromEntries(VEREDITOS.map((v) => [v, 0])) as Record<Veredito, number>;
  for (const linha of linhas) resumo[linha.veredito] += 1;

  return { linhas, resumo, total: linhas.length };
}

/** As que a aplicação de fato grava. O resto fica no relatório. */
export function aplicaveis(analise: Analise): readonly LinhaAnalisada[] {
  return analise.linhas.filter(
    (linha) => linha.veredito === 'novo' || linha.veredito === 'ja_existe',
  );
}

/**
 * A frase do preview, que a SPEC §5.8 pede quase literalmente:
 * "1.240 clientes, 38 duplicados, 12 telefones inválidos".
 */
export function fraseDoPreview(analise: Analise): string {
  const partes = [
    `${analise.resumo.novo} ${analise.resumo.novo === 1 ? 'cliente novo' : 'clientes novos'}`,
  ];

  if (analise.resumo.ja_existe > 0) {
    partes.push(`${analise.resumo.ja_existe} já na base`);
  }

  const duplicados = analise.resumo.repetido_no_arquivo + analise.resumo.conflito;
  if (duplicados > 0) {
    partes.push(`${duplicados} ${duplicados === 1 ? 'duplicado' : 'duplicados'}`);
  }

  const invalidos = analise.resumo.telefone_invalido + analise.resumo.sem_nome;
  if (invalidos > 0) {
    partes.push(`${invalidos} ${invalidos === 1 ? 'linha inválida' : 'linhas inválidas'}`);
  }

  return partes.join(', ');
}
