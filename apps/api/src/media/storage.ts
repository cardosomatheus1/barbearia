import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARQUIVO = /^[0-9a-f-]{36}\.(?:webp|jpg|png)$/i;
export const TETO_IMAGEM_PUBLICA = 3 * 1024 * 1024;

export type TipoDeImagem = 'image/webp' | 'image/jpeg' | 'image/png';
export type ModoDeMidia = 'local' | 's3';

const EXTENSAO: Record<TipoDeImagem, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const HASH_VAZIO = createHash('sha256').update('').digest('hex');

function sha256Hex(valor: string | Uint8Array): string {
  return createHash('sha256').update(valor).digest('hex');
}

function hmac(chave: string | Buffer, valor: string): Buffer {
  return createHmac('sha256', chave).update(valor).digest();
}

function raiz(): string {
  return resolve(process.env['MEDIA_ROOT'] ?? resolve(process.cwd(), '.media'));
}

export function modoDeMidia(): ModoDeMidia {
  const bruto = (process.env['MEDIA_STORAGE'] ?? 'local').trim().toLowerCase();
  if (bruto === 'local' || bruto === 's3') return bruto;
  throw new Error('media_storage_mode_invalid');
}

interface ConfigS3 {
  readonly endpoint: URL;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function obrigatoria(nome: string): string {
  const valor = process.env[nome]?.trim();
  if (!valor) throw new Error('media_s3_not_configured');
  return valor;
}

function configS3(): ConfigS3 {
  const endpointBruto = obrigatoria('MEDIA_S3_ENDPOINT');
  let endpoint: URL;
  try {
    endpoint = new URL(endpointBruto);
  } catch {
    throw new Error('media_s3_not_configured');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('media_s3_not_configured');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    // Credencial/query em endpoint acabaria em log, assinatura ou URL canônica.
    throw new Error('media_s3_endpoint_invalido');
  }
  if (
    process.env['NODE_ENV'] === 'production' &&
    endpoint.protocol === 'http:' &&
    process.env['MEDIA_S3_ALLOW_HTTP'] !== '1'
  ) {
    throw new Error('media_s3_http_proibido_em_producao');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  return {
    endpoint,
    bucket: obrigatoria('MEDIA_S3_BUCKET'),
    region: process.env['MEDIA_S3_REGION']?.trim() || 'auto',
    accessKeyId: obrigatoria('MEDIA_S3_ACCESS_KEY_ID'),
    secretAccessKey: obrigatoria('MEDIA_S3_SECRET_ACCESS_KEY'),
  };
}


export function validarConfiguracaoDeMidia(): ModoDeMidia {
  const modo = modoDeMidia();
  if (modo === 's3') configS3();
  return modo;
}

export function tipoDaImagem(bytes: Uint8Array): TipoDeImagem | null {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  return null;
}

function validarChave(tenantId: string, arquivo: string): void {
  if (!UUID.test(tenantId) || !ARQUIVO.test(arquivo)) throw new Error('media_key_invalida');
}

function caminho(tenantId: string, arquivo: string): string {
  validarChave(tenantId, arquivo);
  const base = raiz();
  const destino = resolve(base, tenantId, arquivo);
  if (!destino.startsWith(`${base}${sep}`)) throw new Error('media_key_invalida');
  return destino;
}

function chaveObjeto(tenantId: string, arquivo: string): string {
  validarChave(tenantId, arquivo);
  return `${tenantId}/${arquivo}`;
}

function encodeSegmento(valor: string): string {
  return encodeURIComponent(valor).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function urlObjeto(config: ConfigS3, key: string): URL {
  const url = new URL(config.endpoint.toString());
  const prefixo = url.pathname.replace(/\/+$/, '');
  const segmentos = [config.bucket, ...key.split('/')].map(encodeSegmento).join('/');
  url.pathname = `${prefixo}/${segmentos}`.replace(/\/{2,}/g, '/');
  return url;
}

function dataAws(agora: Date): { readonly amz: string; readonly curta: string } {
  const iso = agora.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, curta: iso.slice(0, 8) };
}

/**
 * Assinatura AWS Signature V4 sem SDK.
 *
 * Usamos path-style porque funciona em AWS S3, Cloudflare R2 e MinIO e não
 * exige que o nome do bucket seja incorporado ao DNS. O bucket nunca é público:
 * a URL que sai no produto continua sendo `/media/<tenant>/<uuid>.<ext>` e a API
 * lê o objeto com credenciais de servidor.
 */
function autorizacaoS3(
  config: ConfigS3,
  metodo: 'GET' | 'PUT' | 'DELETE',
  url: URL,
  payloadHash: string,
  agora = new Date(),
): { readonly authorization: string; readonly amzDate: string; readonly payloadHash: string } {
  const { amz, curta } = dataAws(agora);
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    metodo,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const escopo = `${curta}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amz,
    escopo,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${config.secretAccessKey}`, curta);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${escopo}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate: amz,
    payloadHash,
  };
}

