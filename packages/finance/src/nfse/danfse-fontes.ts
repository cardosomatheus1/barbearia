import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { NfseError } from './erros.js';

export interface FontesDanfse {
  readonly arialNegrito: Buffer | 'Helvetica-Bold';
  readonly arialRegular: Buffer | 'Helvetica';
  readonly conteudo: Buffer | 'Helvetica';
}

/** Arquivos licenciados instalados pela plataforma, nunca enviados por tenant. */
export function fontesDanfse(): FontesDanfse {
  const pasta = process.env['FISCAL_DANFSE_FONTES_DIR'];
  try {
    if (!pasta || !isAbsolute(pasta)) throw new Error('pasta_ausente');
    const ler = (nome: string) => {
      const caminho = join(pasta, nome); const st = statSync(caminho);
      if (!st.isFile() || st.size < 1000 || st.size > 8 * 1024 * 1024) throw new Error('fonte_invalida');
      return readFileSync(caminho);
    };
    return { arialNegrito: ler('arial-bold.ttf'), arialRegular: ler('arial.ttf'), conteudo: ler('microsoft-sans-serif.ttf') };
  } catch { throw new NfseError('nfse_pdf_fontes_ausentes', 'O suporte precisa configurar as fontes do documento fiscal.', 503); }
}
