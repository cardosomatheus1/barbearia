import { describe, expect, it } from 'vitest';
import {
  ESTADOS_DA_NOTA,
  EXPLICACAO_DA_NOTA,
  EXPLICACAO_DO_REGIME,
  FakeFiscalProvider,
  ISS_MAXIMO_BPS,
  ROTULO_DA_NOTA,
  ROTULO_DO_REGIME,
  REGIMES_FISCAIS,
  baseDaNota,
  chaveDaNota,
  cnpjValido,
  motivoParaNaoEmitir,
  normalizarCnpj,
  EXPLICACAO_DE_NAO_ENTREGAR,
  cpfValido,
  decisaoDaEntregaDaNota,
  documentoBonito,
  documentoDoTomadorValido,
  normalizarDocumento,
  notaEmCurso,
  parteDoParceiro,
  vendaAceitaNota,
  validarConfiguracaoFiscal,
  type ConfiguracaoFiscal,
} from './fiscal.js';

/**
 * `FiscalProvider` (bloco 53, SPEC §3.11).
 *
 * O que estes testes prendem é o **contrato** e as decisões que não podem
 * escorregar para o emissor: que produto não entra em NFS-e, que a parte do
 * parceiro sai da comissão, e que a chave que vai para fora carrega a barbearia.
 */

const CONFIG: ConfiguracaoFiscal = {
  cnpj: '11222333000181',
  regime: 'simples',
  codigoDeServico: '14.01',
  issBps: 200,
  municipioIbge: '2927408',
  emitirAutomaticamente: true,
};

describe('o CNPJ é conferido aqui, não só no emissor', () => {
  it('aceita CNPJ válido, com ou sem pontuação', () => {
    /**
     * Conferir aqui não é preciosismo: um CNPJ errado só falha quando a
     * **primeira nota** é rejeitada, dias depois, e o erro que a prefeitura
     * devolve não diz que o problema é do cadastro.
     */
    expect(cnpjValido('11222333000181')).toBe(true);
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
  });

  it('recusa dígito verificador errado', () => {
    expect(cnpjValido('11222333000182')).toBe(false);
  });

  it('recusa tamanho errado e a sequência de zeros', () => {
    /**
     * `00000000000000` é o único repetido que **passa** na conta dos dígitos
     * verificadores, e é o valor que sai de um campo vazio mal tratado. Os
     * outros repetidos (`111…`, `222…`) já caem na própria conta — a primeira
     * versão deste teste usava `111…` e por isso não provava nada sobre a
     * guarda: quebrar a linha não o deixava vermelho.
     */
    expect(cnpjValido('1122233300018')).toBe(false);
    expect(cnpjValido('00000000000000')).toBe(false);
    expect(cnpjValido('')).toBe(false);
  });

  it('normalizar guarda só os dígitos, que é como o emissor recebe', () => {
    expect(normalizarCnpj('11.222.333/0001-81')).toBe('11222333000181');
  });
});

describe('a configuração fiscal', () => {
  it('a completa e correta passa', () => {
    expect(validarConfiguracaoFiscal(CONFIG)).toBeNull();
  });

  it('o ISS tem teto de 5%, que é o da lei complementar', () => {
    /**
     * Um `50` digitado no lugar de `5` passaria pela borda e voltaria como
     * rejeição da prefeitura — e o motivo que ela devolve não diz "você digitou
     * dez vezes a alíquota".
     */
    expect(validarConfiguracaoFiscal({ ...CONFIG, issBps: ISS_MAXIMO_BPS })).toBeNull();
    expect(validarConfiguracaoFiscal({ ...CONFIG, issBps: ISS_MAXIMO_BPS + 1 }))
      .toBe('aliquota_invalida');
    expect(validarConfiguracaoFiscal({ ...CONFIG, issBps: -1 })).toBe('aliquota_invalida');
  });

  it('ISS zero é válido: MEI recolhe por guia, não por alíquota na nota', () => {
    expect(validarConfiguracaoFiscal({ ...CONFIG, issBps: 0, regime: 'mei' })).toBeNull();
  });

  it('o município é o código IBGE, não o nome', () => {
    // É ele que decide a regra municipal. "Salvador" existe em três estados.
    expect(validarConfiguracaoFiscal({ ...CONFIG, municipioIbge: 'Salvador' }))
      .toBe('municipio_obrigatorio');
    expect(validarConfiguracaoFiscal({ ...CONFIG, municipioIbge: '292740' }))
      .toBe('municipio_obrigatorio');
  });

  it('sem código de serviço não há nota', () => {
    expect(validarConfiguracaoFiscal({ ...CONFIG, codigoDeServico: ' ' }))
      .toBe('codigo_de_servico_obrigatorio');
  });
});

