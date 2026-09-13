import { describe, expect, it } from 'vitest';
import { PERMISSOES } from '@barbearia/core';

import { destinosDaBusca, modulosVisiveis } from '../app/admin/secoes';

import { filtrarDestinos, normalizarBusca } from './busca-global';

const destinos = [
  { href: '/admin/comissao', nome: 'Comissões', modulo: 'Financeiro', nota: 'o que a casa precisa pagar' },
  { href: '/admin/clientes', nome: 'Clientes', modulo: 'Clientes', nota: 'buscar, reconhecer e agir sobre a base' },
  { href: '/admin/whatsapp', nome: 'WhatsApp', modulo: 'Crescimento', nota: 'o número por onde tudo sai' },
] as const;

describe('busca global', () => {
  it('ignora acento e caixa na busca por função', () => {
    expect(filtrarDestinos(destinos, 'COMISSAO').map((d) => d.href)).toEqual(['/admin/comissao']);
  });

  it('procura também módulo e explicação, não só o título', () => {
    expect(filtrarDestinos(destinos, 'crescimento').map((d) => d.href)).toEqual(['/admin/whatsapp']);
    expect(filtrarDestinos(destinos, 'reconhecer').map((d) => d.href)).toEqual(['/admin/clientes']);
  });

  it('mantém normalização estável para nomes em português', () => {
    expect(normalizarBusca('  João ÇÁ  ')).toBe('joao ca');
  });
});

/**
 * O vocabulário do balcão: as palavras que a pessoa digita de verdade.
 *
 * Este teste roda contra o **registro real**, não contra a amostra acima, e a
 * razão é o defeito que ele nasceu vigiando. `destinosDaBusca` era um `flatMap`
 * sobre `modulo.telas` escrito dentro do casco, e por isso as quatro telas
 * **internas** nunca entraram na busca — inclusive a Ficha do cliente, que é a
 * tela mais rica do produto e a única sem porta no menu.
 *
 * O sintoma não era "não acha": era **achar a coisa errada com cara de certa**.
 * Medido antes do conserto, sobre as doze palavras abaixo:
 *
 *   8 não devolviam nada     maquina, degrade, barba, alergia, observacao,
 *                            material, shampoo, pomada
 *   4 devolviam a tela errada
 *       "foto"      -> Fotos e marca (o logo da página pública)
 *       "ficha"     -> Estoque (a ficha de consumo)
 *       "historico" -> Auditoria (a trilha do sistema)
 *       "preferencia" -> Preferências (horário de funcionamento)
 *
 * O dono procurou "foto", abriu "Fotos e marca", viu upload de logo e concluiu
 * que o produto não guardava foto de corte. Ele guardava, desde o bloco 74.
 *
 * A lista é escrita à mão de propósito, e é a exceção que se justifica: não
 * existe fonte da qual derivar "o que uma barbearia chama as coisas". O que a
 * mantém honesta é ela cobrar o **primeiro** resultado — uma tela nova que
 * roube "foto" da ficha fica vermelha aqui.
 */
const VOCABULARIO_DO_BALCAO: readonly (readonly [string, string])[] = [
  ['foto', 'Ficha do cliente'],
  ['preferencia', 'Ficha do cliente'],
  ['maquina', 'Ficha do cliente'],
  ['degrade', 'Ficha do cliente'],
  ['alergia', 'Ficha do cliente'],
  ['observacao', 'Ficha do cliente'],
  ['historico', 'Ficha do cliente'],
  ['material', 'Estoque'],
  ['shampoo', 'Estoque'],
  ['pomada', 'Estoque'],
  ['insumo', 'Estoque'],
  ['ficha tecnica', 'Serviços'],
];

describe('a busca responde ao vocabulário do balcão', () => {
  const destinosReais = destinosDaBusca(modulosVisiveis([], PERMISSOES));

  it('a varredura enxerga o registro inteiro, telas internas incluídas', () => {
    // Sem isto, um `destinosDaBusca` que voltasse a ignorar `dentro` deixaria o
    // teste abaixo procurando num universo que não contém a resposta — e a
    // falha leria como "a palavra sumiu", não como "a tela sumiu".
    expect(destinosReais.some((d) => d.nome === 'Ficha do cliente')).toBe(true);
    expect(destinosReais.length).toBeGreaterThan(40);
  });

  it('cada palavra do balcão leva à tela certa, e ela vem primeiro', () => {
    const erros = VOCABULARIO_DO_BALCAO.flatMap(([palavra, esperada]) => {
      const achados = filtrarDestinos(destinosReais, palavra);
      const primeiro = achados[0]?.nome;
      if (primeiro === esperada) return [];
      return [`"${palavra}" -> ${primeiro ?? 'nada'} (esperado: ${esperada})`];
    });

    expect(erros, 'a busca manda o balcão para a tela errada').toEqual([]);
  });
});
