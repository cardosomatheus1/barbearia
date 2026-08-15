import { describe, expect, it } from 'vitest';
import {
  SignupError,
  assinarWebhook,
  conectarPeloSignup,
  credenciaisDaPlataforma,
  modoDoOnboarding,
  registrarNumero,
  signupNaTela,
  trocarCodigoPorToken,
} from './whatsapp-signup.js';

/**
 * O Embedded Signup, sem rede.
 *
 * O que precisa ser provado aqui é o que **sai** — e, mais importante, o que
 * **não** sai: o `META_APP_SECRET` assina em nome do app inteiro, para todas as
 * barbearias, e um único caminho que o devolva à tela o entrega a quem abrir o
 * código-fonte da página.
 */

const CREDENCIAIS = { appId: '1957444791626828', appSecret: 'segredo-do-app', configId: '1043274278612160' };

function rede(resposta: { status?: number; corpo: unknown }) {
  const chamadas: { url: string; init: RequestInit }[] = [];
  const buscar = (async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(resposta.corpo), { status: resposta.status ?? 200 });
  }) as unknown as typeof fetch;
  return { buscar, chamadas };
}

describe('as credenciais do app', () => {
  it('faltando qualquer uma das três, não há conexão automática', () => {
    /**
     * `null` e não exceção: o produto opera sem Embedded Signup — o formulário
     * do bloco 55 continua lá. Falhar na subida trancaria o painel inteiro por
     * causa de uma tela.
     */
    expect(credenciaisDaPlataforma({})).toBeNull();
    expect(credenciaisDaPlataforma({ META_APP_ID: 'a', META_CONFIG_ID: 'b' })).toBeNull();
    expect(credenciaisDaPlataforma({ META_APP_ID: 'a', META_APP_SECRET: 'b' })).toBeNull();
    expect(
      credenciaisDaPlataforma({ META_APP_ID: 'a', META_APP_SECRET: '', META_CONFIG_ID: 'c' }),
    ).toBeNull();
  });

  it('as três presentes ligam o botão', () => {
    expect(
      credenciaisDaPlataforma({
        META_APP_ID: 'a',
        META_APP_SECRET: 'b',
        META_CONFIG_ID: 'c',
      }),
    ).toEqual({ appId: 'a', appSecret: 'b', configId: 'c' });
  });
});

describe('o que a tela recebe', () => {
  it('nunca o segredo do app', () => {
    /**
     * `appId` e `configId` vão para o `FB.login` dentro do navegador e são
     * públicos por desenho. O `appSecret` é o que impede outro produto de
     * trocar um código emitido para nós — devolvê-lo à tela seria mandá-lo para
     * dentro de um HTML que fica no histórico do navegador. É o precedente do
     * token da barbearia, que a tela recebe como "existe" e nunca como valor.
     */
    const naTela = signupNaTela(CREDENCIAIS, 'padrao');
    // `modo` entrou no bloco 85 e é público por natureza — ele diz qual fluxo a
    // janela abre, não uma credencial. O que este teste prende continua sendo o
    // que **não** sai, e por isso a asserção do segredo é sobre o objeto
    // inteiro serializado, e não sobre os campos que eu lembrei de listar.
    expect(naTela).toEqual({
      appId: CREDENCIAIS.appId,
      configId: CREDENCIAIS.configId,
      modo: 'padrao',
    });
    expect(JSON.stringify(naTela)).not.toContain('segredo-do-app');
  });

  it('sem app configurado, a tela não desenha o botão', () => {
    // Botão que abre uma janela vazia é pior que botão nenhum.
    expect(signupNaTela(null)).toBeNull();
  });
});

describe('a troca do código pelo token', () => {
  it('manda o segredo do app, e devolve o token da barbearia', async () => {
    const { buscar, chamadas } = rede({ corpo: { access_token: 'EAAG-token-da-casa' } });
    const token = await trocarCodigoPorToken('AQD-codigo', CREDENCIAIS, buscar);

    expect(token).toBe('EAAG-token-da-casa');
    const url = new URL(chamadas[0]!.url);
    expect(url.origin + url.pathname).toBe('https://graph.facebook.com/v21.0/oauth/access_token');
    expect(url.searchParams.get('client_id')).toBe(CREDENCIAIS.appId);
    expect(url.searchParams.get('client_secret')).toBe(CREDENCIAIS.appSecret);
    expect(url.searchParams.get('code')).toBe('AQD-codigo');
  });

  it('resposta sem token falha em vez de gravar cadastro vazio', async () => {
    /**
     * 200 sem `access_token` gravaria um cadastro que se diz conectado e não
     * consegue mandar nada — "Ativo" na tela com toda mensagem caindo no canal
     * de reserva, sem erro em lugar nenhum.
     */
    const { buscar } = rede({ corpo: {} });
    await expect(trocarCodigoPorToken('x', CREDENCIAIS, buscar)).rejects.toThrow(
      /não devolveu um token/,
    );
  });

  it('a frase da Meta chega inteira, porque é ela que diz o que fazer', async () => {
    const { buscar } = rede({
      status: 400,
      corpo: {
        error: {
          message: 'This authorization code has been used',
          error_user_msg: 'Este código já foi usado. Tente conectar de novo.',
        },
      },
    });
    const erro = await trocarCodigoPorToken('x', CREDENCIAIS, buscar).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(SignupError);
    expect((erro as SignupError).message).toBe('Este código já foi usado. Tente conectar de novo.');
  });

  it('um 302 não leva o segredo do app junto', async () => {
    // Mesma guarda do webhook de saída do bloco 79 e do provedor da Meta.
    const { buscar, chamadas } = rede({ corpo: { access_token: 't' } });
    await trocarCodigoPorToken('x', CREDENCIAIS, buscar);
    expect(chamadas[0]!.init.redirect).toBe('manual');
  });
});

