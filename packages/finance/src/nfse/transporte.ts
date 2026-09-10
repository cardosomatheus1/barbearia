import { request, type RequestOptions } from 'node:https';
import type { CertificadoA1 } from './certificado.js';
import { NfseError } from './erros.js';

export type AmbienteNfse = 'homologacao' | 'producao';
// Publicados em gov.br/nfse/.../apis-prod-restrita-e-producao. Sem URL fornecida pelo usuário.
const ENDERECOS = {
  homologacao: 'https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional',
  producao: 'https://sefin.nfse.gov.br/SefinNacional',
} as const;
const LIMITE_RESPOSTA = 5 * 1024 * 1024;
export interface PedidoHttpNfse {
  readonly ambiente: AmbienteNfse;
  readonly certificado: CertificadoA1;
  readonly caminho: string;
  readonly metodo: 'GET' | 'POST';
  readonly corpo?: Readonly<Record<string, string>>;
}
export interface RespostaHttpNfse { readonly status: number; readonly dados: unknown }
export type TransporteNfse = (pedido: PedidoHttpNfse) => Promise<RespostaHttpNfse>;

export function registro(valor: unknown): Record<string, unknown> {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor as Record<string, unknown> : {};
}

export function codigosDaResposta(dados: unknown): string[] {
  const erros = registro(dados)['erros'];
  return Array.isArray(erros) ? erros.flatMap(e => {
    const c = registro(e)['codigo']; return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,30}$/.test(c) ? [c] : [];
  }).slice(0, 5) : [];
}

/** TLS autenticado, sem redirects, limite de corpo e prazo total (inclui DNS/TLS). */
export async function httpNfse(p: PedidoHttpNfse, enviar: typeof request = request): Promise<RespostaHttpNfse> {
  if (!Object.hasOwn(ENDERECOS, p.ambiente) || !/^\/(?:nfse(?:\/[0-9]{50}(?:\/eventos(?:\/[0-9]{6}\/\d{1,3})?)?)?|dps\/DPS\d{42}|parametros_municipais\/\d{7}\/convenio)$/.test(p.caminho)) {
    throw new NfseError('nfse_destino_invalido', 'Destino fiscal inválido.');
  }
  const url = new URL(`${ENDERECOS[p.ambiente]}${p.caminho}`);
  const body = p.corpo ? Buffer.from(JSON.stringify(p.corpo)) : undefined;
  if (body && body.length > LIMITE_RESPOSTA) throw new NfseError('nfse_pedido_grande', 'Documento fiscal acima do limite.');
  return new Promise((resolve, reject) => {
    const options: RequestOptions = { method: p.metodo, cert: p.certificado.cadeiaPem,
      key: p.certificado.chavePem, minVersion: 'TLSv1.2', rejectUnauthorized: true,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) } };
    const req = enviar(url, options, res => {
      const partes: Buffer[] = []; let tamanho = 0;
      res.on('data', (parte: Buffer) => {
        tamanho += parte.length;
        if (tamanho > LIMITE_RESPOSTA) { req.destroy(); reject(new NfseError('nfse_resposta_grande', 'Resposta fiscal acima do limite.', 502)); }
        else partes.push(parte);
      });
      res.on('error', () => reject(new NfseError('nfse_transporte_falhou', 'A comunicação fiscal foi interrompida.', 503)));
      res.on('end', () => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) { reject(new NfseError('nfse_redirecionamento_recusado', 'O endereço fiscal retornou um redirecionamento.', 502)); return; }
        try { resolve({ status, dados: partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) as unknown : null }); }
        catch { reject(new NfseError('nfse_resposta_invalida', 'O emissor devolveu uma resposta inválida.', 502)); }
      });
    });
    const prazo = setTimeout(() => { req.destroy(); reject(new NfseError('nfse_timeout', 'O emissor não respondeu a tempo. A nota será consultada antes de novo envio.', 503)); }, 20_000);
    req.once('close', () => clearTimeout(prazo));
    req.once('error', () => { clearTimeout(prazo); reject(new NfseError('nfse_transporte_falhou', 'Não foi possível comunicar com o emissor fiscal.', 503)); });
    if (body) req.write(body);
    req.end();
  });
}
