import { describe, expect, it } from 'vitest';
import { cabeVoltaFiscal } from './fiscal.js';

describe('a volta fiscal do laço', () => {
  it('não enfileira nada quando a instalação não emite nota', () => {
    /**
     * O defeito que ela fecha: `FISCAL_MODO` nasce `nenhum`, e o laço
     * enfileirava `fiscal.entregar` e `fiscal.conciliar` para toda barbearia a
     * cada hora. A segunda chamava `exigirEmissorFiscal()`, que lança — três
     * `tarefa.falhou` por hora, nas duas barbearias, desde sempre.
     *
     * A hora nova não muda nada: sem emissor, nenhuma hora cabe.
     */
    expect(cabeVoltaFiscal({ emiteNotaFiscal: false, hora: '2026-08-27T00', ultima: null })).toBe(false);
    expect(
      cabeVoltaFiscal({ emiteNotaFiscal: false, hora: '2026-08-27T01', ultima: '2026-08-27T00' }),
    ).toBe(false);
  });

  it('com emissor, enfileira uma vez por hora e não mais', () => {
    // Duas voltas do laço dentro do mesmo minuto não podem enfileirar duas.
    expect(cabeVoltaFiscal({ emiteNotaFiscal: true, hora: '2026-08-27T00', ultima: null })).toBe(true);
    expect(
      cabeVoltaFiscal({ emiteNotaFiscal: true, hora: '2026-08-27T00', ultima: '2026-08-27T00' }),
    ).toBe(false);
    expect(
      cabeVoltaFiscal({ emiteNotaFiscal: true, hora: '2026-08-27T01', ultima: '2026-08-27T00' }),
    ).toBe(true);
  });
});
