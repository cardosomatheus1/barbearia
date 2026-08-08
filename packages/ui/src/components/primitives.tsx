import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Conteúdo lido por leitor de tela e invisível na tela.
 *
 * `display: none` some para todo mundo, inclusive para quem depende do leitor.
 * O recorte abaixo mantém o texto na árvore de acessibilidade.
 */
export function VisuallyHidden({ children }: { readonly children: ReactNode }) {
  return <span className="ui-visually-hidden">{children}</span>;
}

/**
 * Atalho para pular a navegação e ir direto ao conteúdo.
 *
 * Só aparece ao receber foco. Sem ele, quem usa teclado percorre o cabeçalho
 * inteiro em toda página.
 */
export function SkipLink({ targetId = 'conteudo' }: { readonly targetId?: string }) {
  return (
    <a className="ui-skip-link" href={`#${targetId}`}>
      Pular para o conteúdo
    </a>
  );
}

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  readonly children: ReactNode;
}

export function Card({ children, ...rest }: CardProps) {
  return (
    <div {...rest} className="ui-card">
      {children}
    </div>
  );
}

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

/**
 * Mensagem para o usuário.
 *
 * Erro entra como `role="alert"` (interrompe e é lido na hora); o resto como
 * `role="status"` (aguarda uma pausa). Anunciar aviso informativo com a mesma
 * urgência de erro treina o usuário a ignorar os dois.
 */
export function Alert({
  tone = 'info',
  children,
}: {
  readonly tone?: AlertTone;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`ui-alert ui-alert--${tone}`}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

export const primitivesCss = `
.ui-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.ui-skip-link {
  position: absolute;
  left: var(--space-3);
  top: calc(var(--space-3) * -10);
  z-index: var(--z-toast);
  padding: var(--space-3) var(--space-4);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  border-radius: var(--radius-md);
  text-decoration: none;
  transition: top var(--motion-fast) var(--motion-ease);
}
.ui-skip-link:focus { top: var(--space-3); }

/* O degradê é de cima para baixo e curto de propósito: dá a impressão de luz
   vindo de cima, que é o que separa um painel de um retângulo pintado. Sem ele
   trinta telas de cartão chapado parecem um formulário, e foi essa a
   reclamação. Não é decoração solta: .quadro, .numero e .evento usam o mesmo
   par de tokens, então cartão e painel pertencem à mesma superfície.
   (Sem crase aqui — este CSS mora dentro de um template literal, e a crase o
   fecharia. É o mesmo tropeço que a guarda de SQL já pega em consulta.) */
.ui-card {
  background: linear-gradient(180deg, var(--color-surface-hover), var(--color-surface-raised));
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
}

.ui-alert {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border-left: 3px solid currentColor;
  background: var(--color-surface-raised);
  font-size: var(--font-size-sm);
}
.ui-alert--info { color: var(--color-text-primary); }
.ui-alert--success { color: var(--color-success); }
.ui-alert--warning { color: var(--color-warning); }
.ui-alert--danger { color: var(--color-danger); }
`;
