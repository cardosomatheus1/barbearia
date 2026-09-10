import { createServer, request, type RequestOptions, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpNfse } from './transporte.js';
import type { CertificadoA1 } from './certificado.js';

/** Só o destino de rede é redirecionado. TLS e apresentação do A1 são reais. */
describe('transporte fiscal com mTLS local', () => {
  let server: Server; let porta: number; let caPem: string; let certificado: CertificadoA1;
  let resposta = 'json'; let recebidos = 0;
  const destinos: string[] = [];
  const emitir = (cn: string, ca?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey }, autoridade = !ca) => {
    const keys = forge.pki.rsa.generateKeyPair(2048); const c = forge.pki.createCertificate();
    c.publicKey = keys.publicKey; c.serialNumber = ca ? '02' : '01';
    c.validity.notBefore = new Date('2020-01-01'); c.validity.notAfter = new Date('2040-01-01');
    c.setSubject([{ name: 'commonName', value: cn }]); c.setIssuer(ca?.cert.subject.attributes ?? c.subject.attributes);
    c.setExtensions([{ name: 'basicConstraints', cA: autoridade },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: autoridade },
      ...(!autoridade ? [{ name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: cn }] }] : [])]);
    c.sign(ca?.key ?? keys.privateKey, forge.md.sha256.create());
    return { cert: c, key: keys.privateKey, pem: forge.pki.certificateToPem(c), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
  };
  const local = ((url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    destinos.push(url.href);
    return request(new URL(`https://127.0.0.1:${porta}${url.pathname}`),
      { ...options, ca: caPem, servername: 'emissor.sintetico.invalid' }, callback);
  }) as typeof request;

  beforeAll(async () => {
    const ca = emitir('CA sintetica'); caPem = ca.pem;
    const servidor = emitir('emissor.sintetico.invalid', ca);
    const intermediaria = emitir('CA intermediaria sintetica', ca, true);
    const cliente = emitir('cliente.sintetico.invalid', intermediaria);
    certificado = { cnpj: '12345678000195', certificadoPem: cliente.pem, cadeiaPem: cliente.pem+intermediaria.pem, chavePem: cliente.keyPem,
      validoDesde: cliente.cert.validity.notBefore, validoAte: cliente.cert.validity.notAfter, fingerprint: 'sintetico' };
    server = createServer({ cert: servidor.pem, key: servidor.keyPem, ca: ca.pem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      expect((req.socket as TLSSocket).authorized).toBe(true);
      expect((req.socket as TLSSocket).getPeerCertificate().subject.CN).toBe('cliente.sintetico.invalid');
      recebidos++;
      req.resume();
      if (resposta === 'timeout') return;
      if (resposta === 'redirect') { res.writeHead(302, { Location: 'https://destino.invalid' }); res.end(); return; }
      if (resposta === 'grande') { res.end(Buffer.alloc(5 * 1024 * 1024 + 1, 65)); return; }
      if (resposta === 'quebrada') { res.writeHead(200, { 'Content-Length': '100' }); res.write('{'); setTimeout(() => res.destroy(), 10); return; }
      res.end(resposta === 'pdf' ? '%PDF-1.4\n%%EOF' : resposta === 'invalida' ? '<html>erro</html>' : JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    porta = (server.address() as AddressInfo).port;
  }, 15_000);
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  it('apresenta o A1, valida o servidor e mantém destinos oficiais fixos', async () => {
    resposta = 'json';
    expect(await httpNfse({ ambiente: 'homologacao', certificado, metodo: 'POST', caminho: '/nfse', corpo: { dpsXmlGZipB64: 'sintetico' } }, local))
      .toEqual({ status: 200, dados: { ok: true } });
    expect(destinos.at(-1)).toBe('https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/nfse');
    const antes = recebidos;
    await expect(httpNfse({ ambiente: 'producao', certificado, metodo: 'GET', caminho: '/nfse/../../segredo' }, local))
      .rejects.toMatchObject({ code: 'nfse_destino_invalido' });
    expect(recebidos).toBe(antes);
  });

  it('recusa redirecionamento, JSON inválido, corpo excedente e resposta interrompida', async () => {
    for (const [tipo, code] of [['redirect', 'nfse_redirecionamento_recusado'], ['invalida', 'nfse_resposta_invalida'],
      ['grande', 'nfse_resposta_grande'], ['quebrada', 'nfse_transporte_falhou']]) {
      resposta = tipo ?? '';
      await expect(httpNfse({ ambiente: 'homologacao', certificado, metodo: 'GET', caminho: '/nfse' }, local)).rejects.toMatchObject({ code });
    }
  });

  it('não desabilita a validação TLS quando o servidor não é confiável', async () => {
    const semCa = ((url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) =>
      request(new URL(`https://127.0.0.1:${porta}${url.pathname}`), { ...options, servername: 'emissor.sintetico.invalid' }, callback)) as typeof request;
    const antes = recebidos;
    await expect(httpNfse({ ambiente: 'homologacao', certificado, metodo: 'GET', caminho: '/nfse' }, semCa))
      .rejects.toMatchObject({ code: 'nfse_transporte_falhou' });
    expect(recebidos).toBe(antes);
  });
  it('sem a intermediária o servidor não aceita a identidade do cliente', async () => {
    const antes = recebidos;
    await expect(httpNfse({ ambiente: 'homologacao', certificado: { ...certificado, cadeiaPem: certificado.certificadoPem },
      metodo: 'GET', caminho: '/nfse' }, local)).rejects.toMatchObject({ code: 'nfse_transporte_falhou' });
    expect(recebidos).toBe(antes);
  });

  it('prazo total encerra servidor que nunca responde', async () => {
    resposta = 'timeout';
    await expect(httpNfse({ ambiente: 'homologacao', certificado, metodo: 'GET', caminho: '/nfse' }, local))
      .rejects.toMatchObject({ code: 'nfse_timeout' });
  }, 25_000);
});
