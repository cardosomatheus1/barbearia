import { describe, expect, it } from 'vitest';
import { PERMISSOES } from './permissoes.js';
import {
  definicaoDaMetrica,
  DIAS_MAXIMOS_DA_PERGUNTA,
  DIMENSOES,
  ehMetrica,
  formatarMetrica,
  METRICAS,
  PERGUNTAS_SUGERIDAS,
  validarPergunta,
} from './metrica.js';

/**
 * O schema semântico (bloco 63, SPEC §4.15).
 *
 * O que estes testes protegem é a fronteira: *"um conjunto fechado de métricas e
 * dimensões validadas"*. O bloco 64 vai traduzir português para uma destas
 * entradas, e se a tradução pudesse produzir qualquer coisa o **modelo** seria a
 * fronteira de segurança — e modelo não é fronteira.
 */

const TUDO = PERMISSOES as readonly string[];

const pedido = (extra: Record<string, string> = {}) => ({
  metrica: 'faturamento',
  dimensao: 'nenhuma',
  de: '2026-03-01',
  ate: '2026-03-31',
  ...extra,
});

describe('o conjunto é fechado', () => {
  it('métrica que não está no catálogo é recusada antes do banco', () => {
    const r = validarPergunta(pedido({ metrica: 'faturamento; DROP TABLE orders' }), TUDO);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.falha).toBe('metrica_desconhecida');
    expect(ehMetrica('qualquer_coisa')).toBe(false);
  });

  it('dimensão que a métrica não suporta é recusada', () => {
    /**
     * "Clientes em risco por serviço" não quer dizer nada, e a resposta certa é
     * dizer isso — não inventar um agrupamento que o executor teria que
     * suportar.
     */
    const r = validarPergunta(
      pedido({ metrica: 'clientes_em_risco', dimensao: 'servico' }),
      TUDO,
    );
    expect(r.ok === false && r.falha).toBe('dimensao_nao_suportada');
  });

  it('toda dimensão declarada existe na lista fechada', () => {
    for (const m of METRICAS) {
      for (const d of m.dimensoes) {
        expect(DIMENSOES, `${m.chave} declara "${d}"`).toContain(d);
      }
    }
  });

  it('toda permissão declarada existe no catálogo de permissões', () => {
    /**
     * Uma permissão inventada aqui seria pior que nenhuma: `every` sobre um
     * conjunto que nunca contém a string faria a métrica ficar inalcançável para
     * todo mundo — silenciosamente, e sem nada ficar vermelho.
     */
    for (const m of METRICAS) {
      for (const p of m.exige) {
        expect(TUDO, `${m.chave} exige "${p}"`).toContain(p);
      }
    }
  });
});

describe('a permissão viaja com a métrica', () => {
  it('quem não tem a permissão da métrica não recebe o número', () => {
    /**
     * É a decisão mais importante do bloco. Sem ela o assistente seria o caminho
     * mais curto para tudo que o painel guarda: a recepção perguntaria o
     * faturamento no chat e receberia, porque a rota do chat estaria declarada
     * com a permissão de **conversar**.
     */
    const r = validarPergunta(pedido(), ['appointments.view']);
    expect(r.ok === false && r.falha).toBe('sem_permissao');
  });

  it('margem exige a permissão de resultado, não a de faturamento', () => {
    // O gerente padrão tem `finance.view` e não `finance.view_profit`: é assim
    // que o dono delega a operação sem entregar a estratégia. Uma pergunta em
    // português não pode ser o atalho que a tela não é.
    const gerente = ['finance.view', 'customers.view', 'appointments.view'];
    const r = validarPergunta(
      pedido({ metrica: 'margem_por_servico', dimensao: 'servico' }),
      gerente,
    );
    expect(r.ok === false && r.falha).toBe('sem_permissao');
  });

  it('a métrica que precisa de duas permissões precisa das duas', () => {
    const so = validarPergunta(pedido({ metrica: 'perda_por_falta' }), ['finance.view']);
    expect(so.ok === false && so.falha).toBe('sem_permissao');
    const ambas = validarPergunta(pedido({ metrica: 'perda_por_falta' }), [
      'finance.view',
      'appointments.view',
    ]);
    expect(ambas.ok).toBe(true);
  });
});

