'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

interface BotaoDeEnvioProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> {
  readonly children: ReactNode;
  readonly enviando?: ReactNode;
}

/**
 * Botão de submit com estado de envio, sem trocar a semântica do formulário.
 *
 * Sem JavaScript ele continua sendo um `<button type="submit">` normal. Com
 * hidratação, `useFormStatus` desabilita só o formulário que está em trânsito:
 * o segundo toque não dispara outra Server Action enquanto o primeiro POST
 * ainda não terminou, e a pessoa vê que o toque foi aceito em vez de tocar de
 * novo numa rede lenta.
 *
 * Isto é UX defensiva, não substituto de idempotência no servidor. Operações
 * que movimentam dinheiro continuam carregando a chave própria do domínio.
 */
export function BotaoDeEnvio({
  children,
  enviando = 'Salvando…',
  disabled,
  ...props
}: BotaoDeEnvioProps) {
  const { pending } = useFormStatus();
  const bloqueado = disabled === true || pending;

  return (
    <button
      {...props}
      aria-busy={pending || undefined}
      aria-disabled={bloqueado || undefined}
      disabled={bloqueado}
      type="submit"
    >
      {pending ? enviando : children}
    </button>
  );
}
