import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LOCAIS,
  MINIMO_DA_SENHA,
  SENHA_PUBLICADA,
  ehInstalacaoDeVerdade,
  podeSemear,
} from './semente-permitida.mjs';

/**
 * A trava da semente, e por que ela mudou de critério.
 *
 * A versão anterior recusava alvo remoto conferindo o **host** de `API_URL`, com
 * `api` na lista de permitidos — o nome do serviço dentro do compose. O
 * comentário dela dizia que o defeito corrigido era "`API_URL` apontar para
 * `api:3000` independentemente de o compose estar num notebook ou num VPS", e
 * era exatamente isso que continuava valendo: `docker compose run api node
 * scripts/semear-demo.mjs` no servidor de produção passava pela trava sem
 * tropeçar.
 *
 * O perigo nunca foi o endereço. É entrar como **dono** com uma senha publicada
 * no repositório, e é isso que estes testes prendem.
 */
describe('a trava da semente', () => {
  it('senha publicada em alvo local passa — é a demonstração de sempre', () => {
    for (const host of LOCAIS) {
      expect(podeSemear({ host, senha: SENHA_PUBLICADA }).ok, host).toBe(true);
    }
  });

  it('senha publicada em alvo remoto é recusada', () => {
    const r = podeSemear({ host: 'barberdock.com.br', senha: SENHA_PUBLICADA });
    expect(r.ok).toBe(false);
  });

  it('senha publicada DENTRO do compose de produção é recusada — era o furo', () => {
    /**
     * O caso de verdade, e o que as duas primeiras versões desta trava
     * deixavam passar: `docker compose run api node scripts/semear-demo.mjs`
     * no VPS. O host é `api`, que está na lista de locais; conferir host — e
     * só ele — permitia criar a conta de dono com senha publicada num
     * endereço que a internet alcança.
     *
     * Quem denuncia a instalação real é `NODE_ENV`, que `deploy/compose.yml`
     * define, ou o `WEB_URL`, que aponta para o domínio porque é ele que sai
     * dentro das mensagens ao cliente.
     */
    const porNodeEnv = podeSemear({
      host: 'api',
      senha: SENHA_PUBLICADA,
      nodeEnv: 'production',
      webUrl: 'https://barberdock.com.br',
    });
    expect(porNodeEnv.ok, 'a semente passou no compose de produção').toBe(false);

    // Cada sinal sozinho basta: quem montar um terceiro jeito de subir isto vai
    // esquecer de um deles.
    expect(podeSemear({ host: 'api', senha: SENHA_PUBLICADA, nodeEnv: 'production' }).ok).toBe(false);
    expect(
      podeSemear({ host: 'api', senha: SENHA_PUBLICADA, webUrl: 'https://barberdock.com.br' }).ok,
    ).toBe(false);
  });

  it('o compose de desenvolvimento continua semeando com um comando', () => {
    // A trava não pode custar o caso que ela existe para permitir: quem clonou
    // o repositório para olhar roda `docker compose --profile demo up` e vê o
    // produto cheio.
    expect(
      podeSemear({ host: 'api', senha: SENHA_PUBLICADA, webUrl: 'http://localhost:3001' }).ok,
    ).toBe(true);
  });

  it('a instalação se anuncia por qualquer um dos dois sinais', () => {
    expect(ehInstalacaoDeVerdade({ nodeEnv: 'production' })).toBe(true);
    expect(ehInstalacaoDeVerdade({ webUrl: 'https://barberdock.com.br' })).toBe(true);
    expect(ehInstalacaoDeVerdade({ webUrl: 'http://localhost:3001' })).toBe(false);
    expect(ehInstalacaoDeVerdade({ webUrl: 'http://api:3001' })).toBe(false);
    // Sem sinal nenhum não se inventa um: é o caso de quem roda `node
    // scripts/semear-demo.mjs` na própria máquina, sem compose.
    expect(ehInstalacaoDeVerdade({})).toBe(false);
    expect(ehInstalacaoDeVerdade({ webUrl: 'nem-e-url' })).toBe(false);
  });

  it('senha própria passa em qualquer alvo', () => {
    // É o caso que o pedido do dono criou: encher uma instalação de verdade com
    // dados de exemplo, sem deixar porta aberta.
    expect(podeSemear({ host: 'barberdock.com.br', senha: 'uma-senha-longa-minha' }).ok).toBe(true);
  });

  it('senha curta é recusada em qualquer alvo, inclusive local', () => {
    /**
     * O piso é o do domínio (`MIN_PASSWORD`). Baixá-lo aqui seria baixá-lo no
     * produto inteiro pela porta dos fundos — e a conta criada é a de dono.
     */
    expect(podeSemear({ host: 'localhost', senha: 'curta' }).ok).toBe(false);
    expect(podeSemear({ host: 'localhost', senha: '' }).ok).toBe(false);
    expect(podeSemear({ host: 'localhost', senha: undefined }).ok).toBe(false);
    expect(podeSemear({ host: 'localhost', senha: 'a'.repeat(MINIMO_DA_SENHA) }).ok).toBe(true);
  });

  it('o compose de produção não tem serviço de semente', () => {
    /**
     * A trava é a segunda linha de defesa. A primeira é não haver o que rodar:
     * o `semear` mora no compose de desenvolvimento, atrás do perfil `demo`, e
     * o de produção não o conhece. Um serviço de semente ali seria um
     * `docker compose up` de distância de criar a conta.
     */
    const producao = readFileSync(new URL('../deploy/compose.yml', import.meta.url), 'utf8');
    expect(producao).not.toMatch(/^\s{2}semear:/m);
    expect(producao).not.toContain('semear-demo');
  });

  it('o script do servidor não tem senha padrão', () => {
    // Um padrão ali derrotaria a trava por conveniência — que é como toda trava
    // morre.
    const script = readFileSync(new URL('../deploy/semear-barbearia.sh', import.meta.url), 'utf8');
    expect(script).toMatch(/SEMENTE_SENHA:-\}/);
    expect(script).not.toMatch(/SEMENTE_SENHA="?\$\{SEMENTE_SENHA:-[^}]/);
  });
});
