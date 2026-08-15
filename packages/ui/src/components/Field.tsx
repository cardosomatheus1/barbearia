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
/*
 * min-width: 0 no campo e no controle, e é o piso do design system — não um
 * conserto local.
 *
 * Item de grade e de flex tem piso de min-content, e o min-content de um
 * select é a **opção mais comprida** que ele carrega. Uma barbearia chamada
 * "Barbearia com nome bem comprido de teste" fazia a coluna nascer com 391px
 * dentro de uma tela de 360, e a página inteira rolava de lado.
 *
 * Havia seis min-width: 0 escritos à mão em globals.css, um por formulário que
 * já tinha sofrido isso — a lista que ninguém atualiza. Aqui, o formulário do
 * bloco que vier daqui a dez já nasce coberto.
 *
 * Sem crase: isto é o conteúdo de um template literal, e a crase o fecha.
 */
.ui-field { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }

/*
 * O mesmo piso para fieldset, e ele precisa de linha própria.
 *
 * O navegador dá a todo fieldset um min-inline-size: min-content que
 * min-width: 0 não desfaz — é regra do estilo do próprio navegador, não do
 * layout. Então um fieldset se recusa a encolher abaixo do conteúdo mais
 * comprido que carrega, e o conteúdo mais comprido de um formulário costuma
 * ser a opção de um select.
 *
 * Foi o que estourou a tela de campanha no celular assim que ela ganhou
 * fieldset/legend para separar os três passos: os campos lá dentro já tinham o
 * min-width: 0 acima, e a caixa em volta deles é que não encolhia. A página
 * inteira passou a rolar de lado, com o texto de ajuda cortado na direita.
 *
 * Aqui e não em globals.css pelo mesmo motivo da regra acima: o formulário do
 * bloco que vier daqui a dez já nasce coberto.
 *
 * Sem crase: isto é o conteúdo de um template literal, e a crase o fecha.
 */
fieldset { min-inline-size: 0; }

.ui-field__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
}

.ui-field__input {
  min-height: var(--size-touch);
  min-width: 0;
  max-width: 100%;
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
