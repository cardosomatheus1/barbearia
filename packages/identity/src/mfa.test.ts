import { beforeAll, describe, expect, it } from 'vitest';
import {
  acharCodigoDeRecuperacao,
  cifrarSegredo,
  codigoDoPasso,
  conferirCodigo,
  deBase32,
  decifrarSegredo,
  gerarCodigosDeRecuperacao,
  hashDosCodigos,
  normalizarCodigo,
  novoSegredo,
  paraBase32,
  passoAgora,
  uriDoAutenticador,
} from './mfa.js';

/**
 * O segundo fator, sem banco.
 *
 * O relógio entra por parâmetro, como no resto do domínio: um teste de TOTP que
 * chama `Date.now()` passa a falhar às 23:59:59 e ninguém entende por quê.
 */

// Vetor de teste da RFC 6238, Apêndice B: segredo ASCII "12345678901234567890".
const SEGREDO_RFC = paraBase32(Buffer.from('12345678901234567890', 'ascii'));

describe('TOTP', () => {
  it('bate com os vetores de teste da RFC 6238', () => {
    // Se este teste falhar, o aplicativo autenticador do dono não abre a porta —
    // e a barbearia perde o caixa. Vetor publicado, não valor que eu inventei.
    expect(codigoDoPasso(SEGREDO_RFC, Math.floor(59 / 30))).toBe('287082');
    expect(codigoDoPasso(SEGREDO_RFC, Math.floor(1111111109 / 30))).toBe('081804');
    expect(codigoDoPasso(SEGREDO_RFC, Math.floor(1234567890 / 30))).toBe('005924');
    expect(codigoDoPasso(SEGREDO_RFC, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('base32 ida e volta não perde byte', () => {
    for (const tamanho of [1, 5, 10, 20, 32]) {
      const bytes = Buffer.from(Array.from({ length: tamanho }, (_, i) => (i * 37) % 256));
      expect(deBase32(paraBase32(bytes))).toEqual(bytes);
    }
  });

  it('o código certo abre', () => {
    const agora = new Date('2026-08-08T12:00:00Z');
    const codigo = codigoDoPasso(SEGREDO_RFC, passoAgora(agora));

    expect(conferirCodigo({ segredoBase32: SEGREDO_RFC, codigo, now: agora }).valido).toBe(true);
  });

  it('aceita um passo de atraso — relógio de celular derrapa', () => {
    const agora = new Date('2026-08-08T12:00:00Z');
    const anterior = codigoDoPasso(SEGREDO_RFC, passoAgora(agora) - 1);

    expect(
      conferirCodigo({ segredoBase32: SEGREDO_RFC, codigo: anterior, now: agora }).valido,
    ).toBe(true);
  });

  it('não aceita código de dois minutos atrás', () => {
    const agora = new Date('2026-08-08T12:00:00Z');
    const velho = codigoDoPasso(SEGREDO_RFC, passoAgora(agora) - 4);

    expect(conferirCodigo({ segredoBase32: SEGREDO_RFC, codigo: velho, now: agora }).valido)
      .toBe(false);
  });

  it('código já usado não vale de novo na mesma janela', () => {
    // Trinta segundos é tempo de sobra para quem olhou por cima do ombro no
    // balcão. Sem o passo consumido, o mesmo código serve duas vezes.
    const agora = new Date('2026-08-08T12:00:00Z');
    const passo = passoAgora(agora);
    const codigo = codigoDoPasso(SEGREDO_RFC, passo);

    const primeira = conferirCodigo({ segredoBase32: SEGREDO_RFC, codigo, now: agora });
    expect(primeira).toEqual({ valido: true, passo });

    const segunda = conferirCodigo({
      segredoBase32: SEGREDO_RFC,
      codigo,
      now: agora,
      ultimoPasso: primeira.passo,
    });
    expect(segunda.valido).toBe(false);
  });

  it('recusa código com tamanho errado sem nem calcular', () => {
    const agora = new Date('2026-08-08T12:00:00Z');
    for (const codigo of ['', '12345', '1234567', 'abcdef']) {
      expect(conferirCodigo({ segredoBase32: SEGREDO_RFC, codigo, now: agora }).valido).toBe(false);
    }
  });

  it('ignora espaço e traço que o usuário digita', () => {
    const agora = new Date('2026-08-08T12:00:00Z');
    const codigo = codigoDoPasso(SEGREDO_RFC, passoAgora(agora));
    const digitado = `${codigo.slice(0, 3)} ${codigo.slice(3)}`;

    expect(conferirCodigo({ segredoBase32: SEGREDO_RFC, codigo: digitado, now: agora }).valido)
      .toBe(true);
  });

  it('segredo novo tem entropia e formato de autenticador', () => {
    const a = novoSegredo();
    const b = novoSegredo();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('o endereço do QR leva o nome da barbearia', () => {
    const uri = uriDoAutenticador({
      segredoBase32: SEGREDO_RFC,
      email: 'dono@domari.com.br',
      barbearia: 'Domari Barber Club',
    });

    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('issuer=Domari%20Barber%20Club');
    expect(uri).toContain(`secret=${SEGREDO_RFC}`);
  });
});

describe('segredo guardado', () => {
  beforeAll(() => {
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 7).toString('base64');
  });

  it('ida e volta devolve o mesmo segredo', () => {
    const segredo = novoSegredo();
    expect(decifrarSegredo(cifrarSegredo(segredo))).toBe(segredo);
  });

  it('o que vai para o banco não contém o segredo em claro', () => {
    // Segredo TOTP em claro no dump entrega o segundo fator junto com o
    // primeiro — e aí ele não é segundo fator, é enfeite.
    const segredo = novoSegredo();
    expect(cifrarSegredo(segredo)).not.toContain(segredo);
  });

  it('duas cifragens do mesmo segredo são diferentes', () => {
    const segredo = novoSegredo();
    expect(cifrarSegredo(segredo)).not.toBe(cifrarSegredo(segredo));
  });

  it('texto adulterado não decifra', () => {
    const cifrado = cifrarSegredo(novoSegredo());
    const [nonce, tag, dados] = cifrado.split('.');
    const adulterado = [nonce, tag, Buffer.from('outro').toString('base64')].join('.');
    expect(() => decifrarSegredo(adulterado)).toThrow();
  });

  it('sem a chave de ambiente, falha alto em vez de cair num padrão fraco', () => {
    const guardada = process.env['MFA_SECRET_KEY'];
    delete process.env['MFA_SECRET_KEY'];
    try {
      expect(() => cifrarSegredo('X')).toThrowError(/MFA_SECRET_KEY/);
    } finally {
      process.env['MFA_SECRET_KEY'] = guardada;
    }
  });

  it('chave de tamanho errado é recusada', () => {
    const guardada = process.env['MFA_SECRET_KEY'];
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(16, 1).toString('base64');
    try {
      expect(() => cifrarSegredo('X')).toThrowError(/32 bytes/);
    } finally {
      process.env['MFA_SECRET_KEY'] = guardada;
    }
  });
});

describe('códigos de recuperação', () => {
  it('gera oito códigos distintos, sem caractere ambíguo', () => {
    const codigos = gerarCodigosDeRecuperacao();
    expect(codigos).toHaveLength(8);
    expect(new Set(codigos).size).toBe(8);
    // 0/O e 1/l confundem quem anota no papel — e é no papel que eles moram.
    expect(codigos.join('')).not.toMatch(/[O0Il1]/);
  });

  it('acha o código certo e diz qual foi, para poder queimá-lo', async () => {
    const codigos = gerarCodigosDeRecuperacao();
    const hashes = await hashDosCodigos(codigos);

    const alvo = codigos[3];
    expect(alvo).toBeDefined();
    if (!alvo) return;

    expect(await acharCodigoDeRecuperacao(alvo, hashes)).toBe(3);
  });

  it('aceita o código digitado sem o traço e em minúscula', async () => {
    const codigos = gerarCodigosDeRecuperacao();
    const hashes = await hashDosCodigos(codigos);
    const alvo = codigos[0];
    if (!alvo) return;

    expect(await acharCodigoDeRecuperacao(alvo.replace('-', '').toLowerCase(), hashes)).toBe(0);
  });

  it('código inventado não acha nada', async () => {
    const hashes = await hashDosCodigos(gerarCodigosDeRecuperacao());
    expect(await acharCodigoDeRecuperacao('ABCDE-FGHJK', hashes)).toBeNull();
  });

  it('normaliza tirando tudo que não é letra ou dígito', () => {
    expect(normalizarCodigo(' ab-cde fgh ')).toBe('ABCDEFGH');
  });
});