describe('assinar o webhook e registrar o número', () => {
  it('a assinatura usa o token da barbearia, não o segredo do app', async () => {
    /**
     * Sem esta chamada a barbearia manda mensagem e **não recebe nada de
     * volta**: nem "entregue", nem "lido", nem o toque nos botões — e a tela da
     * campanha ficaria com dois indicadores em zero para sempre.
     */
    const { buscar, chamadas } = rede({ corpo: { success: true } });
    await assinarWebhook('102290129340398', 'EAAG-token-da-casa', buscar);

    expect(chamadas[0]!.url).toBe(
      'https://graph.facebook.com/v21.0/102290129340398/subscribed_apps',
    );
    expect(chamadas[0]!.init.method).toBe('POST');
    const cabecalhos = chamadas[0]!.init.headers as Record<string, string>;
    expect(cabecalhos['authorization']).toBe('Bearer EAAG-token-da-casa');
    expect(JSON.stringify(chamadas[0]!.init)).not.toContain(CREDENCIAIS.appSecret);
  });

  it('o registro manda o produto e o PIN, que é o que a Meta exige', async () => {
    const { buscar, chamadas } = rede({ corpo: { success: true } });
    await registrarNumero('106540352242922', 'tok', '123456', buscar);

    expect(chamadas[0]!.url).toBe('https://graph.facebook.com/v21.0/106540352242922/register');
    expect(JSON.parse(String(chamadas[0]!.init.body))).toEqual({
      messaging_product: 'whatsapp',
      pin: '123456',
    });
  });
});

