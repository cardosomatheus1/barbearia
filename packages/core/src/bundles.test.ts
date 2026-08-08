import { describe, expect, it } from 'vitest';
import { applyBundle, suggestBundle, type SellableBundle } from './bundles.js';

const PRECOS: Record<string, number> = {
  cabelo: 4900,
  barba: 3500,
  sobrancelha: 1800,
  hidratacao: 5500,
};
const preco = (id: string): number | undefined => PRECOS[id];

const COMBO: SellableBundle = {
  serviceId: 'cabelo+barba',
  name: 'Cabelo + Barba',
  priceCents: 7400,
  componentIds: ['cabelo', 'barba'],
};

describe('sugestão de combo', () => {
  it('sugere quando a soma avulsa é maior', () => {
    // O caso real da Domari: R$ 84,00 avulso contra R$ 74,00 no combo.
    expect(suggestBundle(['cabelo', 'barba'], preco, [COMBO])).toEqual({
      serviceId: 'cabelo+barba',
      name: 'Cabelo + Barba',
      priceCents: 7400,
      savesCents: 1000,
      replacesIds: ['cabelo', 'barba'],
    });
  });

  it('sugere também quando há outros serviços no carrinho', () => {
    // Quem marcou cabelo, barba e sobrancelha economiza igual. Exigir igualdade
    // esconderia o desconto justamente de quem gasta mais.
    const sugestao = suggestBundle(['cabelo', 'barba', 'sobrancelha'], preco, [COMBO]);
    expect(sugestao?.savesCents).toBe(1000);
  });

  it('não sugere quando falta um componente', () => {
    expect(suggestBundle(['cabelo', 'sobrancelha'], preco, [COMBO])).toBeNull();
  });

  it('não sugere combo que não economiza', () => {
    const caro: SellableBundle = { ...COMBO, priceCents: 8400 };
    expect(suggestBundle(['cabelo', 'barba'], preco, [caro])).toBeNull();
  });

  it('não sugere o que já está no carrinho', () => {
    expect(suggestBundle(['cabelo+barba'], preco, [COMBO])).toBeNull();
  });

  it('escolhe a troca de maior economia quando há mais de uma', () => {
    // Duas ou três sugestões viram balcão de ofertas e o cliente pára de decidir.
    const maior: SellableBundle = {
      serviceId: 'completo',
      name: 'Dia completo',
      priceCents: 9000,
      componentIds: ['cabelo', 'barba', 'sobrancelha'],
    };
    const sugestao = suggestBundle(['cabelo', 'barba', 'sobrancelha'], preco, [COMBO, maior]);
    expect(sugestao?.serviceId).toBe('completo');
    expect(sugestao?.savesCents).toBe(10200 - 9000);
  });

  it('ignora combo com componente sem preço conhecido', () => {
    // Serviço fora do cardápio visível: sem a soma não dá para afirmar economia.
    const comOculto: SellableBundle = { ...COMBO, componentIds: ['cabelo', 'oculto'] };
    expect(suggestBundle(['cabelo', 'oculto'], preco, [comOculto])).toBeNull();
  });

  it('ignora "combo" de um item só', () => {
    const solto: SellableBundle = { ...COMBO, componentIds: ['cabelo'] };
    expect(suggestBundle(['cabelo'], preco, [solto])).toBeNull();
  });

  it('ignora combo sem componente nenhum', () => {
    // Conjunto vazio satisfaz `every` e casaria com qualquer carrinho.
    const vazio: SellableBundle = { ...COMBO, componentIds: [] };
    expect(suggestBundle(['cabelo'], preco, [vazio])).toBeNull();
  });
});

describe('aplicar a troca', () => {
  it('troca os componentes pelo combo', () => {
    const sugestao = suggestBundle(['cabelo', 'barba'], preco, [COMBO]);
    expect(sugestao).not.toBeNull();
    expect(applyBundle(['cabelo', 'barba'], sugestao!)).toEqual(['cabelo+barba']);
  });

  it('preserva o que não faz parte do combo, na posição do primeiro componente', () => {
    const sugestao = suggestBundle(['sobrancelha', 'cabelo', 'barba'], preco, [COMBO]);
    expect(applyBundle(['sobrancelha', 'cabelo', 'barba'], sugestao!)).toEqual([
      'sobrancelha',
      'cabelo+barba',
    ]);
  });
});
