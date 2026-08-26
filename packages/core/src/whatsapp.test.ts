import { describe, expect, it } from 'vitest';
import {
  AVISO_SEM_GERENCIA,
  BOTOES_DA_MENSAGEM,
  BOTOES_DO_AVISO,
  ESCOPO_DE_ENVIO,
  ESCOPO_DE_GERENCIA,
  ESTADOS_DO_TEMPLATE,
  ESTADOS_DO_WHATSAPP,
  EXPLICACAO_DO_TEMPLATE,
  EXPLICACAO_DO_WHATSAPP,
  FakeWhatsAppProvider,
  ROTULO_DO_BOTAO,
  ROTULO_DO_TEMPLATE,
  estadoDoTextoNaTela,
  ROTULO_DO_WHATSAPP,
  botaoConhecido,
  lerPayload,
  montarPayload,
  podeGerenciarTemplates,
  templateUtilizavel,
  whatsappDisponivel,
} from './whatsapp.js';
import { TIPOS_DE_NOTIFICACAO } from './notificacao.js';

/**
 * WhatsApp oficial (bloco 55, SPEC §4.12).
 *
 * O que estes testes prendem é o **contrato** e as decisões que não podem
 * escorregar para a implementação: que só template aprovado sai, que o botão
 * carrega qual horário ele mexe, e que o que volta do aparelho do cliente é
 * conferido antes de virar ação.
 */

describe('o estado do cadastro', () => {
  it('só o ativo manda mensagem', () => {
    expect(whatsappDisponivel('ativo')).toBe(true);
    for (const outro of ['nao_configurado', 'aguardando_verificacao', 'suspenso'] as const) {
      expect(whatsappDisponivel(outro)).toBe(false);
    }
  });

  it('todo estado tem rótulo e explicação', () => {
    // Quatro estados e não um booleano porque cada um pede uma coisa diferente
    // de quem opera. Um sem texto seria o que a tela não sabe explicar.
    for (const estado of ESTADOS_DO_WHATSAPP) {
      expect(ROTULO_DO_WHATSAPP[estado]).toBeTruthy();
      expect(EXPLICACAO_DO_WHATSAPP[estado]).toBeTruthy();
    }
  });

  it('a explicação do suspenso manda olhar o motivo', () => {
    // É o único estado que aparece **depois** de tudo ter funcionado, e a
    // pergunta que ele gera é sempre "por quê".
    expect(EXPLICACAO_DO_WHATSAPP.suspenso).toContain('motivo');
  });
});

describe('o que o token concedido pode', () => {
  it('sem a permissão de gerência, não cria texto novo', () => {
    // É o cadastro que conecta sem erro nenhum e morre na primeira tentativa de
    // aprovar um texto, com uma frase da Meta que não nomeia permissão.
    expect(podeGerenciarTemplates([ESCOPO_DE_ENVIO])).toBe(false);
  });

  it('com a permissão de gerência, cria', () => {
    expect(podeGerenciarTemplates([ESCOPO_DE_ENVIO, ESCOPO_DE_GERENCIA])).toBe(true);
  });

  it('"não dá para dizer" não é "não pode"', () => {
    /**
     * O caso que decide o bloco.
     *
     * Cadastro pelo formulário do bloco 55 nunca fala com a Meta, e cadastro
     * anterior ao 88 não tem escopo gravado. Se a ausência virasse `false`, a
     * tela acusaria de falta de acesso quem está mandando mensagem sem
     * reclamar — e o aviso apareceria sobre um cadastro que funciona.
     *
     * `toBe(null)` e não `toBeFalsy()`: `false` passaria num teste frouxo, e é
     * exatamente o valor errado.
     */
    expect(podeGerenciarTemplates(null)).toBe(null);
  });

  it('o aviso diz o que fazer, e não só o que falta', () => {
    // "Falta uma permissão" sobre um painel de terceiro com dezenas de telas é
    // a lista que ninguém abre duas vezes — é a decisão do bloco 87.
    expect(AVISO_SEM_GERENCIA).toContain('Reconecte');
    // E promete o que continua funcionando: sem isso a frase lê como "o
    // WhatsApp parou", e alguém desliga o canal inteiro por causa dela.
    expect(AVISO_SEM_GERENCIA).toContain('continuam saindo');
  });
});