describe('só serviço entra na NFS-e', () => {
  it('produto fica de fora', () => {
    /**
     * Produto é NF-e ou NFC-e — outro documento, outra regra, outro emissor.
     * Somar o shampoo na NFS-e recolheria ISS sobre mercadoria, que é imposto
     * errado sobre a base errada.
     */
    const itens = [
      { tipo: 'service', totalCents: 5000 },
      { tipo: 'product', totalCents: 3000 },
      { tipo: 'service', totalCents: 4000 },
      { tipo: 'consumable', totalCents: 500 },
    ];
    expect(baseDaNota(itens)).toBe(9000);
  });

  it('comanda só de produto tem base zero', () => {
    expect(baseDaNota([{ tipo: 'product', totalCents: 3000 }])).toBe(0);
  });
});

describe('a parte do parceiro sai da comissão', () => {
  it('fora do Salão-Parceiro, não existe parte do parceiro', () => {
    for (const regime of ['simples', 'mei'] as const) {
      expect(parteDoParceiro({ regime, comissaoCents: 4000, servicoCents: 10_000 })).toBe(0);
    }
  });

  it('no Salão-Parceiro, é a comissão — a mesma fonte do split', () => {
    /**
     * Não existe alíquota de parceiro em lugar nenhum do schema. Duas fontes de
     * verdade para o mesmo número dariam uma nota fiscal com um valor que não
     * bate com o que o profissional declara.
     */
    expect(
      parteDoParceiro({ regime: 'salao_parceiro', comissaoCents: 4000, servicoCents: 10_000 }),
    ).toBe(4000);
  });

  it('a parte do parceiro nunca passa da base da nota', () => {
    // A parte da casa ficaria negativa, e a prefeitura recusa a nota inteira.
    expect(
      parteDoParceiro({ regime: 'salao_parceiro', comissaoCents: 12_000, servicoCents: 10_000 }),
    ).toBe(10_000);
    expect(
      parteDoParceiro({ regime: 'salao_parceiro', comissaoCents: -500, servicoCents: 10_000 }),
    ).toBe(0);
  });
});

describe('quando a nota não sai, a tela sabe dizer por quê', () => {
  const base = {
    temConfiguracao: true,
    emitirAutomaticamente: true,
    servicoCents: 9000,
    estadoDaVenda: 'paid' as const,
    jaTemNota: false,
  };

  it('venda paga, com serviço e configuração, emite', () => {
    expect(motivoParaNaoEmitir(base)).toBeNull();
  });

  it('cada impedimento tem o próprio motivo', () => {
    /**
     * A resposta é um motivo e não um booleano: a tela precisa dizer por que a
     * comanda de R$ 90 não tem nota, e "não" sozinho manda a recepção adivinhar
     * entre cinco causas diferentes.
     */
    expect(motivoParaNaoEmitir({ ...base, temConfiguracao: false })).toBe('sem_configuracao');
    expect(motivoParaNaoEmitir({ ...base, estadoDaVenda: 'open' })).toBe('venda_nao_paga');
    expect(motivoParaNaoEmitir({ ...base, servicoCents: 0 })).toBe('sem_servico');
    expect(motivoParaNaoEmitir({ ...base, emitirAutomaticamente: false })).toBe('emissao_desligada');
  });

  it('venda estornada não gera nota nova', () => {
    expect(motivoParaNaoEmitir({ ...base, estadoDaVenda: 'refunded' })).toBe('venda_nao_paga');
  });

  it('já ter nota ganha de tudo, inclusive da falta de configuração', () => {
    // Senão a tela diria "cadastre o CNPJ" sobre uma comanda que já tem nota
    // autorizada, que é a informação mais confusa possível.
    expect(motivoParaNaoEmitir({ ...base, jaTemNota: true, temConfiguracao: false }))
      .toBe('ja_tem_nota');
  });
});

