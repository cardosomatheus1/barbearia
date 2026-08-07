import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';
import { Field } from './Field.js';
import { Alert, SkipLink, VisuallyHidden } from './primitives.js';

/**
 * Testes de comportamento, não de markup (CLAUDE.md §1).
 *
 * As consultas são por papel e por texto acessível — as mesmas afordâncias que
 * um leitor de tela usa. Um teste que casa com classe CSS quebraria a cada
 * mudança visual sem detectar nenhuma regressão real.
 */

describe('Button', () => {
  it('é alcançável pelo papel e pelo texto', () => {
    render(<Button>Agendar horário</Button>);
    expect(screen.getByRole('button', { name: 'Agendar horário' })).toBeDefined();
  });

  it('não envia o formulário por acidente', () => {
    // O padrão do HTML é `type="submit"`; dentro de um formulário isso faz
    // qualquer botão enviar sem querer.
    render(<Button>Voltar</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('dispara o clique quando ativo', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Confirmar</Button>);

    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('carregando: não dispara e continua focável', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Confirmar</Button>);

    const button = screen.getByRole('button');
    await userEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    // `disabled` tiraria o botão da ordem de tabulação e do anúncio do leitor,
    // fazendo o usuário perder o contexto no meio da ação.
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('carregando: anuncia o estado por texto, não só por atributo', () => {
    render(<Button loading loadingLabel="Agendando">Agendar</Button>);
    expect(screen.getByRole('button').textContent).toContain('Agendando');
  });

  it('aria-disabled também barra o clique', async () => {
    const onClick = vi.fn();
    render(
      <Button aria-disabled onClick={onClick}>
        Indisponível
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('é acionável por teclado', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Confirmar</Button>);

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button'));
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Field', () => {
  it('liga rótulo e campo — clicar no rótulo foca o campo', async () => {
    render(<Field label="Celular (WhatsApp)" />);

    const input = screen.getByLabelText('Celular (WhatsApp)');
    await userEvent.click(screen.getByText('Celular (WhatsApp)'));
    expect(document.activeElement).toBe(input);
  });

  it('gera identificadores distintos para campos repetidos', () => {
    render(
      <>
        <Field label="Nome" />
        <Field label="Celular" />
      </>,
    );
    const nome = screen.getByLabelText('Nome');
    const celular = screen.getByLabelText('Celular');
    expect(nome.id).not.toBe(celular.id);
    expect(nome.id).toBeTruthy();
  });

  it('descreve o campo com o texto de apoio', () => {
    render(<Field label="Celular" hint="Ex.: (71) 98888-7777" />);

    const input = screen.getByLabelText('Celular');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy)?.textContent).toBe('Ex.: (71) 98888-7777');
  });

  it('erro é marcado, descrito e anunciado', () => {
    render(<Field label="Celular" error="Por favor, digite o ddd e telefone" />);

    const input = screen.getByLabelText('Celular');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Por favor, digite o ddd e telefone');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('apoio e erro convivem, ambos descrevendo o campo', () => {
    render(<Field label="Celular" hint="Com DDD" error="Número inválido" />);

    const ids = (screen.getByLabelText('Celular').getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
  });

  it('sem erro não existe alerta na tela', () => {
    render(<Field label="Celular" />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('primitivas', () => {
  it('VisuallyHidden mantém o texto legível para o leitor de tela', () => {
    render(<VisuallyHidden>Preço</VisuallyHidden>);
    // Presente na árvore: sumir com `display: none` esconderia de todo mundo.
    expect(screen.getByText('Preço')).toBeDefined();
  });

  it('SkipLink aponta para o conteúdo principal', () => {
    render(<SkipLink />);
    const link = screen.getByRole('link', { name: 'Pular para o conteúdo' });
    expect(link.getAttribute('href')).toBe('#conteudo');
  });

  it('Alert de erro interrompe; os demais aguardam a pausa', () => {
    const { unmount } = render(<Alert tone="danger">Horário indisponível</Alert>);
    expect(screen.getByRole('alert').textContent).toBe('Horário indisponível');
    unmount();

    render(<Alert tone="success">Agendamento concluído</Alert>);
    expect(screen.getByRole('status').textContent).toBe('Agendamento concluído');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
