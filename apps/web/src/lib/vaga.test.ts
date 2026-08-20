import { describe, expect, it } from 'vitest';
import type { QuemEspera } from './admin-api';
import { daEspera, lerVaga, NOMES_QUE_ATRAVESSAM } from './vaga';

/**
 * Quem queria a vaga, do domínio até a tela (bloco 110).
 *
 * O que se prova aqui é o que atravessa um cookie de dois minutos: nem tudo, e
 * nunca o cadastro inteiro. O caminho estava mudo — a ação de servidor só
 * conseguia levar a contagem — e agora leva nome, os quatro últimos dígitos e a
 * janela pedida.
 */
function esperando(quantos: number): QuemEspera[] {
  return Array.from({ length: quantos }, (_, i) => ({
    id: `id-${i}`,
    customerId: `cliente-${i}`,
    customerNome: `Cliente ${i}`,
    customerTelefoneFinal: '4321',
    de: '2026-08-20',
    ate: '2026-08-27',
    inicio: '09:00',
    fim: '12:00',
    servicos: ['Corte'],
    profissionalNome: null,
    entrouEm: '2026-08-19T12:00:00.000Z',
    convite: null,
  }));
}

describe('o que atravessa o cookie', () => {
  it('leva nome, os quatro últimos e a janela — e nada do cadastro', () => {
    const [quem] = daEspera(esperando(1)).nomes;
    expect(quem).toEqual({ id: 'id-0', nome: 'Cliente 0', fim4: '4321', de: '09:00', ate: '12:00' });
    // O id do cliente abre a ficha inteira; ele não tem o que fazer no
    // navegador do balcão, e a lista de espera é quem leva para lá.
    expect(JSON.stringify(quem)).not.toContain('cliente-0');
  });

  it('sem permissão de ver cliente, leva a contagem e nenhum nome', () => {
    // O domínio já devolve a linha com o nome em branco (bloco 38): a lista
    // vazia seria mentira, e a lista inteira entregaria a base a quem a
    // barbearia decidiu não dar.
    const cegos = esperando(3).map((quem) => ({
      ...quem,
      customerNome: '',
      customerTelefoneFinal: null,
    }));
    const vaga = daEspera(cegos);
    expect(vaga.nomes).toHaveLength(0);
    expect(vaga.total).toBe(3);
    expect(lerVaga(JSON.stringify(vaga))).toEqual({ nomes: [], total: 3 });
  });

  it('corta no teto e guarda o total, porque a frase conta todo mundo', () => {
    const vaga = daEspera(esperando(9));
    expect(vaga.nomes).toHaveLength(NOMES_QUE_ATRAVESSAM);
    expect(vaga.total).toBe(9);
  });

  it('cabe num cookie mesmo com a lista cheia', () => {
    const grande = esperando(40).map((quem, i) => ({
      ...quem,
      customerNome: `Maria Aparecida da Conceição Nascimento ${i}`,
    }));
    expect(JSON.stringify(daEspera(grande)).length).toBeLessThan(4096);
  });
});

describe('o cookie que chega', () => {
  it('vira aviso quando está inteiro', () => {
    const lido = lerVaga(JSON.stringify(daEspera(esperando(2))));
    expect(lido?.nomes).toHaveLength(2);
    expect(lido?.total).toBe(2);
  });

  it('some quando não dá para ler, em vez de derrubar a tela', () => {
    expect(lerVaga(undefined)).toBeNull();
    expect(lerVaga('')).toBeNull();
    expect(lerVaga('{')).toBeNull();
    expect(lerVaga('"texto"')).toBeNull();
    expect(lerVaga('null')).toBeNull();
    // Contagem zero não é aviso: sem ninguém esperando, não há o que dizer.
    expect(lerVaga(JSON.stringify({ nomes: [], total: 0 }))).toBeNull();
    // O formato da versão anterior desta tela, que sobrevive a um deploy.
    expect(lerVaga(JSON.stringify([{ id: 'a', customerNome: 'Ana' }]))).toBeNull();
    expect(lerVaga(JSON.stringify({ nomes: [{ id: 'a' }], total: 1 }))).toBeNull();
  });

  it('nunca conta menos gente do que a quantidade de nomes que mostra', () => {
    const lido = lerVaga(
      JSON.stringify({ nomes: daEspera(esperando(3)).nomes, total: 1 }),
    );
    expect(lido?.total).toBe(3);
  });
});
