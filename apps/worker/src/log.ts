/**
 * Logger estruturado e deliberadamente estreito do worker.
 *
 * Só aceita escalares: contagem, ids técnicos, estados e códigos. Payload de
 * cliente, texto de mensagem, token, resposta bruta de provedor e objeto de
 * erro não entram por tipo. O destino é stdout/stderr; o agregador escolhe
 * retenção e indexação.
 */
export type NivelDoWorker = 'info' | 'aviso' | 'erro';
export type CampoSeguro = string | number | boolean | null;
export type CamposSeguros = Readonly<Record<string, CampoSeguro | undefined>>;

const CODIGO_SEGURO = /^[A-Za-z0-9_.:-]{1,80}$/;

export function erroSeguro(erro: unknown): CamposSeguros {
  if (!(erro instanceof Error)) return { erroTipo: 'erro_desconhecido' };

  const comCodigo = erro as Error & { code?: unknown };
  const codigo = typeof comCodigo.code === 'string' && CODIGO_SEGURO.test(comCodigo.code)
    ? comCodigo.code
    : undefined;

  return {
    erroTipo: erro.name || 'Error',
    ...(codigo ? { erroCodigo: codigo } : {}),
  };
}

export function logWorker(
  evento: string,
  campos: CamposSeguros = {},
  nivel: NivelDoWorker = 'info',
): void {
  const linha: Record<string, CampoSeguro> = {
    ts: new Date().toISOString(),
    processo: 'worker',
    nivel,
    evento,
    ...(process.env['APP_VERSION'] ? { versao: process.env['APP_VERSION'] } : {}),
    ...(process.env['HOSTNAME'] ? { instancia: process.env['HOSTNAME'] } : {}),
  };
  for (const [chave, valor] of Object.entries(campos)) {
    if (valor !== undefined) linha[chave] = valor;
  }

  const texto = `${JSON.stringify(linha)}\n`;
  if (nivel === 'erro') process.stderr.write(texto);
  else process.stdout.write(texto);
}