describe('o emissor de mentira', () => {
  it('nasce em `processando`, que é o estado real de uma NFS-e enviada', async () => {
    /**
     * Um fake que já nascesse autorizada faria a cadeia de conciliação — a fila
     * perguntando o estado, a tela mudando de "na prefeitura" para "autorizada"
     * — nunca ser exercida pelo caminho que ela percorre na vida real.
     */
    const emissor = new FakeFiscalProvider();
    const nota = await emissor.emitir(pedido('c-1'));
    expect(nota.estado).toBe('processando');
    expect(nota.numero).toBeNull();
    expect(nota.linkPdf).toBeNull();
  });

  it('autorizada traz número e link', async () => {
    const emissor = new FakeFiscalProvider();
    emissor.proximoEstado = 'autorizada';
    const nota = await emissor.emitir(pedido('c-1'));
    expect(nota.numero).not.toBeNull();
    expect(nota.linkPdf).toContain('.pdf');
  });

  it('rejeitada traz o motivo, que é o que a tela mostra', async () => {
    const emissor = new FakeFiscalProvider();
    emissor.proximoEstado = 'rejeitada';
    emissor.proximaRecusa = 'Código de serviço não habilitado para o CNPJ';
    const nota = await emissor.emitir(pedido('c-1'));
    expect(nota.motivoDaRecusa).toContain('não habilitado');
  });

  it('reenviar a mesma nota devolve a mesma resposta', async () => {
    const emissor = new FakeFiscalProvider();
    const primeira = await emissor.emitir(pedido('nf-1'));
    const segunda = await emissor.emitir(pedido('nf-1'));
    expect(segunda.notaId).toBe(primeira.notaId);
    expect(emissor.emitidas).toHaveLength(1);
  });

  it('a nota corrigida depois de uma rejeição é um documento novo', async () => {
    /**
     * Achado da `/security-review` deste bloco. A chave era o id da **comanda**,
     * e uma venda pode ter mais de uma nota de propósito: a rejeitada é
     * justamente a que a barbearia corrige e reenvia. Com a comanda na chave, a
     * segunda submissão chegava como repetição da primeira e o emissor devolvia
     * a nota antiga — a tela mostrava "autorizada" com um número que a
     * prefeitura não tem do documento corrigido.
     */
    const emissor = new FakeFiscalProvider();
    const rejeitada = await emissor.emitir(pedido('nf-1'));
    const corrigida = await emissor.emitir(pedido('nf-2'));
    expect(corrigida.notaId).not.toBe(rejeitada.notaId);
    expect(emissor.emitidas).toHaveLength(2);
    // As duas são da mesma comanda, e é isso que a chave antiga confundia.
    expect(emissor.emitidas.every((p) => p.orderId === 'comanda-1')).toBe(true);
  });

  it('duas barbearias com o mesmo id de nota não colidem', async () => {
    /**
     * Sem o tenant na chave, a segunda receberia a nota da primeira — com o CNPJ
     * errado e o valor errado, que é bem pior que uma cobrança repetida.
     */
    const emissor = new FakeFiscalProvider();
    const nossa = await emissor.emitir(pedido('c-1', 'barbearia-a'));
    const deles = await emissor.emitir(pedido('c-1', 'barbearia-b'));
    expect(deles.notaId).not.toBe(nossa.notaId);
    expect(chaveDaNota({ tenantId: 'barbearia-a', invoiceId: 'nf-1' }))
      .not.toBe(chaveDaNota({ tenantId: 'barbearia-b', invoiceId: 'nf-1' }));
  });
});

describe('o vocabulário da nota', () => {
  it('todo estado tem rótulo e explicação', () => {
    for (const estado of ESTADOS_DA_NOTA) {
      expect(ROTULO_DA_NOTA[estado]).toBeTruthy();
      expect(EXPLICACAO_DA_NOTA[estado]).toBeTruthy();
    }
  });

  it('todo regime tem rótulo e explicação', () => {
    for (const regime of REGIMES_FISCAIS) {
      expect(ROTULO_DO_REGIME[regime]).toBeTruthy();
      expect(EXPLICACAO_DO_REGIME[regime]).toBeTruthy();
    }
  });

  it('só pendente e processando ainda se movem sozinhos', () => {
    expect(notaEmCurso('pendente')).toBe(true);
    expect(notaEmCurso('processando')).toBe(true);
    for (const terminal of ['autorizada', 'rejeitada', 'cancelada'] as const) {
      expect(notaEmCurso(terminal)).toBe(false);
    }
  });

  it('venda sem nota nenhuma aceita a primeira', () => {
    expect(vendaAceitaNota(null)).toBe(true);
  });

  it('a recusa da prefeitura devolve a venda para a fila de emissão', () => {
    expect(vendaAceitaNota('rejeitada')).toBe(true);
    expect(vendaAceitaNota('cancelada')).toBe(true);
  });

  it('cancelamento em voo ainda ocupa a venda', () => {
    // `cancelando` é o estado reivindicado enquanto a prefeitura confirma. Ele
    // faltava nesta lista, e o pedido de nota nessa janela passava pelo domínio
    // para bater no índice parcial — erro de banco no balcão, e exceção dentro
    // de `fecharComanda` no caminho automático.
    expect(vendaAceitaNota('cancelando')).toBe(false);
    expect(vendaAceitaNota('pendente')).toBe(false);
    expect(vendaAceitaNota('processando')).toBe(false);
    expect(vendaAceitaNota('autorizada')).toBe(false);
  });

  it('nenhum estado fica fora das duas leituras', () => {
    // Estado novo sem decisão escrita é o que faz a tela mostrar botão para um
    // caminho que a constraint recusa.
    for (const estado of ESTADOS_DA_NOTA) {
      expect(typeof vendaAceitaNota(estado)).toBe('boolean');
      expect(typeof notaEmCurso(estado)).toBe('boolean');
    }
  });
});

