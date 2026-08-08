import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRASE_DO_EVENTO, diferencaDoEvento } from './trilha.js';

/**
 * O vocabulário de `AuditAction` é o contrato entre quem grava e quem lê.
 *
 * `apps/web` não depende de `@barbearia/identity` — e não deve: a trilha chega
 * pela API, como JSON, com `action` sendo `string`. Sem esta leitura do arquivo
 * de origem, um verbo novo auditado num bloco futuro apareceria como código cru
 * na tela do dono, e ninguém saberia até alguém abrir a tela.
 */
const AUDIT_TS = fileURLToPath(new URL('../../../../packages/identity/src/audit.ts', import.meta.url));

function acoesDeclaradas(): readonly string[] {
  // Os comentários saem antes de procurar o fim do union. O que motiva isto é
  // concreto: um `;` no meio de uma frase em português ("...por nome; o resto
  // entrou junto...") encerrava a captura no primeiro terço da lista, e o teste
  // dava verde sobre metade do vocabulário.
  const fonte = readFileSync(AUDIT_TS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const bloco = /export type AuditAction =([\s\S]*?);/.exec(fonte);
  if (!bloco?.[1]) throw new Error('não achei o tipo AuditAction em audit.ts');

  return [...bloco[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1] as string);
}

describe('vocabulário da trilha', () => {
  it('lê o tipo de origem e encontra ações de verdade', () => {
    const acoes = acoesDeclaradas();
    expect(acoes.length).toBeGreaterThan(10);
    expect(acoes).toContain('staff.role_changed');
  });

  it('toda ação auditável tem frase em português', () => {
    const semFrase = acoesDeclaradas().filter((acao) => !FRASE_DO_EVENTO[acao]);
    expect(semFrase).toEqual([]);
  });

  it('não traduz ação que ninguém grava', () => {
    const acoes = new Set(acoesDeclaradas());
    const inventadas = Object.keys(FRASE_DO_EVENTO).filter((acao) => !acoes.has(acao));
    expect(inventadas).toEqual([]);
  });
});

describe('diferença entre o antes e o depois', () => {
  it('mostra só o campo que mudou', () => {
    expect(diferencaDoEvento({ role: 'receptionist', name: 'Bruno' }, { role: 'manager', name: 'Bruno' })).toEqual([
      'role: receptionist → manager',
    ]);
  });

  it('campo que não existia antes aparece sem seta', () => {
    expect(diferencaDoEvento({}, { role: 'manager' })).toEqual(['role: manager']);
  });

  it('evento sem depois não produz linha', () => {
    expect(diferencaDoEvento({ role: 'manager' }, null)).toEqual([]);
  });

  it('nada mudou, nada a mostrar', () => {
    expect(diferencaDoEvento({ role: 'manager' }, { role: 'manager' })).toEqual([]);
  });
});