describe('a descoberta da conta e do número pelo token', () => {
  /**
   * O conserto do celular (bloco 84).
   *
   * A documentação da Meta manda o navegador ouvir um evento e mandar os ids
   * para o servidor. No computador funciona; no celular o fluxo abre numa aba
   * separada e a mensagem não volta — e foi o que aconteceu na primeira
   * conexão de verdade deste produto: a Meta concluiu, e a nossa tela não
   * mudou nada nem disse por quê.
   *
   * Estes testes prendem o caminho que **não** depende de mensagem entre abas.
   * As respostas são as da documentação do `debug_token` e do `phone_numbers`.
   */
  function redeEmSequencia(respostas: { status?: number; corpo: unknown }[]) {
    const chamadas: { url: string; init: RequestInit }[] = [];
    let i = 0;
    const buscar = (async (url: string | URL, init?: RequestInit) => {
      chamadas.push({ url: String(url), init: init ?? {} });
      const r = respostas[i++] ?? { corpo: {} };
      return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
    return { buscar, chamadas };
  }

  it('sem os ids, o servidor os descobre — é o caminho do celular', async () => {
    const { buscar, chamadas } = redeEmSequencia([
      { corpo: { access_token: 'EAAG-token-da-casa' } },
      {
        corpo: {
          data: {
            granular_scopes: [
              { scope: 'whatsapp_business_messaging', target_ids: ['102290129340398'] },
              { scope: 'whatsapp_business_management', target_ids: ['102290129340398'] },
            ],
          },
        },
      },
      { corpo: { data: [{ id: '106540352242922', display_phone_number: '+55 71 98888-7777' }] } },
      { corpo: { success: true } },
      { corpo: { success: true } },
    ]);

    // `salvarCadastroDoWhatsApp` vai ao banco, então o que se prova aqui é a
    // conversa com a Meta: a gravação tem suíte de integração própria.
    await conectarPeloSignup({
      tenantId: '00000000-0000-0000-0000-000000000001',
      locationId: '00000000-0000-0000-0000-000000000002',
      code: 'AQD-codigo',
      numeroVisivel: null,
      staffId: '00000000-0000-0000-0000-000000000003',
      staffName: 'Matheus',
      credenciais: CREDENCIAIS,
      buscar,
    }).catch(() => undefined);

    const urls = chamadas.map((c) => c.url);
    expect(urls[0]).toContain('/oauth/access_token');
    // O token do app é id|segredo, e vai só para o `debug_token`.
    expect(urls[1]).toContain('/debug_token');
    expect(urls[1]).toContain('input_token=EAAG-token-da-casa');
    expect(urls[1]).toContain(encodeURIComponent(`${CREDENCIAIS.appId}|${CREDENCIAIS.appSecret}`));
    // A conta descoberta é a que decide o resto.
    expect(urls[2]).toBe('https://graph.facebook.com/v21.0/102290129340398/phone_numbers');
    expect(urls[3]).toBe('https://graph.facebook.com/v21.0/102290129340398/subscribed_apps');
    expect(urls[4]).toBe('https://graph.facebook.com/v21.0/106540352242922/register');
  });

  it('com os ids em mãos, não pergunta nada — é o caminho do computador', async () => {
    const { buscar, chamadas } = redeEmSequencia([
      { corpo: { access_token: 'tok' } },
      { corpo: { success: true } },
      { corpo: { success: true } },
    ]);

    await conectarPeloSignup({
      tenantId: '00000000-0000-0000-0000-000000000001',
      locationId: '00000000-0000-0000-0000-000000000002',
      code: 'AQD',
      wabaId: '102290129340398',
      phoneNumberId: '106540352242922',
      numeroVisivel: '+55 71 98888-7777',
      staffId: '00000000-0000-0000-0000-000000000003',
      staffName: 'Matheus',
      credenciais: CREDENCIAIS,
      buscar,
    }).catch(() => undefined);

    // Uma ida a menos: sem `debug_token` e sem `phone_numbers`.
    expect(chamadas.map((c) => c.url).some((u) => u.includes('debug_token'))).toBe(false);
  });

  it('conta sem número diz o que fazer, e não o que faltou', async () => {
    /**
     * É o `FINISH_ONLY_WABA` visto do lado do servidor. Quem está do outro lado
     * não sabe o que é uma conta sem número — sabe que apertou um botão e não
     * terminou.
     */
    const { buscar } = redeEmSequencia([
      { corpo: { access_token: 'tok' } },
      { corpo: { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['1'] }] } } },
      { corpo: { data: [] } },
    ]);

    const erro = await conectarPeloSignup({
      tenantId: '00000000-0000-0000-0000-000000000001',
      locationId: '00000000-0000-0000-0000-000000000002',
      code: 'AQD',
      numeroVisivel: null,
      staffId: '00000000-0000-0000-0000-000000000003',
      staffName: 'Matheus',
      credenciais: CREDENCIAIS,
      buscar,
    }).catch((e: unknown) => e as SignupError);

    expect((erro as SignupError).message).toMatch(/nenhum número de telefone foi acrescentado/);
  });

  it('token que não nomeia conta nenhuma falha com frase acionável', async () => {
    const { buscar } = redeEmSequencia([
      { corpo: { access_token: 'tok' } },
      { corpo: { data: { granular_scopes: [{ scope: 'public_profile' }] } } },
    ]);

    const erro = await conectarPeloSignup({
      tenantId: '00000000-0000-0000-0000-000000000001',
      locationId: '00000000-0000-0000-0000-000000000002',
      code: 'AQD',
      numeroVisivel: null,
      staffId: '00000000-0000-0000-0000-000000000003',
      staffName: 'Matheus',
      credenciais: CREDENCIAIS,
      buscar,
    }).catch((e: unknown) => e as SignupError);

    expect((erro as SignupError).message).toMatch(/não disse a qual conta/);
  });
});

describe('o fluxo que a janela abre', () => {
  /**
   * Coexistência (bloco 85).
   *
   * O fluxo **padrão** toma o número: ele sai do aplicativo WhatsApp e passa a
   * ser da Cloud API. A **coexistência** conecta um número que a barbearia já
   * usa no WhatsApp Business, e ele continua funcionando lá.
   *
   * A diferença entre os dois é a barbearia perder ou não o número pelo qual
   * ela atende — e por isso o padrão é o comportamento anterior, e um valor
   * desconhecido falha alto em vez de escorregar para o que toma.
   */
  it('ausente é o comportamento anterior', () => {
    expect(modoDoOnboarding(undefined)).toBe('padrao');
    expect(modoDoOnboarding('')).toBe('padrao');
  });

  it('valor desconhecido falha alto, e o motivo está na frase', () => {
    // Lido com tolerância, um erro de digitação abriria o fluxo que toma o
    // número da barbearia — o oposto do que a coexistência existe para fazer.
    expect(() => modoDoOnboarding('coexistence')).toThrow(/WHATSAPP_ONBOARDING inválido/);
    expect(() => modoDoOnboarding('whatsapp_business_app_onboarding')).toThrow(/toma o número/);
  });

  it('a tela recebe o modo, porque é ela que avisa o que acontece com o número', () => {
    /**
     * O modo não serve só para montar o `extras`: a tela diz coisas opostas nos
     * dois casos — "o número sai do aplicativo" contra "o número continua
     * funcionando". Avisar errado é a barbearia perder o canal que usa todo dia.
     */
    expect(signupNaTela(CREDENCIAIS, 'coexistencia')).toEqual({
      appId: CREDENCIAIS.appId,
      configId: CREDENCIAIS.configId,
      modo: 'coexistencia',
    });
    expect(signupNaTela(CREDENCIAIS, 'padrao')?.modo).toBe('padrao');
  });

  it('sem app configurado não há botão, em qualquer modo', () => {
    expect(signupNaTela(null, 'coexistencia')).toBeNull();
  });
});