describe('o estado do template', () => {
  it('só o aprovado sai', () => {
    expect(templateUtilizavel('aprovado')).toBe(true);
    for (const outro of ['rascunho', 'pendente', 'rejeitado', 'pausado'] as const) {
      expect(templateUtilizavel(outro)).toBe(false);
    }
  });

  it('todo estado tem rótulo e explicação', () => {
    for (const estado of ESTADOS_DO_TEMPLATE) {
      expect(ROTULO_DO_TEMPLATE[estado]).toBeTruthy();
      expect(EXPLICACAO_DO_TEMPLATE[estado]).toBeTruthy();
    }
  });

  it('a explicação do pausado diz o que faz voltar', () => {
    /**
     * `pausado` é o estado que a Meta aplica sozinha quando o índice de
     * qualidade cai, e é o único que aparece depois de tudo ter funcionado. Sem
     * dizer que mandar menos é o que resolve, o dono só sabe que parou.
     */
    expect(EXPLICACAO_DO_TEMPLATE.pausado).toContain('menos');
  });
});

describe('os botões da mensagem', () => {
  it('todo botão tem texto, e ele mora em core', () => {
    // O mesmo botão aparece no template, na mensagem e no histórico do balcão.
    for (const botao of BOTOES_DA_MENSAGEM) {
      expect(ROTULO_DO_BOTAO[botao]).toBeTruthy();
    }
  });

  it('todo aviso declara seus botões', () => {
    for (const tipo of TIPOS_DE_NOTIFICACAO) {
      expect(BOTOES_DO_AVISO[tipo]).toBeDefined();
    }
  });

  it('duas horas antes não se oferece remarcar', () => {
    /**
     * Não há grade para remanejar no mesmo dia, e oferecer produz a frustração
     * de tentar e não ter. Cancelar continua: é justamente o aviso tardio que o
     * botão existe para conseguir.
     */
    expect(BOTOES_DO_AVISO.lembrete_2h).not.toContain('remarcar');
    expect(BOTOES_DO_AVISO.lembrete_2h).toContain('cancelar');
  });

  it('o retorno não oferece cancelar o que não existe', () => {
    expect(BOTOES_DO_AVISO.retorno).toEqual(['agendar_novamente']);
  });

  it('a senha de acesso não leva botão nenhum', () => {
    // Ela não é sobre um horário, e um botão ali não teria o que mexer.
    expect(BOTOES_DO_AVISO.senha_de_acesso).toEqual([]);
  });
});

describe('o que volta do aparelho do cliente', () => {
  const AGENDAMENTO = '5a5a5a5a-1111-4111-8111-111111111111';

  it('o payload leva a ação e o horário', () => {
    const payload = montarPayload('cancelar', AGENDAMENTO);
    expect(lerPayload(payload)).toEqual({ botao: 'cancelar', agendamentoId: AGENDAMENTO });
  });

  it('ida e volta fecham para todos os botões', () => {
    for (const botao of BOTOES_DA_MENSAGEM) {
      expect(lerPayload(montarPayload(botao, AGENDAMENTO))?.botao).toBe(botao);
    }
  });

  it('botão que não existe é recusado', () => {
    /**
     * O payload viaja pelo aparelho do cliente. Assumir que ele volta intacto é
     * o erro que esta função existe para não cometer — e "apagar" não é um
     * botão deste produto em lugar nenhum.
     */
    expect(lerPayload(`apagar:${AGENDAMENTO}`)).toBeNull();
    expect(botaoConhecido('apagar')).toBe(false);
  });

  it('id que não é UUID é recusado', () => {
    expect(lerPayload('cancelar:1')).toBeNull();
    expect(lerPayload("cancelar:' OR 1=1 --")).toBeNull();
  });

  it('payload vazio, sem separador ou ausente é recusado', () => {
    expect(lerPayload(null)).toBeNull();
    expect(lerPayload(undefined)).toBeNull();
    expect(lerPayload('')).toBeNull();
    expect(lerPayload('cancelar')).toBeNull();
  });

  it('id bem formado de outra barbearia passa aqui — quem barra é a RLS', () => {
    // A função confere **forma**, não pertencimento: um UUID de outra barbearia
    // é sintaticamente perfeito. É a consulta sob `withTenant` que não o acha, e
    // é por isso que o comentário da função diz isso em letras.
    const alheio = '99999999-9999-4999-8999-999999999999';
    expect(lerPayload(montarPayload('cancelar', alheio))).toEqual({
      botao: 'cancelar',
      agendamentoId: alheio,
    });
  });
});

