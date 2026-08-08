import { describe, expect, it } from 'vitest';
import {
  destaquesDaFicha,
  ehConversa,
  fichaEstaVazia,
  fraseDaConversa,
  fraseDoIntervalo,
  recortarMeuDia,
  PREFERENCIAS_VAZIAS,
  type AtendimentoDoDia,
} from './meu-dia.js';

/**
 * O recorte do barbeiro.
 *
 * A pergunta que estes testes protegem não é "a lista está certa" — é "quem é o
 * próximo". Errar isso manda o barbeiro chamar o cliente errado com o salão
 * cheio, e é o tipo de defeito que faz a equipe voltar para o caderno.
 */

const AGORA = new Date('2026-09-10T17:00:00Z'); // 14h em Salvador

const at = (
  id: string,
  status: AtendimentoDoDia['status'],
  hora: string,
): AtendimentoDoDia => ({ id, status, startsAt: `2026-09-10T${hora}:00Z` });

describe('o dia do barbeiro', () => {
  it('o próximo é o mais cedo entre os que ainda vão acontecer', () => {
    const dia = recortarMeuDia(
      [at('c', 'confirmed', '19:00'), at('a', 'confirmed', '17:30'), at('b', 'pending', '18:00')],
      AGORA,
    );

    expect(dia.proximo?.id).toBe('a');
    expect(dia.depois.map((x) => x.id)).toEqual(['b', 'c']);
    expect(dia.restam).toBe(3);
  });

  it('quem está na cadeira não é o próximo — é o agora', () => {
    // Confundir os dois faria a tela dizer "próximo: Carlos" com Carlos
    // sentado. O barbeiro chamaria a próxima pessoa por cima do atendimento em
    // curso.
    const dia = recortarMeuDia(
      [at('carlos', 'in_progress', '16:30'), at('joao', 'confirmed', '17:30')],
      AGORA,
    );

    expect(dia.agora?.id).toBe('carlos');
    expect(dia.proximo?.id).toBe('joao');
    expect(dia.restam).toBe(1);
  });

  it('a ordem é a do relógio, não a do status', () => {
    /**
     * Quem fez check-in às 13h30 e está esperando vem antes de quem tem hora às
     * 14h30 e já confirmou. A cadeira vaga na ordem da agenda, não na ordem em
     * que as pessoas avisaram que vêm.
     */
    const dia = recortarMeuDia(
      [at('confirmado', 'confirmed', '17:30'), at('esperando', 'waiting', '16:30')],
      AGORA,
    );

    expect(dia.proximo?.id).toBe('esperando');
  });

  it('quem faltou não é o próximo', () => {
    // A falta é reversível, mas quem faltou não vem. Se aparecer, o balcão
    // desfaz a falta e ele volta pela transição — não porque a tela fingiu.
    const dia = recortarMeuDia(
      [at('faltou', 'no_show', '16:00'), at('vem', 'confirmed', '18:00')],
      AGORA,
    );

    expect(dia.proximo?.id).toBe('vem');
    expect(dia.faltaram).toBe(1);
    expect(dia.restam).toBe(1);
  });

  it('cancelado e remarcado não aparecem em lugar nenhum', () => {
    const dia = recortarMeuDia(
      [
        at('x', 'cancelled_customer', '16:00'),
        at('y', 'cancelled_business', '16:30'),
        at('z', 'rescheduled', '17:00'),
      ],
      AGORA,
    );

    expect(dia.proximo).toBeNull();
    expect(dia.depois).toEqual([]);
    expect(dia.restam).toBe(0);
  });

  it('dia acabado devolve nulo, não uma lista vazia disfarçada', () => {
    const dia = recortarMeuDia([at('feito', 'completed', '16:00')], AGORA);

    expect(dia.proximo).toBeNull();
    expect(dia.minutosAteProximo).toBeNull();
    expect(dia.concluidos).toBe(1);
  });

  it('o tempo até o próximo é assinado', () => {
    /**
     * "Atrasado 12 minutos" e "começa em 12 minutos" levam a decisões opostas.
     * Zerar no piso transformaria o primeiro no segundo, e o barbeiro sairia
     * para tomar um café com o cliente esperando.
     */
    const cedo = recortarMeuDia([at('a', 'confirmed', '17:30')], AGORA);
    expect(cedo.minutosAteProximo).toBe(30);

    const atrasado = recortarMeuDia([at('a', 'confirmed', '16:48')], AGORA);
    expect(atrasado.minutosAteProximo).toBe(-12);
  });

  it('a lista de entrada não é alterada', () => {
    // O recorte ordena; ordenar no lugar mudaria a lista de quem chamou, e a
    // tela do balcão usa a mesma resposta.
    const entrada = [at('b', 'confirmed', '18:00'), at('a', 'confirmed', '17:00')];
    recortarMeuDia(entrada, AGORA);
    expect(entrada.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('a frase do intervalo', () => {
  it('sem próximo, o dia acabou', () => {
    expect(fraseDoIntervalo(null)).toBe('Seu dia acabou.');
  });

  it('atraso é dito como atraso', () => {
    expect(fraseDoIntervalo(-12)).toBe('Atrasado 12 min.');
  });

  it('agora é agora', () => {
    expect(fraseDoIntervalo(0)).toBe('É agora.');
  });

  it('a partir de vinte minutos, dá tempo de sair', () => {
    // O corte está em 20 porque é quanto leva sair, tomar um café e voltar.
    expect(fraseDoIntervalo(19)).not.toContain('café');
    expect(fraseDoIntervalo(20)).toContain('café');
  });
});

describe('a ficha do cliente', () => {
  it('ficha só com o padrão de conversa continua vazia', () => {
    /**
     * `indiferente` é o que a coluna dá a quem nunca foi perguntado. Contá-lo
     * como preenchido faria toda ficha em branco parecer preenchida — e é assim
     * que o barbeiro aprende a não confiar na tela.
     */
    expect(fichaEstaVazia(PREFERENCIAS_VAZIAS)).toBe(true);
    expect(fichaEstaVazia({ ...PREFERENCIAS_VAZIAS, conversa: 'silencioso' })).toBe(false);
    expect(fichaEstaVazia({ ...PREFERENCIAS_VAZIAS, topo: 'Tesoura' })).toBe(false);
  });

  it('campo só com espaço não conta como preenchido', () => {
    expect(fichaEstaVazia({ ...PREFERENCIAS_VAZIAS, topo: '   ' })).toBe(true);
  });

  it('o que evitar vem antes de tudo', () => {
    /**
     * É o único campo cuja falha machuca. Alergia a pós-barba com álcool lida
     * depois da navalha não serviu para nada.
     */
    const destaques = destaquesDaFicha({
      ...PREFERENCIAS_VAZIAS,
      maquinaLaterais: 'Máquina 1',
      tipoDegrade: 'Degradê médio',
      produtosEvitar: 'Álcool no pós-barba',
    });

    expect(destaques[0]).toEqual({ rotulo: 'Evitar', valor: 'Álcool no pós-barba' });
    expect(destaques).toHaveLength(3);
  });

  it('campo vazio não vira destaque em branco', () => {
    expect(destaquesDaFicha(PREFERENCIAS_VAZIAS)).toEqual([]);
  });

  it('só o que muda o atendimento vira frase', () => {
    expect(fraseDaConversa('silencioso')).toBe('Prefere atendimento silencioso');
    expect(fraseDaConversa('conversa')).toBe('Gosta de conversar');
    // "Indiferente" não vira linha na tela: ocuparia espaço para não dizer nada.
    expect(fraseDaConversa('indiferente')).toBeNull();
  });

  it('vocabulário de conversa é fechado', () => {
    expect(ehConversa('silencioso')).toBe(true);
    expect(ehConversa('quieto')).toBe(false);
  });
});
