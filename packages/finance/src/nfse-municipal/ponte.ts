import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { NfseError } from '../nfse/erros.js';
import { registro } from '../nfse/transporte.js';
import { executavelMunicipal, exigirMunicipioReaproveitado } from './catalogo.js';
import type { PedidoMunicipal, ResultadoMunicipal, NotaMunicipal } from './contrato.js';

const LIMITE = 20 * 1024 * 1024;
const FALHA = () => new NfseError('nfse_municipal_processamento_falhou', 'Não foi possível confirmar a operação municipal. Confira o estado da nota antes de repetir.', 503);
export type MotorMunicipal = (pedido: PedidoMunicipal) => Promise<ResultadoMunicipal>;

export function lerResultadoMunicipal(bruto: unknown): ResultadoMunicipal {
  const r = registro(bruto);
  const texto = (x: unknown): x is string => typeof x === 'string' && Buffer.byteLength(x) <= 5 * 1024 * 1024;
  const identificador = (x: unknown): x is string => typeof x === 'string' && x.length <= 100;
  if (typeof r['sucesso'] !== 'boolean' || !(r['erro'] === null ||
      typeof r['erro'] === 'string' && /^nfse_municipal_[a-z_]{1,60}$/.test(r['erro'])) ||
      !texto(r['xmlEnvio']) || !texto(r['xmlRetorno']) ||
      !(r['protocolo'] === null || identificador(r['protocolo'])) ||
      !(r['lote'] === null || Number.isSafeInteger(r['lote'])) ||
      !Array.isArray(r['codigos']) || r['codigos'].length > 10 ||
      !r['codigos'].every(c => typeof c === 'string' && /^[a-zA-Z0-9_.-]{1,40}$/.test(c)) ||
      !Array.isArray(r['notas']) || r['notas'].length > 50) throw FALHA();
  const notas: NotaMunicipal[] = r['notas'].map(valor => {
    const n = registro(valor);
    if (!identificador(n['numero']) || !identificador(n['verificacao']) || !texto(n['xml']) ||
        !identificador(n['rps']) || !identificador(n['serie']) || !identificador(n['cnpj']) ||
        !identificador(n['inscricaoMunicipal']) || !Number.isSafeInteger(n['servicoCents']) ||
        !Number.isSafeInteger(n['descontoCents']) || !identificador(n['documentoTomador']) ||
        ![n['dataEmissao'], n['competencia']].every(d => d === null || typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ||
        !(n['situacao'] === null || n['situacao'] === 'autorizada' || n['situacao'] === 'cancelada')) throw FALHA();
    return n as unknown as NotaMunicipal;
  });
  const requisicao = r['requisicao'];
  if (requisicao != null) {
    const q = registro(requisicao);
    if (typeof q['url'] !== 'string' || !q['url'].startsWith('https://') || q['url'].length > 4096 ||
        typeof q['metodo'] !== 'string' || !/^(POST|PUT|GET)$/.test(q['metodo']) ||
        typeof q['corpoBase64'] !== 'string' || q['corpoBase64'].length > 7 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(q['corpoBase64'])) throw FALHA();
    for (const h of [q['cabecalhos'], q['cabecalhosConteudo']]) {
      const headers = registro(h);
      if (Object.keys(headers).length > 30 || !Object.entries(headers).every(([key, values]) =>
        /^[A-Za-z0-9-]{1,100}$/.test(key) && Array.isArray(values) && values.length <= 10 &&
        values.every(v => typeof v === 'string' && v.length <= 8192 && !/[\r\n]/.test(v)))) throw FALHA();
    }
  }
  return { sucesso: r['sucesso'], erro: r['erro'], codigos: r['codigos'] as string[],
    xmlEnvio: r['xmlEnvio'], xmlRetorno: r['xmlRetorno'], protocolo: r['protocolo'],
    lote: r['lote'] as number | null, notas, requisicao: (requisicao ?? null) as Exclude<ResultadoMunicipal['requisicao'], undefined> };
}

/** Um processo por operação: chaves via pipe, sem shell, arquivos ou estado entre tenants. */
export const executarMotorMunicipal: MotorMunicipal = pedido => {
  exigirMunicipioReaproveitado(String(pedido.municipio), pedido.ambiente);
  const corpo = Buffer.from(JSON.stringify(pedido));
  if (corpo.length > 8 * 1024 * 1024) throw new NfseError('nfse_municipal_limite', 'Os dados fiscais excedem o limite permitido.');
  const bin = executavelMunicipal();
  return new Promise((resolve, reject) => {
    let filho: ChildProcessWithoutNullStreams;
    try {
      // Não herdar credenciais do banco/Stripe/Meta. O motor precisa somente do runtime.
      filho = spawn(bin, [], { shell: false, stdio: 'pipe', env: {
        LANG: 'C.UTF-8', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_EnableDiagnostics: '0', ...(process.env['LD_LIBRARY_PATH'] ? { LD_LIBRARY_PATH: process.env['LD_LIBRARY_PATH'] } : {}),
      } });
    } catch { corpo.fill(0); reject(FALHA()); return; }
    const partes: Buffer[] = []; let tamanho = 0; let erroBytes = 0; let encerrado = false;
    const falhar = () => {
      if (encerrado) return;
      encerrado = true; clearTimeout(prazo); filho.kill('SIGKILL'); corpo.fill(0); reject(FALHA());
    };
    const prazo = setTimeout(falhar, 60_000);
    filho.on('error', falhar);
    filho.stdin.on('error', falhar);
    filho.stdout.on('data', (parte: Buffer) => {
      tamanho += parte.length;
      if (tamanho > LIMITE) falhar(); else partes.push(parte);
    });
    // Drenar stderr sem reproduzi-lo: bibliotecas podem incluir XML em exceções.
    filho.stderr.on('data', (parte: Buffer) => { erroBytes += parte.length; if (erroBytes > 65536) falhar(); });
    filho.on('close', code => {
      if (encerrado) return;
      encerrado = true; clearTimeout(prazo); corpo.fill(0);
      try {
        const resposta = lerResultadoMunicipal(JSON.parse(Buffer.concat(partes).toString('utf8')) as unknown);
        if (code !== 0) throw FALHA();
        resolve(resposta);
      } catch { reject(FALHA()); }
    });
    filho.stdin.end(corpo, () => corpo.fill(0));
  });
};