async function fetchS3(
  metodo: 'GET' | 'PUT' | 'DELETE',
  key: string,
  corpo?: Uint8Array,
  tipo?: TipoDeImagem,
): Promise<Response> {
  const config = configS3();
  const url = urlObjeto(config, key);
  const payloadHash = corpo ? sha256Hex(corpo) : HASH_VAZIO;
  const assinatura = autorizacaoS3(config, metodo, url, payloadHash);
  const headers = new Headers({
    authorization: assinatura.authorization,
    'x-amz-content-sha256': assinatura.payloadHash,
    'x-amz-date': assinatura.amzDate,
  });
  if (tipo) headers.set('content-type', tipo);

  try {
    return await fetch(url, {
      method: metodo,
      headers,
      ...(corpo ? { body: Buffer.from(corpo) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const causa = error instanceof Error ? error.name : 'unknown';
    throw new Error(`media_s3_network:${causa}`);
  }
}

async function guardarLocal(tenantId: string, arquivo: string, bytes: Uint8Array): Promise<void> {
  const pasta = resolve(raiz(), tenantId);
  await mkdir(pasta, { recursive: true, mode: 0o750 });
  await writeFile(caminho(tenantId, arquivo), bytes, { flag: 'wx', mode: 0o640 });
}

async function guardarS3(tenantId: string, arquivo: string, bytes: Uint8Array, tipo: TipoDeImagem): Promise<void> {
  const resposta = await fetchS3('PUT', chaveObjeto(tenantId, arquivo), bytes, tipo);
  if (!resposta.ok) throw new Error(`media_s3_write_failed:${resposta.status}`);
}

export async function guardarImagemPublica(
  tenantId: string,
  bytes: Uint8Array,
): Promise<{ readonly url: string; readonly tipo: TipoDeImagem; readonly bytes: number }> {
  if (!UUID.test(tenantId)) throw new Error('media_key_invalida');
  if (bytes.byteLength === 0 || bytes.byteLength > TETO_IMAGEM_PUBLICA) throw new Error('media_tamanho_invalido');
  const tipo = tipoDaImagem(bytes);
  if (!tipo) throw new Error('media_tipo_invalido');

  const arquivo = `${randomUUID()}.${EXTENSAO[tipo]}`;
  if (modoDeMidia() === 's3') await guardarS3(tenantId, arquivo, bytes, tipo);
  else await guardarLocal(tenantId, arquivo, bytes);
  return { url: `/media/${tenantId}/${arquivo}`, tipo, bytes: bytes.byteLength };
}

async function lerLocal(tenantId: string, arquivo: string): Promise<{ readonly bytes: Buffer; readonly tipo: TipoDeImagem } | null> {
  try {
    const bytes = await readFile(caminho(tenantId, arquivo));
    const tipo = tipoDaImagem(bytes);
    return tipo ? { bytes, tipo } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function lerS3(tenantId: string, arquivo: string): Promise<{ readonly bytes: Buffer; readonly tipo: TipoDeImagem } | null> {
  const resposta = await fetchS3('GET', chaveObjeto(tenantId, arquivo));
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`media_s3_read_failed:${resposta.status}`);
  const bytes = Buffer.from(await resposta.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > TETO_IMAGEM_PUBLICA) throw new Error('media_s3_object_invalid');
  const tipo = tipoDaImagem(bytes);
  if (!tipo) throw new Error('media_s3_object_invalid');
  return { bytes, tipo };
}

export async function lerImagemPublica(
  tenantId: string,
  arquivo: string,
): Promise<{ readonly bytes: Buffer; readonly tipo: TipoDeImagem } | null> {
  validarChave(tenantId, arquivo);
  return modoDeMidia() === 's3' ? lerS3(tenantId, arquivo) : lerLocal(tenantId, arquivo);
}

async function apagarLocal(url: string, tenantId: string): Promise<void> {
  const prefixo = `/media/${tenantId}/`;
  if (!url.startsWith(prefixo)) return;
  const arquivo = url.slice(prefixo.length);
  try {
    await unlink(caminho(tenantId, arquivo));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function apagarS3(url: string, tenantId: string): Promise<void> {
  const prefixo = `/media/${tenantId}/`;
  if (!url.startsWith(prefixo)) return;
  const arquivo = url.slice(prefixo.length);
  validarChave(tenantId, arquivo);
  const resposta = await fetchS3('DELETE', chaveObjeto(tenantId, arquivo));
  if (!resposta.ok && resposta.status !== 404) throw new Error(`media_s3_delete_failed:${resposta.status}`);
}

export async function apagarImagemPublica(url: string | null | undefined, tenantId: string): Promise<void> {
  if (!url) return;
  if (modoDeMidia() === 's3') await apagarS3(url, tenantId);
  else await apagarLocal(url, tenantId);
}

/**
 * Limpeza física pós-commit. Falha de disco/object storage não transforma uma
 * alteração de banco já concluída em 500: retorna `false` para
 * observabilidade/reconciliação e deixa a operação lógica verdadeira.
 */
export async function tentarApagarImagemPublica(
  url: string | null | undefined,
  tenantId: string,
): Promise<boolean> {
  try {
    await apagarImagemPublica(url, tenantId);
    return true;
  } catch {
    return false;
  }
}
