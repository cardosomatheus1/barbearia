import { describe, expect, it } from 'vitest';
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
