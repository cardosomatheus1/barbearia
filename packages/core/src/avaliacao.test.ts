import { describe, expect, it } from 'vitest';
import {
  AVALIACOES_PARA_MOSTRAR,
  CATEGORIAS_DA_AVALIACAO,
  DESFECHOS_DA_RECUPERACAO,
  JANELA_DE_RECUPERACAO_HORAS,
  PRAZO_PARA_AVALIAR_DIAS,
  ROTULO_DA_CATEGORIA,
  ROTULO_DO_DESFECHO,
  estaPublicada,
  estrelas,
  horasRestantes,
  media,
  podeAvaliar,
  precisaDeRecuperacao,
  resumoPublico,
  validarNota,
  type Avaliacao,
  MOTIVOS_DA_CONTESTACAO,
  ROTULO_DO_MOTIVO,
  ehMotivoDaContestacao,
} from './avaliacao.js';

const AGORA = new Date('2026-11-01T12:00:00Z');

const avaliacao = (extra: Partial<Avaliacao> = {}): Avaliacao => ({
  id: 'a1',
  nota: 5,
  comentario: null,
  criadaEm: AGORA,
  resolvidaEm: null,
  contestadaEm: null,
  ...extra,
});

const horas = (n: number) => new Date(AGORA.getTime() + n * 3_600_000);

describe('a janela é de recuperação, não de censura', () => {
  it('nota boa publica na hora', () => {
    expect(estaPublicada(avaliacao({ nota: 4 }), AGORA)).toBe(true);
    expect(estaPublicada(avaliacao({ nota: 5 }), AGORA)).toBe(true);
  });

  it('nota baixa segura por 48 horas', () => {
    const ruim = avaliacao({ nota: 2 });
    expect(estaPublicada(ruim, AGORA)).toBe(false);
    expect(estaPublicada(ruim, horas(47))).toBe(false);
  });

  it('passadas as 48 horas publica sozinha, sem ninguém fazer nada', () => {
    /**
     * É a regra que torna a janela honesta. Sem ela, deixar o alerta parado no
     * painel seria o jeito de nunca publicar — e o produto viria com um filtro
     * de censura embutido, que é o que a SPEC §4.10 proíbe em letras maiúsculas.
     */
    const ruim = avaliacao({ nota: 1 });
    expect(estaPublicada(ruim, horas(JANELA_DE_RECUPERACAO_HORAS))).toBe(true);
  });

  it('resolver não impede a publicação', () => {
    /**
     * O limite ético inteiro está aqui: a casa ligou, pediu desculpa e deu
     * crédito — e a nota vai para o ar mesmo assim. Resolver registra o que foi
     * feito; não compra o direito de esconder.
     */
    const resolvida = avaliacao({ nota: 2, resolvidaEm: horas(1) });
    expect(estaPublicada(resolvida, horas(JANELA_DE_RECUPERACAO_HORAS))).toBe(true);
  });

  it('três estrelas seguram; quatro não', () => {
    // O corte da SPEC é "≤ 3", e três é o "foi ok" que esconde um problema.
    expect(estaPublicada(avaliacao({ nota: 3 }), AGORA)).toBe(false);
    expect(estaPublicada(avaliacao({ nota: 4 }), AGORA)).toBe(true);
  });
});

describe('o que o alerta do painel mostra', () => {
  it('conta as horas que restam para agir', () => {
    expect(horasRestantes(avaliacao({ nota: 2 }), horas(6))).toBe(42);
  });

  it('vencida devolve zero, e a tela diz outra coisa', () => {
    // Indicador que fica em zero para sempre é o que ensina a não olhar.
    expect(horasRestantes(avaliacao({ nota: 2 }), horas(100))).toBe(0);
  });

  it('só a nota baixa, não resolvida e dentro da janela pede atitude', () => {
    expect(precisaDeRecuperacao(avaliacao({ nota: 2 }), AGORA)).toBe(true);
    expect(precisaDeRecuperacao(avaliacao({ nota: 5 }), AGORA)).toBe(false);
    expect(precisaDeRecuperacao(avaliacao({ nota: 2, resolvidaEm: AGORA }), AGORA)).toBe(false);
    expect(precisaDeRecuperacao(avaliacao({ nota: 2 }), horas(100))).toBe(false);
  });

  it('todo desfecho e toda categoria têm rótulo', () => {
    for (const d of DESFECHOS_DA_RECUPERACAO) expect(ROTULO_DO_DESFECHO[d]).toBeTruthy();
    for (const c of CATEGORIAS_DA_AVALIACAO) expect(ROTULO_DA_CATEGORIA[c]).toBeTruthy();
  });
});

