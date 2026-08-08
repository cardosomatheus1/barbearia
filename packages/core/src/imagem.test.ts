import { describe, expect, it } from 'vitest';
import { imagemPublica, PROPORCAO } from './imagem.js';

describe('endereço de imagem', () => {
  it('aceita https e devolve normalizado', () => {
    expect(imagemPublica('https://cdn.exemplo.com/fachada.jpg')).toBe(
      'https://cdn.exemplo.com/fachada.jpg',
    );
    expect(imagemPublica('  https://cdn.exemplo.com/a.png  ')).toBe(
      'https://cdn.exemplo.com/a.png',
    );
  });

  it('recusa esquema que não é https', () => {
    // `javascript:` não executa em `src` de `<img>`, mas a mesma coluna vai
    // para `og:image`. Lista fechada custa menos que rastrear consumidor.
    for (const bruto of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'blob:https://exemplo.com/abc',
      'file:///etc/passwd',
      // Bloqueado pelo navegador como conteúdo misto: aceitar seria prometer
      // uma imagem que nunca aparece.
      'http://exemplo.com/a.jpg',
    ]) {
      expect(imagemPublica(bruto), bruto).toBeNull();
    }
  });

  it('recusa o que não é URL', () => {
    for (const bruto of ['', '   ', 'fachada.jpg', '//exemplo.com/a.jpg', 'https://']) {
      expect(imagemPublica(bruto), JSON.stringify(bruto)).toBeNull();
    }
  });

  it('recusa ausência sem reclamar', () => {
    // A foto é opcional; URL ruim não pode impedir de salvar o resto.
    expect(imagemPublica(null)).toBeNull();
    expect(imagemPublica(undefined)).toBeNull();
  });

  it('tem teto de tamanho', () => {
    const gigante = `https://exemplo.com/${'a'.repeat(600)}.jpg`;
    expect(imagemPublica(gigante)).toBeNull();
  });

  it('toda proporção declarada é utilizável como width e height', () => {
    // O par vai para os atributos do `<img>`. Sem eles o navegador não reserva
    // o espaço e a foto empurra o conteúdo ao carregar.
    for (const [papel, medida] of Object.entries(PROPORCAO)) {
      expect(medida.width, papel).toBeGreaterThan(0);
      expect(medida.height, papel).toBeGreaterThan(0);
    }
  });
});

describe('endereço de imagem — limites do formato', () => {
  it('recusa caractere de controle no meio da URL', () => {
    // Quebra de linha numa URL é o que separa um valor de um cabeçalho.
    expect(imagemPublica('https://exemplo.com/a.jpg\nX: 1')).toBeNull();
  });

  it('recusa espaço dentro do endereço', () => {
    expect(imagemPublica('https://exemplo.com/foto do ruan.jpg')).toBeNull();
  });

  it('aceita maiúscula no esquema', () => {
    expect(imagemPublica('HTTPS://exemplo.com/a.jpg')).toBe('HTTPS://exemplo.com/a.jpg');
  });

  it('aceita porta, consulta e âncora', () => {
    for (const bruto of [
      'https://exemplo.com:8443/a.jpg',
      'https://exemplo.com/a.jpg?v=2',
      'https://cdn.exemplo.com/a/b/c.webp?w=800&h=600',
    ]) {
      expect(imagemPublica(bruto), bruto).toBe(bruto);
    }
  });
});
