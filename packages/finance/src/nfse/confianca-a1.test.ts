import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confiancaA1Sintetica } from '../../test/nfse-confianca-fixture.js';
import { certificadoNfseSintetico } from '../../test/nfse-fixtures.js';
import { validarConfiancaA1 } from './confianca-a1.js';

const agora = new Date('2026-09-10T12:00:00Z');
let pki: ReturnType<typeof confiancaA1Sintetica>;
const validar = () => validarConfiancaA1(pki.certificado, agora);
describe('confiança independente no A1 e revogação em toda a cadeia', () => {
  beforeAll(() => { pki = confiancaA1Sintetica(); });
  afterAll(() => pki?.limpar());
  beforeEach(() => { vi.stubEnv('FISCAL_CONFIANCA_DIR', pki.pasta); writeFileSync(join(pki.pasta, 'raizes.pem'), pki.raizPem); pki.atualizarCrls(); });
  afterEach(() => vi.unstubAllEnvs());
  it('aceita cadeia assinada pela raiz configurada e CRLs válidas', async () => { await expect(validar()).resolves.toBeUndefined(); });
  it('não transforma certificado autoassinado do PFX em raiz confiável', async () => {
    await expect(validarConfiancaA1(certificadoNfseSintetico().certificado, agora)).rejects.toMatchObject({ code: 'nfse_certificado_sem_confianca' });
  });
  it.each([{ revogarFolha: true }, { revogarIntermediaria: true }, { vencida: true }, { futura: true }, { semRaiz: true }])
    ('recusa revogação ou indisponibilidade: %j', async opcoes => {
      pki.atualizarCrls(opcoes); await expect(validar()).rejects.toMatchObject({ code: 'nfse_certificado_sem_confianca' });
    });
  it('revalida após renovação de CRLs e remoção da raiz, sem cache de aceitação', async () => {
    await validar(); pki.atualizarCrls({ revogarFolha: true }); await expect(validar()).rejects.toThrow();
    pki.atualizarCrls(); await validar(); writeFileSync(join(pki.pasta, 'raizes.pem'), '');
    await expect(validar()).rejects.toMatchObject({ code: 'nfse_confianca_indisponivel' });
  });
  it('recusa CRL adulterada apesar de estar dentro da validade', async () => {
    const path = join(pki.pasta, 'crls.pem'); const texto = readFileSync(path, 'utf8');
    writeFileSync(path, texto.replace(/([A-Za-z0-9+/])=*(\r?\n-----END X509 CRL-----)/, (_t, c: string, fim: string) => `${c === 'A' ? 'B' : 'A'}${fim}`));
    await expect(validar()).rejects.toThrow();
  });
  it('não aceita chave privada nem folha no catálogo de raízes', async () => {
    writeFileSync(join(pki.pasta, 'raizes.pem'), pki.raizPem + pki.certificado.chavePem);
    await expect(validar()).rejects.toMatchObject({ code: 'nfse_confianca_indisponivel' });
    writeFileSync(join(pki.pasta, 'raizes.pem'), pki.certificado.certificadoPem);
    await expect(validar()).rejects.toMatchObject({ code: 'nfse_confianca_indisponivel' });
  });
  it('sem configuração não presume confiança', async () => {
    vi.stubEnv('FISCAL_CONFIANCA_DIR', ''); await expect(validar()).rejects.toMatchObject({ code: 'nfse_confianca_indisponivel' });
  });
});
