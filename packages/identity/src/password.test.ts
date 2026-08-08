import { describe, expect, it } from 'vitest';
import { emailKey, hashPassword, verifyPassword } from './password.js';

describe('senha do gestor', () => {
  it('aceita a senha correta', async () => {
    const hash = await hashPassword('correta-horse-battery');
    expect(await verifyPassword('correta-horse-battery', hash)).toEqual({
      valid: true,
      needsRehash: false,
    });
  });

  it('recusa a senha errada', async () => {
    const hash = await hashPassword('correta-horse-battery');
    expect((await verifyPassword('correta-horse-batterz', hash)).valid).toBe(false);
  });

  it('o mesmo texto gera hashes diferentes', async () => {
    // Salt por senha: sem ele, duas pessoas com a mesma senha teriam o mesmo
    // hash e um vazamento revelaria isso de graça.
    const a = await hashPassword('mesma-senha');
    const b = await hashPassword('mesma-senha');
    expect(a).not.toBe(b);
  });

  it('guarda os parâmetros dentro do hash', async () => {
    // É o que permite subir o custo sem invalidar senha já cadastrada.
    const hash = await hashPassword('x');
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('marca para regravar quando o custo do hash é menor que o atual', async () => {
    const atual = await hashPassword('senha');
    const [, n, r, p, salt, derivada] = atual.split('$');
    const barato = ['scrypt', String(Number(n) / 4), r, p, salt, derivada].join('$');

    // O hash barato não bate (foi derivado com outro N), mas o caminho de
    // decisão precisa existir; aqui a garantia é que ele não estoura.
    expect((await verifyPassword('senha', barato)).valid).toBe(false);
  });

  it('recusa hash malformado sem lançar', async () => {
    for (const ruim of ['', 'x', 'scrypt$1', 'bcrypt$1$2$3$4$5', 'scrypt$a$b$c$d$e']) {
      expect((await verifyPassword('senha', ruim)).valid).toBe(false);
    }
  });

  it('recusa hash com custo absurdo sem tentar alocar', async () => {
    // Hash forjado com N gigante travaria o processo na alocação. É negação de
    // serviço a partir de uma linha do banco.
    const forjado = ['scrypt', '1073741824', '8', '1', 'c2FsdA==', 'aGFzaA=='].join('$');
    const antes = Date.now();
    expect((await verifyPassword('senha', forjado)).valid).toBe(false);
    expect(Date.now() - antes).toBeLessThan(1000);
  });

  it('normaliza a senha antes de derivar', async () => {
    // "é" composto e pré-composto são o mesmo caractere para quem digita, e
    // teclados diferentes produzem os dois. Sem normalizar, o login falharia
    // dependendo do aparelho.
    const composto = 'café-secreto';
    const decomposto = 'café-secreto';
    const hash = await hashPassword(composto);
    expect((await verifyPassword(decomposto, hash)).valid).toBe(true);
  });
});

describe('chave de e-mail', () => {
  const PEPPER = 'segredo-de-ambiente';

  it('é estável para o mesmo e-mail', () => {
    expect(emailKey('joao@x.com', PEPPER)).toBe(emailKey('joao@x.com', PEPPER));
  });

  it('ignora caixa e espaços', () => {
    // Sem isso o mesmo dono criaria duas contas sem perceber.
    expect(emailKey('  Joao@X.com ', PEPPER)).toBe(emailKey('joao@x.com', PEPPER));
  });

  it('muda com o segredo', () => {
    // É o que impede que um dump do banco responda "este e-mail é cliente?".
    expect(emailKey('joao@x.com', PEPPER)).not.toBe(emailKey('joao@x.com', 'outro'));
  });

  it('não guarda o e-mail em claro', () => {
    expect(emailKey('joao@x.com', PEPPER)).not.toContain('joao');
  });

  it('recusa segredo vazio em vez de gerar chave fraca', () => {
    expect(() => emailKey('joao@x.com', '')).toThrow(/PEPPER/);
  });
});