describe('a avaliação nasce de um atendimento que aconteceu', () => {
  const concluido = {
    status: 'completed',
    terminouEm: new Date(AGORA.getTime() - 3_600_000),
    jaAvaliado: false,
  };

  it('atendimento concluído pode ser avaliado', () => {
    expect(podeAvaliar(concluido, AGORA)).toEqual({ pode: true });
  });

  it('cancelado e faltado não geram avaliação', () => {
    /**
     * Não houve serviço, e uma nota sobre ele não diria nada sobre o corte. A
     * falta tem outro lugar no produto: o score de confiabilidade.
     */
    for (const status of ['cancelled_customer', 'no_show', 'confirmed', 'in_progress']) {
      expect(podeAvaliar({ ...concluido, status }, AGORA)).toMatchObject({
        recusa: 'atendimento_nao_concluido',
      });
    }
  });

  it('não avalia duas vezes o mesmo atendimento', () => {
    expect(podeAvaliar({ ...concluido, jaAvaliado: true }, AGORA)).toMatchObject({
      recusa: 'ja_avaliado',
    });
  });

  it('passados trinta dias o prazo vence', () => {
    // Sem teto, a nota de um corte de março entraria na média de dezembro — e
    // ninguém lembra do atendimento para recuperar coisa alguma.
    const tarde = new Date(AGORA.getTime() + (PRAZO_PARA_AVALIAR_DIAS + 1) * 86_400_000);
    expect(podeAvaliar(concluido, tarde)).toMatchObject({ recusa: 'prazo_vencido' });
  });

  it('a nota é inteira de 1 a 5', () => {
    expect(validarNota(0)).toBe(false);
    expect(validarNota(6)).toBe(false);
    expect(validarNota(4.5)).toBe(false);
    expect(validarNota(1)).toBe(true);
    expect(validarNota(5)).toBe(true);
  });
});

describe('a média', () => {
  it('conta a nota não publicada também', () => {
    /**
     * "A nota interna e a média real **sempre** contam para o gestor", diz a
     * SPEC. Uma média que só somasse o que está no ar seria o painel mentindo
     * para quem decide contratar e demitir.
     */
    expect(media([5, 5, 2])).toBe(4);
  });

  it('arredonda para uma casa', () => {
    expect(media([5, 4])).toBe(4.5);
    expect(media([5, 4, 4])).toBe(4.3);
  });

  it('sem avaliação é nulo, não zero', () => {
    // Zero é uma nota péssima, e a barbearia que abriu ontem não merece aparecer
    // com ela.
    expect(media([])).toBeNull();
  });
});

describe('o resumo público', () => {
  it('esconde a média enquanto houver poucas notas', () => {
    // "5,0 de uma avaliação" é ruído estatístico com cara de excelência.
    expect(resumoPublico([5])).toEqual({ media: null, total: 1 });
  });

  it('mostra a partir do mínimo', () => {
    const notas = Array.from({ length: AVALIACOES_PARA_MOSTRAR }, () => 5);
    expect(resumoPublico(notas)).toEqual({ media: 5, total: AVALIACOES_PARA_MOSTRAR });
  });
});

describe('as estrelas', () => {
  it('desenham a nota', () => {
    expect(estrelas(2)).toBe('★★☆☆☆');
    expect(estrelas(5)).toBe('★★★★★');
  });
});

describe('contestar uma avaliação', () => {
  const nota = (n: 1 | 2 | 3 | 4 | 5, extra: Partial<Avaliacao> = {}): Avaliacao => ({
    id: 'a',
    nota: n,
    comentario: null,
    criadaEm: new Date('2026-11-10T10:00:00Z'),
    resolvidaEm: null,
    contestadaEm: null,
    ...extra,
  });

  const DEPOIS = new Date('2026-11-13T10:00:00Z');

  it('contestada sai da vitrine, e a nota alta sai igual', () => {
    /**
     * Uma avaliação cinco estrelas de quem nunca foi cliente é spam elogioso, e
     * sai pelo mesmo caminho. Por isso a contestação vem **antes** da nota alta
     * no predicado.
     */
    expect(estaPublicada(nota(5), DEPOIS)).toBe(true);
    expect(estaPublicada(nota(5, { contestadaEm: DEPOIS }), DEPOIS)).toBe(false);

    expect(estaPublicada(nota(1), DEPOIS)).toBe(true);
    expect(estaPublicada(nota(1, { contestadaEm: DEPOIS }), DEPOIS)).toBe(false);
  });

  it('contestar não é resolver, e resolver não esconde', () => {
    // A janela de recuperação é de conserto, não de censura: resolver continua
    // sem cancelar a publicação.
    expect(estaPublicada(nota(1, { resolvidaEm: DEPOIS }), DEPOIS)).toBe(true);
  });

  it('os cinco motivos são fechados, e cada um tem rótulo', () => {
    // Texto livre viraria "não gostei", e "não gostei" é apagar com outro nome.
    expect(Object.keys(ROTULO_DO_MOTIVO).sort()).toEqual([...MOTIVOS_DA_CONTESTACAO].sort());
    expect(ehMotivoDaContestacao('spam')).toBe(true);
    expect(ehMotivoDaContestacao('nao_gostei')).toBe(false);
  });
});
