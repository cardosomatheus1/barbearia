import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guardarImagemPublica,
  lerImagemPublica,
  modoDeMidia,
  validarConfiguracaoDeMidia,
  tentarApagarImagemPublica,
  tipoDaImagem,
} from './storage.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

let raiz = '';
beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'barberdock-media-'));
  process.env['MEDIA_STORAGE'] = 'local';
  process.env['MEDIA_ROOT'] = raiz;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const nome of [
    'MEDIA_STORAGE', 'MEDIA_ROOT', 'MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET',
    'MEDIA_S3_REGION', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY', 'MEDIA_S3_ALLOW_HTTP',
  ]) delete process.env[nome];
  await rm(raiz, { recursive: true, force: true });
});

describe('armazenamento de mídia pública', () => {
  it('identifica pela assinatura, grava com nome opaco e lê os mesmos bytes no modo local', async () => {
    expect(modoDeMidia()).toBe('local');
    expect(tipoDaImagem(PNG)).toBe('image/png');
    const salvo = await guardarImagemPublica(TENANT, PNG);
    expect(salvo.url).toMatch(new RegExp(`^/media/${TENANT}/[0-9a-f-]{36}\\.png$`, 'i'));
    const arquivo = salvo.url.split('/').at(-1)!;
    const lido = await lerImagemPublica(TENANT, arquivo);
    expect(lido?.tipo).toBe('image/png');
    expect(lido?.bytes.equals(PNG)).toBe(true);
  });

  it('não aceita texto renomeado para imagem', async () => {
    await expect(guardarImagemPublica(TENANT, Buffer.from('<script>alert(1)</script>')))
      .rejects.toThrow('media_tipo_invalido');
  });

  it('não transforma caminho em acesso ao filesystem', async () => {
    await expect(lerImagemPublica(TENANT, '../../etc/passwd')).rejects.toThrow('media_key_invalida');
  });

  it('limpeza pós-commit não propaga falha de chave/arquivo', async () => {
    await expect(tentarApagarImagemPublica(`/media/${TENANT}/../../etc/passwd`, TENANT))
      .resolves.toBe(false);
  });

  it('usa S3 compatível sem expor o bucket na URL pública', async () => {
    process.env['MEDIA_STORAGE'] = 's3';
    process.env['MEDIA_S3_ENDPOINT'] = 'https://objects.example.test';
    process.env['MEDIA_S3_BUCKET'] = 'barberdock-media';
    process.env['MEDIA_S3_REGION'] = 'auto';
    process.env['MEDIA_S3_ACCESS_KEY_ID'] = 'access-key';
    process.env['MEDIA_S3_SECRET_ACCESS_KEY'] = 'secret-key';

    const requisicoes: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requisicoes.push({ url, init: init ?? {} });
      if (init?.method === 'GET') return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      return new Response(null, { status: 204 });
    }));

    const salvo = await guardarImagemPublica(TENANT, PNG);
    expect(salvo.url).toMatch(new RegExp(`^/media/${TENANT}/[0-9a-f-]{36}\\.png$`, 'i'));
    expect(salvo.url).not.toContain('objects.example.test');

    const arquivo = salvo.url.split('/').at(-1)!;
    const lido = await lerImagemPublica(TENANT, arquivo);
    expect(lido?.bytes.equals(PNG)).toBe(true);
    await expect(tentarApagarImagemPublica(salvo.url, TENANT)).resolves.toBe(true);

    expect(requisicoes.map((r) => r.init.method)).toEqual(['PUT', 'GET', 'DELETE']);
    for (const requisicao of requisicoes) {
      expect(requisicao.url).toContain(`/barberdock-media/${TENANT}/`);
      const headers = new Headers(requisicao.init.headers);
      expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=access-key\//);
      expect(headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
      expect(headers.get('x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('em produção exige decisão explícita para S3 sem TLS', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['MEDIA_STORAGE'] = 's3';
    process.env['MEDIA_S3_ENDPOINT'] = 'http://minio:9000';
    process.env['MEDIA_S3_BUCKET'] = 'barberdock-media';
    process.env['MEDIA_S3_ACCESS_KEY_ID'] = 'access-key';
    process.env['MEDIA_S3_SECRET_ACCESS_KEY'] = 'secret-key';
    expect(() => validarConfiguracaoDeMidia()).toThrow('media_s3_http_proibido_em_producao');
    process.env['MEDIA_S3_ALLOW_HTTP'] = '1';
    expect(validarConfiguracaoDeMidia()).toBe('s3');
    delete process.env['NODE_ENV'];
  });

  it('não aceita credencial, query ou fragmento dentro do endpoint S3', () => {
    process.env['MEDIA_STORAGE'] = 's3';
    process.env['MEDIA_S3_ENDPOINT'] = 'https://usuario:senha@objects.example.test/path?token=x#frag';
    process.env['MEDIA_S3_BUCKET'] = 'barberdock-media';
    process.env['MEDIA_S3_ACCESS_KEY_ID'] = 'access-key';
    process.env['MEDIA_S3_SECRET_ACCESS_KEY'] = 'secret-key';
    expect(() => validarConfiguracaoDeMidia()).toThrow('media_s3_endpoint_invalido');
  });

  it('falha alto no modo S3 quando credencial está incompleta', async () => {
    process.env['MEDIA_STORAGE'] = 's3';
    process.env['MEDIA_S3_ENDPOINT'] = 'https://objects.example.test';
    process.env['MEDIA_S3_BUCKET'] = 'barberdock-media';
    await expect(guardarImagemPublica(TENANT, PNG)).rejects.toThrow('media_s3_not_configured');
  });
});
