import { describe, expect, it } from 'vitest';
import {
  ehPermissao,
  PERMISSAO_DE_DINHEIRO_SEM_SEGUNDO_FATOR,
  PAPEIS,
  PERMISSOES,
  PERMISSOES_DE_DINHEIRO,
  permissoesPadrao,
  pode,
  podeTudo,
  suportePode,
  type Papel,
} from './permissoes.js';

describe('catálogo de permissões', () => {
  it('não tem permissão repetida', () => {
    // Duplicata faria a contagem de um papel mentir e esconderia uma remoção.
    expect(new Set(PERMISSOES).size).toBe(PERMISSOES.length);
  });

  it('reconhece o que está no catálogo e recusa o resto', () => {
    expect(ehPermissao('appointments.cancel')).toBe(true);
    // Permissão escrita errada numa rota recusaria todo mundo, em silêncio.
    expect(ehPermissao('appointments.canccel')).toBe(false);
    expect(ehPermissao('*')).toBe(false);
    expect(ehPermissao('')).toBe(false);
  });

  it('todo papel só concede permissão que existe', () => {
    for (const papel of PAPEIS) {
      for (const permissao of permissoesPadrao(papel)) {
        expect(ehPermissao(permissao), `${papel} concede ${permissao}`).toBe(true);
      }
    }
  });
});

describe('padrão de fábrica dos papéis', () => {
  it('o dono tem tudo', () => {
    // É a única conta que não pode ser trancada para fora do próprio negócio.
    expect([...permissoesPadrao('owner')].sort()).toEqual([...PERMISSOES].sort());
  });

  it('o profissional vê a própria comissão e não a do colega', () => {
    // Motivo nº 1 de briga interna em barbearia (SPEC Parte 1 §1.3).
    const dele = permissoesPadrao('professional');
    expect(dele).toContain('commission.view_own');
    expect(dele).not.toContain('commission.view_all');
  });

  it('o gerente vê faturamento e não vê margem', () => {
    // É o que permite delegar a operação sem entregar a estratégia.
    const dele = permissoesPadrao('manager');
    expect(dele).toContain('finance.view');
    expect(dele).not.toContain('finance.view_profit');
  });

  it('exportar cliente é só do dono', () => {
    // Vetor de roubo de base quando alguém sai. Não acompanha `customers.view`
    // nem para o gerente.
    for (const papel of PAPEIS) {
      const esperado = papel === 'owner';
      expect(permissoesPadrao(papel).includes('customers.export'), papel).toBe(esperado);
    }
  });

  it('a recepção acha o cliente sem ler o que anotaram sobre ele', () => {
    const dela = permissoesPadrao('receptionist');
    expect(dela).toContain('customers.view');
    expect(dela).not.toContain('customers.view_notes');
    expect(dela).not.toContain('customers.view_photos');
  });

  it('só o dono administra a equipe e mexe em dinheiro', () => {
    // Dar a chave do faturamento a quem só marca presença é o incidente que
    // este bloco existe para impedir.
    const perigosas = ['team.manage', 'finance.view_profit', 'finance.export'] as const;
    for (const papel of PAPEIS.filter((p): p is Papel => p !== 'owner')) {
      for (const permissao of perigosas) {
        expect(permissoesPadrao(papel).includes(permissao), `${papel} tem ${permissao}`).toBe(
          false,
        );
      }
    }
  });

  it('ninguém além do dono acumula tudo', () => {
    // Guarda contra alguém "resolver" um chamado de suporte copiando a lista do
    // dono para outro papel.
    for (const papel of PAPEIS.filter((p): p is Papel => p !== 'owner')) {
      expect(permissoesPadrao(papel).length, papel).toBeLessThan(PERMISSOES.length);
    }
  });

  it('todo papel consegue pelo menos ver a agenda', () => {
    // Papel que não enxerga nada é conta que não serve para nada — e vira
    // motivo para o dono emprestar a própria senha, que é o que se quer evitar.
    for (const papel of PAPEIS) {
      expect(permissoesPadrao(papel), papel).toContain('appointments.view');
    }
  });
});

