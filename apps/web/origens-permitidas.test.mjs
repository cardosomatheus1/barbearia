import { describe, expect, it } from 'vitest';
import { origensPermitidas } from './origens-permitidas.mjs';

describe('origens permitidas para Server Action', () => {
  it('fora de um proxy conhecido não libera ninguém', () => {
    expect(origensPermitidas({})).toEqual([]);
  });

  it('o endereço encaminhado do Codespaces é liberado', () => {
    expect(
      origensPermitidas({
        CODESPACE_NAME: 'probable-system-wjqw5q6575425pj5',
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev',
      }),
    ).toEqual(['probable-system-wjqw5q6575425pj5-3001.app.github.dev']);
  });

  it('a porta do endereço é a do web, não a que PORT carrega', () => {
    // Quem sobe o sistema local exporta PORT com a porta da API. Compor o
    // endereço com ela liberaria um host que não existe e deixaria o de
    // verdade recusado — que é o defeito, com outro número.
    expect(
      origensPermitidas({
        CODESPACE_NAME: 'algum-codespace',
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev',
        PORT: '3000',
        PORTA_WEB: '8080',
      }),
    ).toEqual(['algum-codespace-8080.app.github.dev']);
  });

  it('sem as duas variáveis do Codespaces, nada é montado pela metade', () => {
    expect(origensPermitidas({ CODESPACE_NAME: 'so-o-nome' })).toEqual([]);
    expect(
      origensPermitidas({ GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' }),
    ).toEqual([]);
  });

  it('a lista explícita aceita a URL colada do navegador', () => {
    expect(
      origensPermitidas({
        WEB_ORIGENS_PERMITIDAS: 'https://barbearia.exemplo.br/, http://192.168.0.10:3001',
      }),
    ).toEqual(['barbearia.exemplo.br', '192.168.0.10:3001']);
  });

  it('vírgula sobrando não vira item vazio', () => {
    // Item vazio casaria com requisição sem `origin`, que é justamente o que a
    // conferência existe para recusar.
    expect(origensPermitidas({ WEB_ORIGENS_PERMITIDAS: 'a.exemplo.br,,  ,' })).toEqual([
      'a.exemplo.br',
    ]);
  });

  it('o mesmo host declarado duas vezes aparece uma', () => {
    expect(
      origensPermitidas({
        CODESPACE_NAME: 'x',
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev',
        WEB_ORIGENS_PERMITIDAS: 'https://x-3001.app.github.dev',
      }),
    ).toEqual(['x-3001.app.github.dev']);
  });
});
