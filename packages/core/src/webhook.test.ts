import { describe, expect, it } from 'vitest';
import {
  ESCADA_DO_WEBHOOK,
  EVENTOS_DE_WEBHOOK,
  FORA_DO_CORPO,
  ROTULO_DO_EVENTO,
  desfechoDaEntrega,
  ehDestinoInterno,
  ehEventoDeWebhook,
  ehNomeInterno,
  proximaTentativaEmSegundos,
  type CorpoDoWebhook,
} from './webhook.js';

describe('webhook para terceiros', () => {
  it('o corpo não carrega dado pessoal, e a guarda é derivada', () => {
    /**
     * O bloco que acrescentar um evento vai copiar o corpo do anterior, e o dia
     * em que alguém achar prático mandar o telefone junto é o dia em que a base
     * começa a sair por aqui. Este teste monta o corpo e reprova a chave.
     */
    const corpo: CorpoDoWebhook = {
      event_id: '11111111-1111-1111-1111-111111111111',
      event: 'appointment.created',
      occurred_at: '2026-10-05T14:30:00.000Z',
      object_id: '22222222-2222-2222-2222-222222222222',
      location_id: '33333333-3333-3333-3333-333333333333',
    };

    for (const proibida of FORA_DO_CORPO) {
      expect(Object.keys(corpo)).not.toContain(proibida);
    }
    // E o corpo é fechado: quatro fatos e um id, sem sobra.
    expect(Object.keys(corpo).sort()).toEqual([
      'event',
      'event_id',
      'location_id',
      'object_id',
      'occurred_at',
    ]);
  });

  it('todo evento do catálogo tem rótulo, e nenhum rótulo sobra', () => {
    // Lista paralela é como uma das duas para de ser atualizada. O rótulo mora
    // no mesmo arquivo do catálogo, e o teste cobra a correspondência.
    expect(Object.keys(ROTULO_DO_EVENTO).sort()).toEqual([...EVENTOS_DE_WEBHOOK].sort());
    expect(ehEventoDeWebhook('appointment.created')).toBe(true);
    expect(ehEventoDeWebhook('appointment.inventado')).toBe(false);
  });

  it('2xx é entregue; 5xx e tempo esgotado retentam', () => {
    expect(desfechoDaEntrega(200, 0)).toBe('entregue');
    expect(desfechoDaEntrega(204, 3)).toBe('entregue');

    expect(desfechoDaEntrega(500, 0)).toBe('retentar');
    expect(desfechoDaEntrega(503, 2)).toBe('retentar');
    // Sem resposta nenhuma: rede caiu, e rede volta.
    expect(desfechoDaEntrega(null, 0)).toBe('retentar');
  });

  it('4xx encerra a escada, menos 408 e 429', () => {
    /**
     * A regra da recusa definitiva do adquirente: contra um `400`, os seis
     * degraus são seis chamadas que já sabem a resposta. `408` e `429` dizem
     * literalmente "tente de novo" — tratá-las como definitivas puniria o
     * integrador que está se protegendo direito.
     */
    expect(desfechoDaEntrega(400, 0)).toBe('desistir');
    expect(desfechoDaEntrega(401, 0)).toBe('desistir');
    expect(desfechoDaEntrega(404, 0)).toBe('desistir');

    expect(desfechoDaEntrega(408, 0)).toBe('retentar');
    expect(desfechoDaEntrega(429, 0)).toBe('retentar');
  });

  it('esgotada a escada, desiste — mesmo com 5xx', () => {
    // Continuar é gastar chamada contra um endereço que ninguém consertou, e
    // encher a tela de entregas que não vão acontecer.
    expect(proximaTentativaEmSegundos(ESCADA_DO_WEBHOOK.length - 1)).not.toBeNull();
    expect(proximaTentativaEmSegundos(ESCADA_DO_WEBHOOK.length)).toBeNull();
    expect(desfechoDaEntrega(500, ESCADA_DO_WEBHOOK.length)).toBe('desistir');
  });

  it('a escada só cresce, e começa em um minuto', () => {
    // Um servidor que reiniciou volta no primeiro degrau; um que caiu de
    // madrugada é alcançado pelo último.
    expect(ESCADA_DO_WEBHOOK[0]).toBe(60);
    for (let i = 1; i < ESCADA_DO_WEBHOOK.length; i += 1) {
      expect(ESCADA_DO_WEBHOOK[i] ?? 0).toBeGreaterThanOrEqual(ESCADA_DO_WEBHOOK[i - 1] ?? 0);
    }
  });
});

describe('o endereço do webhook não aponta para dentro', () => {
  it('recusa laço, privado, link-local e o metadado de nuvem', () => {
    /**
     * O risco central do bloco: o destino é escolhido por quem tem
     * `team.manage`, e quem faz a chamada somos nós, de dentro da nossa rede.
     * `169.254.169.254` é o endereço de metadado das três nuvens grandes.
     */
    for (const dentro of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '172.16.3.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.100.100.200',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
    ]) {
      expect(ehDestinoInterno(dentro), `${dentro} devia ser recusado`).toBe(true);
    }
  });

  it('deixa passar o que é de verdade da internet', () => {
    for (const fora of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      expect(ehDestinoInterno(fora), `${fora} devia passar`).toBe(false);
    }
  });

  it('o nome é recusado no cadastro, para a frase explicar', () => {
    // A resolução é a guarda de verdade; a lista de nomes existe para a recusa
    // acontecer com uma explicação, e não três dias depois em "não entregue".
    for (const dentro of ['localhost', 'db.local', 'metadata.internal', '127.0.0.1']) {
      expect(ehNomeInterno(dentro), `${dentro} devia ser recusado`).toBe(true);
    }
    expect(ehNomeInterno('erp.exemplo.com.br')).toBe(false);
  });
});