function pedido(invoiceId: string, tenantId = 'barbearia-a') {
  return {
    invoiceId,
    orderId: 'comanda-1',
    tenantId,
    tomador: { nome: 'Carlos Souza', documento: null, email: null },
    itens: [{ descricao: 'Corte', quantidade: 1, valorUnitarioCents: 5000 }],
    servicoCents: 5000,
    parceiroCents: 0,
    issBps: 200,
    codigoDeServico: '14.01',
    municipioIbge: '2927408',
  };
}

describe('o documento do tomador (bloco 54)', () => {
  // CPFs válidos de teste, com dígito verificador que fecha.
  const VALIDO = '52998224725';

  it('CPF com dígito verificador certo passa', () => {
    expect(cpfValido(VALIDO)).toBe(true);
    expect(cpfValido('529.982.247-25')).toBe(true);
  });

  it('CPF com um dígito trocado é recusado', () => {
    expect(cpfValido('52998224726')).toBe(false);
  });

  it('CPF de dígitos repetidos é recusado', () => {
    // Todos passam na conta dos verificadores, e é o que sai de teclado travado
    // ou de quem digita qualquer coisa para o balcão parar de perguntar.
    for (const n of ['00000000000', '11111111111', '99999999999']) {
      expect(cpfValido(n)).toBe(false);
    }
  });

  it('CPF de tamanho errado é recusado', () => {
    expect(cpfValido('5299822472')).toBe(false);
    expect(cpfValido('529982247251')).toBe(false);
  });

  it('o mesmo campo aceita CPF e CNPJ, e é o tamanho que decide', () => {
    expect(documentoDoTomadorValido(VALIDO)).toBe(true);
    expect(documentoDoTomadorValido('11.222.333/0001-81')).toBe(true);
    expect(documentoDoTomadorValido('11222333000182')).toBe(false);
  });

  it('sem documento é resposta legítima — nota ao consumidor', () => {
    expect(documentoDoTomadorValido(null)).toBe(true);
    expect(documentoDoTomadorValido('')).toBe(true);
    expect(documentoDoTomadorValido('   ')).toBe(true);
    expect(normalizarDocumento('  ')).toBeNull();
    expect(normalizarDocumento(undefined)).toBeNull();
  });

  it('documento com quantidade de dígitos que não é nem CPF nem CNPJ é recusado', () => {
    expect(documentoDoTomadorValido('123456789012')).toBe(false);
  });

  it('o que vai ao emissor são só os dígitos', () => {
    expect(normalizarDocumento('529.982.247-25')).toBe(VALIDO);
  });
});