describe('o provedor de mentira', () => {
  it('template nasce pendente, que é o estado real de um recém-enviado', async () => {
    /**
     * A aprovação da Meta leva de minutos a dias. Um fake que já nascesse
     * aprovado faria a cadeia de conciliação nunca ser percorrida pelo caminho
     * da vida real — é a mesma decisão do emissor fiscal e do adquirente.
     */
    const provedor = new FakeWhatsAppProvider();
    const resposta = await provedor.submeterTemplate({
      nome: 'lembrete_24h_v1',
      idioma: 'pt_BR',
      corpo: 'Olá {{1}}',
      botoes: ['confirmar'],
      tipo: 'lembrete_24h',
    });
    expect(resposta.estado).toBe('pendente');
  });

  it('a recusa vem com motivo, e só quando é recusa', async () => {
    const provedor = new FakeWhatsAppProvider();
    provedor.proximoEstadoDoTemplate = 'rejeitado';
    provedor.proximaRecusa = 'conteúdo promocional em template utilitário';
    const recusado = await provedor.consultarTemplate('lembrete_24h_v1', 'pt_BR');
    expect(recusado).toMatchObject({ estado: 'rejeitado', motivoDaRecusa: expect.any(String) });

    provedor.proximoEstadoDoTemplate = 'aprovado';
    const aprovado = await provedor.consultarTemplate('lembrete_24h_v1', 'pt_BR');
    expect(aprovado.motivoDaRecusa).toBeNull();
  });

  it('cada envio devolve um id próprio', async () => {
    // O `wamid` é a chave da conciliação: dois envios com o mesmo id fariam a
    // segunda mensagem sumir dentro da primeira.
    const provedor = new FakeWhatsAppProvider();
    const mensagem = {
      para: '+5571988887777',
      template: 'lembrete_24h_v1',
      idioma: 'pt_BR',
      variaveis: ['Carlos'],
      respostas: [],
    };
    const a = await provedor.enviar(mensagem);
    const b = await provedor.enviar(mensagem);
    expect(a.wamid).not.toBe(b.wamid);
  });

  it('o caminho de falha existe sem depender de rede fora do ar', async () => {
    const provedor = new FakeWhatsAppProvider();
    provedor.falharProxima = true;
    await expect(
      provedor.enviar({
        para: '+5571988887777',
        template: 'x',
        idioma: 'pt_BR',
        variaveis: [],
        respostas: [],
      }),
    ).rejects.toThrow('indisponível');
    // E só a próxima: a falha não gruda no provedor.
    await expect(
      provedor.enviar({
        para: '+5571988887777',
        template: 'x',
        idioma: 'pt_BR',
        variaveis: [],
        respostas: [],
      }),
    ).resolves.toMatchObject({ wamid: expect.any(String) });
  });
});

describe('o que a tela escreve sobre um texto', () => {
  it('separa "esperando a fila" de "esperando a Meta"', () => {
    // O defeito que ela impede: a tela dizia "Enviado. A Meta costuma responder
    // em minutos" no instante em que a requisição voltava — e a requisição só
    // enfileira desde o bloco 133. Quem fosse conferir no painel da Meta não
    // acharia nada.
    const naFila = estadoDoTextoNaTela('pendente', true);
    const naMeta = estadoDoTextoNaTela('pendente', false);
    expect(naFila.rotulo).not.toBe(naMeta.rotulo);
    expect(naFila.explicacao).not.toBe(naMeta.explicacao);
    expect(naMeta.explicacao).toContain('Meta');
  });

  it('ignora a fila em todo estado que a Meta já respondeu', () => {
    // Um texto aprovado não está esperando fila nenhuma. Sem o recorte por
    // `pendente`, uma linha com `submission_state` velho diria "Na fila" sobre
    // um texto que já sai.
    for (const estado of ['rascunho', 'aprovado', 'rejeitado', 'pausado'] as const) {
      expect(estadoDoTextoNaTela(estado, true)).toEqual(estadoDoTextoNaTela(estado, false));
      expect(estadoDoTextoNaTela(estado, true).rotulo).toBe(ROTULO_DO_TEMPLATE[estado]);
    }
  });
});
