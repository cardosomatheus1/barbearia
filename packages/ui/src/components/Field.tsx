import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> {
  readonly label: string;
  /** Texto de apoio permanente: formato esperado, exemplo. */
  readonly hint?: ReactNode;
  /** Quando presente, o campo entra em estado de erro e a mensagem é anunciada. */
  readonly error?: string;
}

/**
 * Campo de formulário com rótulo, apoio e erro sempre ligados por `id`.
 *
 * Rótulo solto ao lado do campo é invisível para leitor de tela. Aqui a
 * associação é estrutural, não uma convenção que alguém pode esquecer:
 * `aria-describedby` aponta para o apoio e para o erro, e o erro vai num
 * `role="alert"` para ser lido assim que aparece.
 */
export function Field({ label, hint, error, ...rest }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>

      <input
        {...rest}
        id={id}
        className="ui-field__input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />

      {hint ? (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}

      {error ? (
        <p className="ui-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const fieldCss = `
.ui-field { display: flex; flex-direction: column; gap: var(--space-2); }

.ui-field__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
}

.ui-field__input {
  min-height: var(--size-touch);
  padding: 0 var(--space-3);
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  /* 16px evita o zoom automático do iOS ao focar o campo. */
  font-size: var(--font-size-base);
  font-family: inherit;
}

.ui-field__input[aria-invalid='true'] { border-color: var(--color-danger); }

.ui-field__hint { margin: 0; font-size: var(--font-size-sm); color: var(--color-text-muted); }
.ui-field__error { margin: 0; font-size: var(--font-size-sm); color: var(--color-danger); }
`;
