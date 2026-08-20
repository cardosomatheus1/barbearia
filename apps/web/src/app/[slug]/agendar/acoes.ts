'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE_DA_ORIGEM } from '@barbearia/core';
import { criarAgendamentoNaApi, entrarNaEsperaNaApi } from '@/lib/api';

/**
 * Confirma o agendamento.
 *
 * Server action: o formulário funciona mesmo sem JavaScript, que é o caso de
 * uma parte real do público em rede móvel instável.
 *
 * O corpo carrega só o que o cliente escolheu. Preço, duração e buffers vêm do
 * catálogo no servidor — aceitar preço vindo do formulário deixaria o cliente
 * decidir quanto paga.
 */
export async function criarAgendamento(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const start = String(form.get('start') ?? '');
  const date = String(form.get('date') ?? '');
  const serviceIds = String(form.get('serviceIds') ?? '').split(',').filter(Boolean);
  const professionalId = String(form.get('professionalId') ?? '');

  // Volta para o **passo 4**, com tudo preenchido. Sem o marcador `e` a página
  // recomeça do passo 1 e a mensagem de erro nunca aparece.
  const retorno = new URLSearchParams({
    s: serviceIds.join(','),
    p: professionalId,
    d: date,
    h: start,
    e: 'd',
  });

  /**
   * O carimbo da origem é lido do **cookie**, nunca do formulário.
   *
   * Um campo escondido no HTML seria escrito pela mesma página que o cliente
   * controla, e ele decidiria sozinho que a barbearia deve comissão. O cookie é
   * `httpOnly` e por caminho da barbearia: quem o coloca é a porta `/ir/{slug}`,
   * do lado do servidor.
   *
   * O valor vai **inteiro** para a API, que é quem confere a assinatura. Esta
   * camada não valida nada: um carimbo forjado aqui não seria detectado, e a
   * checagem tem que estar na borda que decide dinheiro.
   */
  const origem = (await cookies()).get(`${COOKIE_DA_ORIGEM}_${slug}`)?.value;

  const resultado = await criarAgendamentoNaApi(slug, {
    ...(origem ? { origem } : {}),
    locationId: String(form.get('locationId') ?? ''),
    professionalId,
    serviceIds,
    date,
    start,
    name: String(form.get('name') ?? '').trim(),
    phone: String(form.get('phone') ?? '').trim(),
  });

  if (!resultado.ok) {
    /**
     * O código que vai para a URL não cita o mecanismo (bloco 60).
     *
     * `?erro=score_no_pico` fica no histórico do navegador, no autocompletar e
     * em qualquer referrer que a página gere — uma frase visível dizendo que um
     * *score* julgou a pessoa numa hora de *pico*.
     *
     * A troca deixou de morar aqui: ela vale para **toda** superfície da API,
     * e não só para a que passa por esta tela. A API já entrega `so_recepcao`
     * (`apps/api/src/common/booking-http.ts`), e repetir a regra nesta linha
     * seria a segunda cópia dela — que é como uma das duas fica para trás.
     */
    retorno.set('erro', resultado.code);
    redirect(`/${slug}/agendar?${retorno.toString()}`);
  }

  // Só o id: a tela de confirmação lê o agendamento da API. Data e hora na URL
  // seriam uma segunda fonte, e ela mentiria se o horário mudasse.
  redirect(`/${slug}/agendado/${resultado.id}`);
}

/**
 * Entra na lista de espera (bloco 38).
 *
 * Volta para a **mesma tela vazia** de onde saiu, com o resultado na URL: a
 * pessoa acabou de descobrir que não há horário, e mandá-la para outro lugar
 * depois de pedir o aviso a faria perder o contexto do que acabou de fazer.
 */
export async function acaoEntrarNaEspera(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const serviceIds = form.getAll('serviceIds').map(String).filter(Boolean);
  const professionalId = String(form.get('professionalId') ?? 'any');
  const de = String(form.get('de') ?? '');

  const retorno = new URLSearchParams({
    s: serviceIds.join(','),
    p: professionalId,
    d: de,
    e: 'h',
  });

  const resultado = await entrarNaEsperaNaApi(slug, {
    locationId: String(form.get('locationId') ?? ''),
    serviceIds,
    professionalId,
    de,
    ate: String(form.get('ate') ?? ''),
    inicio: String(form.get('inicio') ?? ''),
    fim: String(form.get('fim') ?? ''),
    name: String(form.get('name') ?? '').trim(),
    phone: String(form.get('phone') ?? '').trim(),
  });

  retorno.set(resultado.ok ? 'espera' : 'erroEspera', resultado.ok ? '1' : resultado.code);
  redirect(`/${slug}/agendar?${retorno.toString()}`);
}