describe('o período', () => {
  it('data que não existe no calendário é recusada', () => {
    // `2026-02-31` passa pela expressão regular, chega ao Postgres e estoura
    // como 500. Entrada malformada que devolve 500 é defeito de borda, sempre —
    // é o achado da revisão do bloco 62, aplicado aqui desde o começo.
    expect(validarPergunta(pedido({ de: '2026-02-31' }), TUDO).ok).toBe(false);
    expect(validarPergunta(pedido({ de: '0000-01-01' }), TUDO).ok).toBe(false);
  });

  it('a janela tem teto nas duas pontas', () => {
    expect(validarPergunta(pedido({ de: '2026-03-31', ate: '2026-03-01' }), TUDO).ok).toBe(false);
    const longa = validarPergunta(pedido({ de: '2020-01-01', ate: '2026-01-01' }), TUDO);
    expect(longa.ok === false && longa.falha).toBe('periodo_invalido');
    expect(DIAS_MAXIMOS_DA_PERGUNTA).toBeGreaterThan(0);
  });

  it('um período legítimo passa', () => {
    const r = validarPergunta(pedido(), TUDO);
    expect(r.ok).toBe(true);
    expect(r.ok && r.pergunta.metrica).toBe('faturamento');
  });
});

describe('toda resposta pode se explicar', () => {
  it('toda métrica declara unidade, e ela é uma das conhecidas', () => {
    /**
     * O `satisfies` do catálogo **não** pegou isto: `rentabilidade_do_clube`
     * entrou sem `unidade` e o typecheck do pacote passou verde — o erro só
     * apareceu no consumidor, como "propriedade não existe na união".
     *
     * Uma métrica sem unidade formata como `undefined` e a tela mostra o número
     * cru. O teste é barato e não depende de o compilador ter opinião.
     */
    const conhecidas = ['centavos', 'contagem', 'pontos_base', 'minutos', 'dias'];
    for (const m of METRICAS) {
      expect(conhecidas, `${m.chave} declara "${m.unidade}"`).toContain(m.unidade);
      expect(formatarMetrica(100, m.unidade), m.chave).not.toContain('undefined');
    }
  });

  it('toda métrica diz o que é e onde conferir', () => {
    /**
     * *"Toda resposta traz o número, o período, a fonte e um link para a tela
     * onde ele pode ser conferido."* Um número sem onde conferir é um número que
     * o dono não usa para decidir — e na primeira vez que ele discordar da tela,
     * o assistente inteiro perde o crédito.
     */
    for (const m of METRICAS) {
      expect(m.significado.length, m.chave).toBeGreaterThan(20);
      expect(m.tela, m.chave).toMatch(/^\/admin\//);
      expect(m.rotulo, m.chave).toBeTruthy();
    }
  });

  it('toda pergunta sugerida aponta para uma métrica que existe, com dimensão que ela aceita', () => {
    // Escrever a sugestão à mão na tela seria a lista paralela que este
    // repositório já achou duas vezes — em `secoes.ts` e nos públicos de campanha.
    for (const s of PERGUNTAS_SUGERIDAS) {
      expect(ehMetrica(s.metrica), s.texto).toBe(true);
      expect(definicaoDaMetrica(s.metrica).dimensoes, s.texto).toContain(s.dimensao);
    }
  });

  it('o formato sai da unidade, e não é escrito por métrica', () => {
    // Uma métrica nova que trouxesse o próprio formatador acabaria com
    // "R$ 1290,00" numa tela e "1290 reais" na outra.
    expect(formatarMetrica(129000, 'centavos')).toContain('1.290,00');
    expect(formatarMetrica(6250, 'pontos_base')).toBe('62,5%');
    expect(formatarMetrica(12, 'contagem')).toBe('12');
    expect(formatarMetrica(1, 'dias')).toBe('1 dia');
    expect(formatarMetrica(null, 'centavos')).toBe('—');
  });

  it('subir é bom em quase tudo, e falso onde precisa ser', () => {
    // Uma seta verde para cima em "Faltas" é a tela dizendo o contrário do
    // número — a lição do comparativo do DRE.
    expect(definicaoDaMetrica('faltas').subirEBom).toBe(false);
    expect(definicaoDaMetrica('perda_por_falta').subirEBom).toBe(false);
    expect(definicaoDaMetrica('clientes_em_risco').subirEBom).toBe(false);
    expect(definicaoDaMetrica('faturamento').subirEBom).toBe(true);
  });
});
