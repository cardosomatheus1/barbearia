import { describe, expect, it } from 'vitest';
import { MetaWhatsAppProvider, WhatsAppMetaError, modoDoWhatsApp } from './whatsapp-meta.js';

/**
 * O provedor da Meta, sem rede.
 *
 * O `fetch` entra por parâmetro justamente para isto: o que precisa ser provado
 * aqui é o **corpo que sai** e a **leitura do que volta**, e as duas coisas são
 * puras. Teste contra rede injetada prova o que sai; o que ele não pega é campo
 * obrigatório ausente — foi assim que o `success_url` do checkout da Stripe
 * ficou faltando com a suíte verde no bloco 80. Por isso as respostas abaixo são
 * copiadas da documentação da Cloud API, e não inventadas.
 */

const CREDENCIAIS = { phoneNumberId: '106540352242922', wabaId: '102290129340398', token: 'EAAG…' };

function rede(resposta: { status?: number; corpo: unknown }) {
  const chamadas: { url: string; init: RequestInit }[] = [];
  const buscar = (async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(resposta.corpo), { status: resposta.status ?? 200 });
  }) as unknown as typeof fetch;
  return { buscar, chamadas };
}

const corpoDe = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body)) as Record<string, unknown>;

describe('o provedor da Meta', () => {
  it('manda template com as variáveis posicionais e devolve o wamid', async () => {
    // A forma da resposta é a `MessageResponsePayload` da documentação.
    const { buscar, chamadas } = rede({
      corpo: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '5571988887777', wa_id: '5571988887777' }],
        messages: [{ id: 'wamid.HBgMNTU3MTk4ODg4Nzc3', message_status: 'accepted' }],
      },
    });

    const enviada = await new MetaWhatsAppProvider(CREDENCIAIS, buscar).enviar({
      para: '+5571988887777',
      template: 'convite_de_retorno',
      idioma: 'pt_BR',
      variaveis: ['Carlos', 'Barbearia Matheus'],
      respostas: [],
    });

    expect(enviada.wamid).toBe('wamid.HBgMNTU3MTk4ODg4Nzc3');

    const chamada = chamadas[0]!;
    expect(chamada.url).toBe('https://graph.facebook.com/v21.0/106540352242922/messages');
    // O token vai no cabeçalho e nunca na URL: endereço entra em log de proxy,
    // em histórico e em `Referer`.
    expect(chamada.url).not.toContain('EAAG');
    expect((chamada.init.headers as Record<string, string>)['authorization']).toBe('Bearer EAAG…');

    expect(corpoDe(chamada.init)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+5571988887777',
      type: 'template',
      template: {
        name: 'convite_de_retorno',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Carlos' },
              { type: 'text', text: 'Barbearia Matheus' },
            ],
          },
        ],
      },
    });
  });

  it('cada botão vira um componente com o índice posicional', async () => {
    /**
     * A Meta casa o payload com o botão pela **posição** no template aprovado,
     * não pelo texto. Sem o índice, o toque em "Cancelar" voltaria com o
     * payload de "Confirmar" — e o cliente cancelaria achando que confirmou.
     */
    const { buscar, chamadas } = rede({ corpo: { messages: [{ id: 'wamid.1' }] } });

    await new MetaWhatsAppProvider(CREDENCIAIS, buscar).enviar({
      para: '+5571988887777',
      template: 'lembrete_24h',
      idioma: 'pt_BR',
      variaveis: ['Carlos'],
      respostas: [
        { botao: 'confirmar', payload: 'confirmar:ap1' },
        { botao: 'cancelar', payload: 'cancelar:ap1' },
      ],
    });

    const template = corpoDe(chamadas[0]!.init)['template'] as {
      components: { type: string; index?: string; parameters: unknown[] }[];
    };
    expect(template.components.filter((c) => c.type === 'button')).toEqual([
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'confirmar:ap1' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'cancelar:ap1' }] },
    ]);
  });

  it('template pausado é 200 e não é entrega', async () => {
    /**
     * `message_status: paused` vem com 200: a Meta aceitou e não vai entregar,
     * porque o índice de qualidade do texto caiu. Lido como sucesso, o alvo
     * seria carimbado como "recebeu" — e o carimbo é definitivo.
     */
    const { buscar } = rede({
      corpo: { messages: [{ id: 'wamid.2', message_status: 'paused' }] },
    });

    await expect(
      new MetaWhatsAppProvider(CREDENCIAIS, buscar).enviar({
        para: '+5571988887777',
        template: 'promo',
        idioma: 'pt_BR',
        variaveis: [],
        respostas: [],
      }),
    ).rejects.toThrow(/pausou o template/);
  });

  it('em avaliação de qualidade continua sendo entrega', async () => {
    // `held_for_quality_assessment` sai: a Meta ainda vai entregar, só demora.
    const { buscar } = rede({
      corpo: { messages: [{ id: 'wamid.3', message_status: 'held_for_quality_assessment' }] },
    });

    const enviada = await new MetaWhatsAppProvider(CREDENCIAIS, buscar).enviar({
      para: '+5571988887777',
      template: 'promo',
      idioma: 'pt_BR',
      variaveis: [],
      respostas: [],
    });
    expect(enviada.wamid).toBe('wamid.3');
  });

  it('200 sem wamid falha alto', async () => {
    // A mensagem pode ter saído e não haveria como conciliar o webhook depois:
    // "entregue" e "lido" ficariam em zero para sempre naquela linha.
    const { buscar } = rede({ corpo: { messages: [] } });
    await expect(
      new MetaWhatsAppProvider(CREDENCIAIS, buscar).enviar({
        para: '+5571988887777',
        template: 'promo',
        idioma: 'pt_BR',
        variaveis: [],
        respostas: [],
      }),
    ).rejects.toThrow(/não devolveu wamid/);
  });

  it('o erro carrega o código da Meta e não o telefone', async () => {
    /**
     * O código é o que responde "por que a mensagem parou de sair" — 131047 é
     * janela de 24h fechada, 132001 é template inexistente. O telefone **não**
     * entra: o erro vai para `jobs.last_error`, que é tabela sem RLS.
     */
    const { buscar } = rede({
      status: 400,
      corpo: {
        error: {
          message: 'Template name does not exist in the translation',
          code: 132001,
          error_user_msg: 'O texto não existe neste idioma.',
        },
      },
    });

    const erro = await new MetaWhatsAppProvider(CREDENCIAIS, buscar)
      .enviar({
        para: '+5571988887777',
        template: 'nao_existe',
        idioma: 'pt_BR',
        variaveis: [],
        respostas: [],
      })
      .catch((e: unknown) => e as WhatsAppMetaError);

    expect(erro).toBeInstanceOf(WhatsAppMetaError);
    expect((erro as WhatsAppMetaError).codigoDaMeta).toBe(132001);
    expect((erro as WhatsAppMetaError).message).toBe('O texto não existe neste idioma.');
    expect((erro as WhatsAppMetaError).message).not.toContain('988887777');
  });

  it('a consulta de template casa pelo idioma, não pelo primeiro da lista', async () => {
    /**
     * A Meta guarda `boas_vindas` em `pt_BR` e em `en_US` como duas linhas com
     * o mesmo nome. Pegar `data[0]` devolveria o estado de uma pela outra.
     */
    const { buscar, chamadas } = rede({
      corpo: {
        data: [
          { id: '1', language: 'en_US', status: 'REJECTED', rejected_reason: 'ABUSIVE_CONTENT' },
          { id: '2', language: 'pt_BR', status: 'APPROVED' },
        ],
      },
    });

    const resposta = await new MetaWhatsAppProvider(CREDENCIAIS, buscar).consultarTemplate(
      'boas_vindas',
      'pt_BR',
    );
    expect(resposta).toEqual({ metaId: '2', estado: 'aprovado', motivoDaRecusa: null });
    expect(chamadas[0]!.init.method).toBe('GET');
    expect(chamadas[0]!.url).toContain('102290129340398/message_templates?name=boas_vindas');
  });

  it('template que a Meta não conhece é rascunho, não aprovado', async () => {
    const { buscar } = rede({ corpo: { data: [] } });
    const r = await new MetaWhatsAppProvider(CREDENCIAIS, buscar).consultarTemplate('sumiu', 'pt_BR');
    expect(r.estado).toBe('rascunho');
  });

  it('estado desconhecido vira pendente, nunca aprovado', async () => {
    // Um estado novo lido como aprovado faria o produto mandar por um template
    // que a Meta pode ter pausado.
    const { buscar } = rede({ corpo: { data: [{ id: '1', language: 'pt_BR', status: 'LIMIT_EXCEEDED' }] } });
    const r = await new MetaWhatsAppProvider(CREDENCIAIS, buscar).consultarTemplate('x', 'pt_BR');
    expect(r.estado).toBe('pendente');
  });

  it('template com botão vai como UTILITY, sem botão como MARKETING', async () => {
    /**
     * Não é escolha estética: a Meta cobra as duas diferente e recusa promoção
     * declarada como utilidade. Quem decide é o conjunto de botões, que já é
     * derivado do tipo do aviso.
     */
    const comBotao = rede({ corpo: { id: '1', status: 'PENDING' } });
    await new MetaWhatsAppProvider(CREDENCIAIS, comBotao.buscar).submeterTemplate({
      nome: 'lembrete_24h',
      idioma: 'pt_BR',
      corpo: 'Oi {{1}}, seu horário na {{2}} é amanhã.',
      botoes: ['confirmar', 'cancelar'],
    });
    const um = corpoDe(comBotao.chamadas[0]!.init);
    expect(um['category']).toBe('UTILITY');
    expect(um['components']).toEqual([
      { type: 'BODY', text: 'Oi {{1}}, seu horário na {{2}} é amanhã.' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirmar' },
          { type: 'QUICK_REPLY', text: 'Cancelar' },
        ],
      },
    ]);

    const semBotao = rede({ corpo: { id: '2', status: 'PENDING' } });
    await new MetaWhatsAppProvider(CREDENCIAIS, semBotao.buscar).submeterTemplate({
      nome: 'promo',
      idioma: 'pt_BR',
      corpo: 'Oi {{1}}, temos novidade na {{2}}.',
      botoes: [],
    });
    expect(corpoDe(semBotao.chamadas[0]!.init)['category']).toBe('MARKETING');
  });

  it('um 302 não leva a credencial junto', async () => {
    /**
     * `redirect: 'manual'` é o que impede o token de ser apresentado a quem não
     * é a Meta. É a mesma guarda do webhook de saída do bloco 79.
     */
    const { buscar, chamadas } = rede({ corpo: { messages: [{ id: 'wamid.4' }] } });
    await new MetaWhatsAppProvider(CREDENCIAIS, buscar).enviar({
      para: '+5571988887777',
      template: 'x',
      idioma: 'pt_BR',
      variaveis: [],
      respostas: [],
    });
    expect(chamadas[0]!.init.redirect).toBe('manual');
  });
});

describe('o interruptor do processo', () => {
  it('ausente é desligado — nada vai para a internet sem alguém decidir', () => {
    expect(modoDoWhatsApp(undefined)).toBe('nenhum');
    expect(modoDoWhatsApp('')).toBe('nenhum');
  });

  it('valor desconhecido falha alto', () => {
    /**
     * Lido com tolerância, `WHATSAPP_MODO=cloud` viraria "desligado" e a
     * barbearia descobriria pelo cliente que o lembrete não chega. É o
     * precedente de `PSP_MODO` e de `FISCAL_MODO`.
     */
    expect(() => modoDoWhatsApp('cloud')).toThrow(/WHATSAPP_MODO inválido/);
  });

  it('meta é o único canal integrado', () => {
    expect(modoDoWhatsApp('meta')).toBe('meta');
  });
});