describe('permissões de dinheiro', () => {
  it('agrupa o que revela dinheiro e o que o move', () => {
    // O `CLAUDE.md` exige MFA para quem as tem. Uma regra que depende de
    // alguém lembrar de conferir prefixo em cada rota não é uma regra.
    //
    // `cashier.` entrou no bloco 18, com a gaveta: segundo fator para *ver* o
    // faturamento e nenhum para *levar* a sangria seria o inverso do risco.
    expect([...PERMISSOES_DE_DINHEIRO].sort()).toEqual([
      'cashier.close',
      'cashier.open',
      'cashier.withdraw',
      'commission.edit_rules',
      'commission.view_all',
      // `finance.deposit` entrou no bloco 37 e cai aqui pelo prefixo, que é o
      // que se quer: dizer "recebi o sinal" é mover dinheiro que ninguém mais
      // viu entrar.
      'finance.deposit',
      'finance.discount',
      'finance.export',
      // `finance.loyalty_adjust` entrou no bloco 41, e pelo prefixo: criar
      // saldo de fidelidade **é** criar dinheiro — ele vira forma de pagamento
      // no balcão da operação seguinte.
      'finance.loyalty_adjust',
      // `finance.package_refund` entrou no bloco 42, e pelo prefixo: o reembolso
      // proporcional devolve como crédito no razão, gastável no balcão da
      // operação seguinte. Editar o catálogo de pacotes é `settings.manage` e
      // não cai aqui — cadastrar "5 cortes por R$ 250" não move centavo nenhum.
      'finance.package_refund',
      // `finance.subscription_manage` entrou no bloco 45, e pelo prefixo:
      // assinar liga **receita recorrente**, cancelar a desliga. Montar o
      // cadastro do plano é `settings.manage`; dizer que um cliente passa a
      // pagar R$ 149 por mês é mexer em dinheiro.
      'finance.subscription_manage',
      'finance.view',
      'finance.view_profit',
    ]);
  });

  it('nenhuma permissão de dinheiro fica de fora do grupo sem estar declarada', () => {
    // A lista acima é literal e por isso envelhece: uma permissão nova de
    // dinheiro passaria despercebida e nasceria sem segundo fator. Esta é a
    // rede — bate a lista contra o catálogo inteiro, e a **única** ausência
    // aceita é a que está escrita como exceção.
    const foraDoGrupo = PERMISSOES.filter(
      (p) =>
        /^(finance|cashier|commission)\./.test(p) &&
        !PERMISSOES_DE_DINHEIRO.includes(p) &&
        p !== PERMISSAO_DE_DINHEIRO_SEM_SEGUNDO_FATOR,
    );
    expect(foraDoGrupo, `sem segundo fator: ${foraDoGrupo.join(', ')}`).toEqual([]);
  });

  it('o barbeiro chega à própria comissão sem segundo fator', () => {
    // A linha é: segundo fator protege o dinheiro dos outros. Pôr um código de
    // seis dígitos entre o profissional e a primeira tela que ele abre todo dia
    // é como a barbearia acaba procurando como desligar a proteção inteira.
    expect(PERMISSOES_DE_DINHEIRO).not.toContain('commission.view_own');
    expect(PERMISSOES_DE_DINHEIRO).toContain('commission.view_all');
  });
});

describe('a decisão', () => {
  it('concede o que está na lista e recusa o resto', () => {
    const dela = ['appointments.view', 'appointments.create'];
    expect(pode(dela, 'appointments.create')).toBe(true);
    expect(pode(dela, 'appointments.cancel')).toBe(false);
  });

  it('lista vazia não concede nada', () => {
    expect(pode([], 'appointments.view')).toBe(false);
  });

  it('exigir duas significa as duas, não alguma', () => {
    const dela = ['appointments.view'];
    expect(podeTudo(dela, ['appointments.view'])).toBe(true);
    expect(podeTudo(dela, ['appointments.view', 'appointments.cancel'])).toBe(false);
  });

  it('não exigir nada não é passe livre acidental', () => {
    // `podeTudo([], [])` é verdadeiro por vacuidade. Fica registrado para que
    // quem aplicar a guarda saiba que rota sem exigência nenhuma passa — a
    // exigência é obrigatória no decorador, não opcional.
    expect(podeTudo([], [])).toBe(true);
  });
});

describe('o que a sessão de suporte alcança', () => {
  it('lê a operação', () => {
    expect(suportePode(['appointments.view'])).toBe(true);
    expect(suportePode(['appointments.view', 'customers.view'])).toBe(true);
  });

  it('não escreve nada', () => {
    // A regra que faz o suporte ser investigação e não intervenção.
    expect(suportePode(['appointments.cancel'])).toBe(false);
    expect(suportePode(['customers.edit'])).toBe(false);
    expect(suportePode(['settings.manage'])).toBe(false);
    expect(suportePode(['team.manage'])).toBe(false);
  });

  it('não vê o caixa nem a folha', () => {
    // Suporte vê a operação, não o dinheiro. E mesmo que visse, a exigência de
    // segundo fator derivada dessas permissões recusaria — a sessão de suporte
    // nasce sem prova e o suporte não tem o autenticador do dono.
    expect(suportePode(['finance.view'])).toBe(false);
    expect(suportePode(['cashier.open'])).toBe(false);
    expect(suportePode(['commission.view_all'])).toBe(false);
    expect(suportePode(['reports.finance'])).toBe(false);
  });

  it('não exporta a base nem abre foto de cliente', () => {
    // Os dois caminhos pelos quais dado pessoal sai da barbearia.
    expect(suportePode(['customers.export'])).toBe(false);
    expect(suportePode(['customers.view_photos'])).toBe(false);
  });

  it('rota sem permissão declarada é recusada — o suporte não é a conta', () => {
    // `@Exige()` vazio é a fuga da guarda, e existe para o que a conta faz
    // sobre si mesma: trocar a própria senha, sair. `every` sobre lista vazia
    // é verdadeiro, e sem a cláusula explícita o suporte trocaria a senha do
    // dono da barbearia em que entrou.
    expect(suportePode([])).toBe(false);
  });

  it('uma permitida não carrega uma proibida junto', () => {
    // A exigência de `@Exige` é conjuntiva; a autorização aqui também precisa
    // ser. Bastaria um `some` no lugar do `every` para o contrário.
    expect(suportePode(['appointments.view', 'appointments.cancel'])).toBe(false);
  });
});
