import { describe, expect, it } from 'vitest';
import { ConflitoDoPreviewNaoEncontrado, resolverConflitoGuardado } from './resolucao-de-conflito.js';

const preview = () => ({
  linhas: [
    {
      nome: 'José',
      telefone: '+5571988887777',
      nascimento: '1985-09-07',
      observacao: 'primeira',
      novo: true,
    },
  ],
  problemas: [
    {
      linha: 3,
      veredito: 'conflito' as const,
      nome: 'João',
      telefone: '+5571988887777',
      nascimento: '1990-03-12',
      observacao: 'segunda',
      conflitaCom: 'José',
    },
  ],
});

describe('resolver conflito de importação', () => {
  it('troca a linha inteira quando a segunda pessoa é escolhida', () => {
    const resolvido = resolverConflitoGuardado(preview(), 3, 'linha');
    expect(resolvido.linhas[0]).toMatchObject({
      nome: 'João',
      nascimento: '1990-03-12',
      observacao: 'segunda',
      novo: true,
    });
    expect(resolvido.problemas).toEqual([]);
  });

  it('mantém a primeira linha quando ela é escolhida', () => {
    const resolvido = resolverConflitoGuardado(preview(), 3, 'anterior');
    expect(resolvido.linhas[0]?.nome).toBe('José');
    expect(resolvido.problemas).toEqual([]);
  });

  it('o terceiro conflito compara contra a escolha que virou canônica', () => {
    const base = preview();
    const comTerceiro = {
      ...base,
      problemas: [
        ...base.problemas,
        {
          linha: 4,
          veredito: 'conflito' as const,
          nome: 'Joaquim',
          telefone: '+5571988887777',
          nascimento: null,
          observacao: 'terceira',
          conflitaCom: 'José',
        },
      ],
    };

    const resolvido = resolverConflitoGuardado(comTerceiro, 3, 'linha');
    const restante = resolvido.problemas[0];
    expect(restante?.veredito).toBe('conflito');
    if (restante?.veredito === 'conflito') expect(restante.conflitaCom).toBe('João');
  });

  it('recusa linha inexistente em vez de escolher por aproximação', () => {
    expect(() => resolverConflitoGuardado(preview(), 99, 'linha')).toThrow(
      ConflitoDoPreviewNaoEncontrado,
    );
  });
});
