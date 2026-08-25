'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import estilos from './busca-global.module.css';
import { filtrarDestinos, normalizarBusca, type DestinoDaBuscaGlobal } from '@/lib/busca-global';

export type { DestinoDaBuscaGlobal } from '@/lib/busca-global';

interface ClienteDaBusca {
  readonly id: string;
  readonly name: string;
  readonly phoneMasked: string;
  readonly lastVisitAt: string | null;
}

interface AgendamentoDaBusca {
  readonly id: string;
  readonly date: string;
  readonly start: string;
  readonly customerName: string;
  readonly professionalName: string;
  readonly services: readonly string[];
  readonly href: string;
}

interface RespostaDaBusca {
  readonly clientes: readonly ClienteDaBusca[];
  readonly agendamentos: readonly AgendamentoDaBusca[];
}

export function BuscaGlobal({ destinos }: { readonly destinos: readonly DestinoDaBuscaGlobal[] }) {
  const [aberta, setAberta] = useState(false);
  const [consulta, setConsulta] = useState('');
  const [remoto, setRemoto] = useState<RespostaDaBusca>({ clientes: [], agendamentos: [] });
  const [carregando, setCarregando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const dialogo = useRef<HTMLElement>(null);
  const gatilho = useRef<HTMLButtonElement>(null);
  const ultimoFoco = useRef<HTMLElement | null>(null);

  const abrir = useCallback(() => {
    ultimoFoco.current = document.activeElement instanceof HTMLElement ? document.activeElement : gatilho.current;
    setAberta(true);
  }, []);

  const fechar = useCallback(() => {
    setAberta(false);
    setConsulta('');
    setRemoto({ clientes: [], agendamentos: [] });
    const destino = ultimoFoco.current ?? gatilho.current;
    window.requestAnimationFrame(() => destino?.focus());
  }, []);

  useEffect(() => {
    const atalho = (evento: KeyboardEvent) => {
      if ((evento.ctrlKey || evento.metaKey) && evento.key.toLowerCase() === 'k') {
        evento.preventDefault();
        abrir();
      }
    };
    window.addEventListener('keydown', atalho);
    return () => window.removeEventListener('keydown', atalho);
  }, [abrir]);

  useEffect(() => {
    if (!aberta) return;

    const id = window.requestAnimationFrame(() => campo.current?.focus());
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const aoTeclado = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') {
        evento.preventDefault();
        fechar();
        return;
      }
      if (evento.key !== 'Tab') return;

      const foco = dialogo.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!foco || foco.length === 0) return;

      const primeiro = foco[0]!;
      const ultimo = foco[foco.length - 1]!;
      if (evento.shiftKey && document.activeElement === primeiro) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault();
        primeiro.focus();
      }
    };

    document.addEventListener('keydown', aoTeclado);
    return () => {
      window.cancelAnimationFrame(id);
      document.removeEventListener('keydown', aoTeclado);
      document.body.style.overflow = overflowAnterior;
    };
  }, [aberta, fechar]);

  useEffect(() => {
    if (!aberta || normalizarBusca(consulta).length < 3) {
      setRemoto({ clientes: [], agendamentos: [] });
      setCarregando(false);
      return;
    }

    const controle = new AbortController();
    const timer = window.setTimeout(async () => {
      setCarregando(true);
      try {
        const resposta = await fetch(`/admin/busca?q=${encodeURIComponent(consulta.trim())}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controle.signal,
        });
        if (!resposta.ok) {
          setRemoto({ clientes: [], agendamentos: [] });
          return;
        }
        setRemoto((await resposta.json()) as RespostaDaBusca);
      } catch (erro) {
        if (!(erro instanceof DOMException && erro.name === 'AbortError')) {
          setRemoto({ clientes: [], agendamentos: [] });
        }
      } finally {
        if (!controle.signal.aborted) setCarregando(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controle.abort();
    };
  }, [aberta, consulta]);

  const locais = useMemo(() => {
    return filtrarDestinos(destinos, consulta, 6);
  }, [consulta, destinos]);

  const temResultado = locais.length + remoto.clientes.length + remoto.agendamentos.length > 0;

  return (
    <>
      <button
        aria-controls="busca-global-dialogo"
        aria-expanded={aberta}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        className={estilos.gatilho}
        onClick={abrir}
        ref={gatilho}
        type="button"
      >
        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
          <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.7" />
          <path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
        </svg>
        <span>Buscar</span>
        <kbd>⌘K</kbd>
      </button>

      {aberta ? (
        <div className={estilos.fundo} onMouseDown={(evento) => evento.target === evento.currentTarget && fechar()}>
          <section aria-label="Busca global" aria-modal="true" className={estilos.dialogo} id="busca-global-dialogo" ref={dialogo} role="dialog">
            <div className={estilos.cabecalho}>
              <svg aria-hidden="true" fill="none" height="19" viewBox="0 0 24 24" width="19">
                <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.7" />
                <path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
              </svg>
              <input
                aria-label="Buscar cliente, agendamento ou função"
                autoComplete="off"
                onChange={(evento) => setConsulta(evento.target.value)}
                placeholder="Cliente, agendamento ou função…"
                ref={campo}
                value={consulta}
              />
              <button aria-label="Fechar busca" className={estilos.fechar} onClick={fechar} type="button">Esc</button>
            </div>

            <div aria-live="polite" className={estilos.resultados}>
              {locais.length > 0 ? (
                <Grupo titulo="Ir para">
                  {locais.map((destino) => (
                    <a className={estilos.resultado} href={destino.href} key={destino.href} onClick={fechar}>
                      <span className={estilos.icone}>↗</span>
                      <span className={estilos.corpo}>
                        <strong>{destino.nome}</strong>
                        <small>{destino.modulo} · {destino.nota}</small>
                      </span>
                    </a>
                  ))}
                </Grupo>
              ) : null}

              {remoto.clientes.length > 0 ? (
                <Grupo titulo="Clientes">
                  {remoto.clientes.map((cliente) => (
                    <a className={estilos.resultado} href={`/admin/cliente/${cliente.id}`} key={cliente.id} onClick={fechar}>
                      <span className={estilos.icone}>●</span>
                      <span className={estilos.corpo}>
                        <strong>{cliente.name}</strong>
                        <small>{cliente.phoneMasked}{cliente.lastVisitAt ? ' · cliente recente' : ''}</small>
                      </span>
                    </a>
                  ))}
                </Grupo>
              ) : null}

              {remoto.agendamentos.length > 0 ? (
                <Grupo titulo="Hoje">
                  {remoto.agendamentos.map((agenda) => (
                    <a className={estilos.resultado} href={agenda.href} key={agenda.id} onClick={fechar}>
                      <time className={`${estilos.icone} ${estilos.hora}`}>{agenda.start}</time>
                      <span className={estilos.corpo}>
                        <strong>{agenda.customerName}</strong>
                        <small>{agenda.services.join(' + ')} · {agenda.professionalName}</small>
                      </span>
                    </a>
                  ))}
                </Grupo>
              ) : null}

              {carregando ? <p className={estilos.estado}>Buscando na casa…</p> : null}
              {!carregando && consulta.trim().length >= 3 && !temResultado ? (
                <p className={estilos.estado}>Nada encontrado com “{consulta.trim()}”.</p>
              ) : null}
              {!consulta.trim() ? (
                <p className={estilos.dica}>Digite ao menos 3 caracteres para procurar pessoas e horários. Funções aparecem desde a primeira letra.</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function Grupo({ titulo, children }: { readonly titulo: string; readonly children: ReactNode }) {
  return (
    <section className={estilos.grupo}>
      <h2>{titulo}</h2>
      <div>{children}</div>
    </section>
  );
}
