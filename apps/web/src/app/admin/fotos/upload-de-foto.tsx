'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { acaoRemoverFotoDaBarbearia, acaoUploadFoto } from '../acoes';
import styles from './upload-de-foto.module.css';

type Alvo = 'cover' | 'logo' | 'professional' | 'service';

const AJUSTE: Record<Alvo, { width: number; height: number; modo: 'cover' | 'contain' }> = {
  cover: { width: 1600, height: 900, modo: 'cover' },
  logo: { width: 800, height: 800, modo: 'contain' },
  professional: { width: 800, height: 800, modo: 'cover' },
  service: { width: 600, height: 600, modo: 'cover' },
};

async function prepararImagem(arquivo: File, alvo: Alvo): Promise<File> {
  if (!arquivo.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem.');
  if (arquivo.size > 12 * 1024 * 1024) throw new Error('A imagem original passa de 12 MB.');
  const bitmap = await createImageBitmap(arquivo);
  try {
    const { width, height, modo } = AJUSTE[alvo];
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Seu navegador não conseguiu preparar a imagem.');

    if (modo === 'contain') {
      const escala = Math.min(width / bitmap.width, height / bitmap.height);
      const w = bitmap.width * escala;
      const h = bitmap.height * escala;
      ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    } else {
      const escala = Math.max(width / bitmap.width, height / bitmap.height);
      const w = bitmap.width * escala;
      const h = bitmap.height * escala;
      ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    }

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((resultado) => resultado ? resolve(resultado) : reject(new Error('Não foi possível comprimir a imagem.')), 'image/webp', 0.84),
    );
    if (blob.size > 3 * 1024 * 1024) throw new Error('Mesmo comprimida, a imagem passa de 3 MB. Escolha outra.');
    return new File([blob], `${alvo}-${Date.now()}.webp`, { type: 'image/webp' });
  } finally {
    bitmap.close();
  }
}

export function UploadDeFoto({
  target,
  targetId,
  rotulo,
  atual,
  dica,
}: {
  readonly target: Alvo;
  readonly targetId?: string;
  readonly rotulo: string;
  readonly atual: string | null;
  readonly dica: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [preview, setPreview] = useState<string | null>(atual);
  const [estado, setEstado] = useState('Nenhum arquivo escolhido');
  const [preparando, setPreparando] = useState(false);
  const [pronto, setPronto] = useState(false);

  useEffect(() => () => {
    if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview);
  }, [preview]);

  const quadrada = target !== 'cover';
  const legado = atual?.startsWith('https://') === true;

  return (
    <div className={styles.campo}>
      <div className={styles.rotulo}>{rotulo}</div>
      <div className={styles.corpo}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob local antes de salvar.
          <img
            alt=""
            className={`${styles.preview} ${quadrada ? styles.previewQuadrada : ''}`}
            height={AJUSTE[target].height}
            src={preview}
            width={AJUSTE[target].width}
          />
        ) : (
          <span className={`${styles.preview} ${quadrada ? styles.previewQuadrada : ''} ${styles.vazia}`}>Sem imagem</span>
        )}
        <div className={styles.acoes}>
          <form action={acaoUploadFoto}>
            <input name="target" type="hidden" value={target} />
            {targetId ? <input name="targetId" type="hidden" value={targetId} /> : null}
            <input
              accept="image/jpeg,image/png,image/webp"
              className={styles.arquivo}
              id={inputId}
              name="arquivo"
              ref={input}
              required
              type="file"
              onChange={async (evento) => {
                const original = evento.currentTarget.files?.[0];
                if (!original) {
                  setPronto(false);
                  setEstado('Nenhum arquivo escolhido');
                  return;
                }
                setPreparando(true);
                setPronto(false);
                setEstado('Preparando imagem…');
                try {
                  const preparado = await prepararImagem(original, target);
                  const transferencia = new DataTransfer();
                  transferencia.items.add(preparado);
                  if (input.current) input.current.files = transferencia.files;
                  if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview);
                  setPreview(URL.createObjectURL(preparado));
                  setPronto(true);
                  setEstado(`${Math.round(preparado.size / 1024)} kB · WebP pronto para enviar`);
                } catch (erro) {
                  if (input.current) input.current.value = '';
                  setPronto(false);
                  setEstado(erro instanceof Error ? erro.message : 'Não foi possível preparar a imagem.');
                } finally {
                  setPreparando(false);
                }
              }}
            />
            <div className={styles.seletor}>
              <label className={`ui-button ui-button--ghost ${styles.escolher}`} htmlFor={inputId}>
                {atual ? 'Trocar imagem' : 'Escolher imagem'}
              </label>
              <span aria-live="polite" className={styles.estado}>{estado}</span>
            </div>
            <p className={styles.hint}>{dica}</p>
            {legado ? <p className={`${styles.hint} ${styles.legado}`}>Imagem externa antiga. Substitua pelo arquivo para ela ficar hospedada no Barberdock.</p> : null}
            <div className={styles.botoes}>
              <button className="ui-button ui-button--primary" disabled={preparando || !pronto} type="submit">
                {preparando ? 'Preparando…' : 'Enviar imagem'}
              </button>
            </div>
          </form>
          {atual ? (
            <form action={acaoRemoverFotoDaBarbearia}>
              <input name="target" type="hidden" value={target} />
              {targetId ? <input name="targetId" type="hidden" value={targetId} /> : null}
              <button className="ui-button ui-button--ghost" type="submit">Remover</button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}