describe('a nota chegando ao cliente (bloco 54)', () => {
  const BASE = {
    estado: 'autorizada' as const,
    linkPdf: 'https://nfse.exemplo/1043.pdf',
    entregueEm: null,
    telefone: '+5571988887777',
    timeZone: 'America/Bahia',
  };
  // 14h em Salvador (UTC-3), bem dentro da janela.
  const TARDE = new Date('2026-11-25T17:00:00Z');

  it('autorizada, com link e com telefone: sai agora', () => {
    const decisao = decisaoDaEntregaDaNota({ ...BASE, agora: TARDE });
    expect(decisao.entregar).toBe(true);
    expect(decisao.quando?.toISOString()).toBe(TARDE.toISOString());
  });

  it('nota já entregue não é entregue de novo', () => {
    const decisao = decisaoDaEntregaDaNota({
      ...BASE,
      entregueEm: new Date('2026-11-20T12:00:00Z'),
      agora: TARDE,
    });
    expect(decisao).toMatchObject({ entregar: false, motivo: 'ja_entregue' });
  });

  it('nota que a prefeitura ainda não autorizou não vira mensagem', () => {
    const decisao = decisaoDaEntregaDaNota({ ...BASE, estado: 'processando', agora: TARDE });
    expect(decisao).toMatchObject({ entregar: false, motivo: 'nao_autorizada' });
  });

  it('autorizada sem documento não manda link vazio', () => {
    // Acontece: o emissor confirma o número antes de o PDF ficar disponível.
    const decisao = decisaoDaEntregaDaNota({ ...BASE, linkPdf: null, agora: TARDE });
    expect(decisao).toMatchObject({ entregar: false, motivo: 'sem_link' });
  });

  it('venda sem cliente com telefone não tem para onde mandar', () => {
    // Comanda avulsa é o caso comum na barbearia, e não é erro: o link fica na
    // tela para a recepção mostrar ou mandar por outro caminho.
    const decisao = decisaoDaEntregaDaNota({ ...BASE, telefone: null, agora: TARDE });
    expect(decisao).toMatchObject({ entregar: false, motivo: 'sem_telefone' });
  });

  it('nota autorizada às 22h47 espera as 8h', () => {
    // 22h47 em Salvador. A nota é transacional e o cliente acabou de sair — a
    // tentação é mandar na hora. O que chega é uma mensagem da barbearia no
    // celular de quem foi dormir, pelo mesmo número que manda o lembrete.
    const noite = new Date('2026-11-26T01:47:00Z');
    const decisao = decisaoDaEntregaDaNota({ ...BASE, agora: noite });
    expect(decisao.entregar).toBe(true);
    // 8h em Salvador é 11h UTC, no dia seguinte ao horário local.
    expect(decisao.quando?.toISOString()).toBe('2026-11-26T11:00:00.000Z');
  });

  it('nota autorizada às 6h espera as 8h do mesmo dia', () => {
    const madrugada = new Date('2026-11-25T09:00:00Z');
    const decisao = decisaoDaEntregaDaNota({ ...BASE, agora: madrugada });
    expect(decisao.quando?.toISOString()).toBe('2026-11-25T11:00:00.000Z');
  });

  it('o fuso é o da unidade, não o do processo', () => {
    // Mesma nota, mesmo instante, duas barbearias: 20h em Salvador ainda é hora
    // de mandar; no Acre são 18h, e também. O que muda é a hora local, e é ela
    // que a regra lê — nunca o relógio de quem roda o worker.
    const instante = new Date('2026-11-25T23:30:00Z');
    const bahia = decisaoDaEntregaDaNota({ ...BASE, agora: instante });
    const acre = decisaoDaEntregaDaNota({ ...BASE, timeZone: 'America/Rio_Branco', agora: instante });
    // 20h30 na Bahia: dentro. 17h30 no Acre: dentro.
    expect(bahia.quando?.toISOString()).toBe(instante.toISOString());
    expect(acre.quando?.toISOString()).toBe(instante.toISOString());

    // Uma hora depois: 21h30 na Bahia empurra, 18h30 no Acre não.
    const maisTarde = new Date('2026-11-26T00:30:00Z');
    expect(decisaoDaEntregaDaNota({ ...BASE, agora: maisTarde }).quando?.toISOString()).toBe(
      '2026-11-26T11:00:00.000Z',
    );
    expect(
      decisaoDaEntregaDaNota({ ...BASE, timeZone: 'America/Rio_Branco', agora: maisTarde })
        .quando?.toISOString(),
    ).toBe(maisTarde.toISOString());
  });

  it('todo motivo de não entregar tem explicação para a tela', () => {
    for (const motivo of ['nao_autorizada', 'sem_link', 'ja_entregue', 'sem_telefone'] as const) {
      expect(EXPLICACAO_DE_NAO_ENTREGAR[motivo]).toBeTruthy();
    }
  });
});

describe('o documento como a pessoa lê', () => {
  it('CPF e CNPJ saem pontuados, que é como o cliente os tem na mão', () => {
    expect(documentoBonito('52998224725')).toBe('529.982.247-25');
    expect(documentoBonito('11222333000181')).toBe('11.222.333/0001-81');
  });

  it('sem documento, campo vazio', () => {
    expect(documentoBonito(null)).toBe('');
  });

  it('tamanho fora do previsto volta como veio', () => {
    // Um formatador que inventa pontuação sobre lixo esconde o lixo.
    expect(documentoBonito('123')).toBe('123');
  });
});
