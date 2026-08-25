'use client';

import { useState } from 'react';
import styles from './resolver-conflitos.module.css';
import { acaoResolverConflitoImportacao } from '../acoes';
import type { ConflitoVisivel, EscolhaDoConflito } from './conflitos';

interface Props {
  readonly importId: string;
  readonly conflitos: readonly ConflitoVisivel[];
}

/**
 * A primeira ilha de cliente do produto.
 *
 * Só ela recebe JavaScript porque só ela precisa manter uma decisão independente
 * por linha antes de enviar. O resto da página de importação continua Server
 * Component; a página pública não importa este arquivo nem qualquer ancestral
 * dele.
 */
export function ResolverConflitos({ importId, conflitos }: Props) {
  const [escolhas, setEscolhas] = useState<Record<number, EscolhaDoConflito | undefined>>({});

  if (conflitos.length === 0) return null;

  return (
    <section aria-labelledby="conflitos-titulo" className={styles.section}>
      <div className={styles.header}>
        <div>
          <h3 className="avisos__titulo" id="conflitos-titulo">Celular repetido com nomes diferentes</h3>
          <p className="painel__nota">
            Escolha qual cadastro representa o celular. Os dados da linha escolhida serão os usados
            quando a importação for aplicada.
          </p>
        </div>
        <span className={`${styles.count} tabular`}>{conflitos.length} para decidir</span>
      </div>

      <ul className={styles.list}>
        {conflitos.map((linha) => {
          const escolha = escolhas[linha.linha];
          return (
            <li className={styles.item} key={linha.linha}>
              <div className={styles.meta}>
                <span>Linha {linha.linha}</span>
                <span>{linha.telefoneMascarado}</span>
              </div>

              <div aria-label={`Escolha para a linha ${linha.linha}`} className={styles.options} role="radiogroup">
                <button
                  aria-checked={escolha === 'anterior'}
                  className={styles.option}
                  onClick={() => setEscolhas((atual) => ({ ...atual, [linha.linha]: 'anterior' }))}
                  role="radio"
                  type="button"
                >
                  <span className={styles.label}>Manter o primeiro</span>
                  <strong>{linha.nomeAnterior}</strong>
                </button>
                <button
                  aria-checked={escolha === 'linha'}
                  className={styles.option}
                  onClick={() => setEscolhas((atual) => ({ ...atual, [linha.linha]: 'linha' }))}
                  role="radio"
                  type="button"
                >
                  <span className={styles.label}>Usar esta linha</span>
                  <strong>{linha.nomeDaLinha}</strong>
                </button>
              </div>

              <form action={acaoResolverConflitoImportacao} className={styles.action}>
                <input name="id" type="hidden" value={importId} />
                <input name="linha" type="hidden" value={linha.linha} />
                <input name="escolha" type="hidden" value={escolha ?? ''} />
                <button className="ui-button ui-button--secondary" disabled={!escolha} type="submit">
                  Confirmar escolha
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
