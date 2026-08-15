import { describe, expect, it } from 'vitest';
import {
  SignupError,
  assinarWebhook,
  credenciaisDaPlataforma,
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
    const naTela = signupNaTela(CREDENCIAIS);
    expect(naTela).toEqual({ appId: CREDENCIAIS.appId, configId: CREDENCIAIS.configId });
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
