import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Ocupa a largura disponível. O padrão no celular, onde o polegar manda. */
  readonly block?: boolean;
  /**
   * Trava o botão e anuncia o estado.
   *
   * Não usa `disabled`: elemento desabilitado sai da ordem de tabulação e deixa
   * de ser anunciado, então quem usa leitor de tela perde o contexto no meio da
   * ação. `aria-disabled` mantém o foco e a leitura.
   */
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  readonly children: ReactNode;
}

/**
 * Botão.
 *
 * Altura mínima de 44px em toda variante: o cliente agenda em pé, na rua, com
 * uma mão só.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  loadingLabel = 'Carregando',
  children,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  const blocked = loading || rest['aria-disabled'] === true;

  return (
    <button
      {...rest}
      type={type}
      className={['ui-button', `ui-button--${variant}`, `ui-button--${size}`, block ? 'ui-button--block' : '']
        .filter(Boolean)
        .join(' ')}
      aria-disabled={blocked || undefined}
      aria-busy={loading || undefined}
      onClick={(event) => {
        // `aria-disabled` não impede o clique como `disabled` faria — a barreira
        // precisa ser explícita, senão um duplo toque envia duas vezes.
        if (blocked) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {loading ? (
        <>
          <span className="ui-button__spinner" aria-hidden="true" />
          <span>{loadingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

export const buttonCss = `
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--size-touch);
  padding: 0 var(--space-5);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-family: inherit;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  line-height: 1;
  cursor: pointer;
  /* O botão também é usado em <a> (links de navegação com aparência de botão);
     sem isso o sublinhado do link aparece por cima do rótulo. */
  text-decoration: none;
  transition: background-color var(--motion-fast) var(--motion-ease),
              border-color var(--motion-fast) var(--motion-ease);
}

.ui-button--lg {
  min-height: 52px;
  font-size: var(--font-size-lg);
  padding: 0 var(--space-6);
}

.ui-button--block {
  display: flex;
  width: 100%;
}

.ui-button[aria-disabled='true'] {
  opacity: 0.55;
  cursor: not-allowed;
}

.ui-button--primary {
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}
.ui-button--primary:hover:not([aria-disabled='true']) {
  background: var(--color-accent-hover);
}

.ui-button--secondary {
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  border-color: var(--color-border-strong);
}
.ui-button--secondary:hover:not([aria-disabled='true']) {
  background: var(--color-surface-hover);
}

.ui-button--ghost {
  background: transparent;
  color: var(--color-text-primary);
}
.ui-button--ghost:hover:not([aria-disabled='true']) {
  background: var(--color-surface-hover);
}

.ui-button--danger {
  background: var(--color-danger);
  color: var(--color-text-on-danger);
}

.ui-button__spinner {
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: var(--radius-full);
  animation: ui-spin 700ms linear infinite;
}

@keyframes ui-spin {
  to { transform: rotate(360deg); }
}
`;
