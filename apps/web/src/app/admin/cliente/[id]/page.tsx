import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  CONVERSAS,
  type Conversa,
  destaquesDaFicha,
  fichaEstaVazia,
  fraseDaConversa,
  podeTudo,
  ESTADO_TRATADA,
  ROTULO_DA_ASSINATURA,
  ROTULO_DO_PACOTE,
  ROTULO_DO_SEGMENTO,
  corpoComExemplos,
  saldoPorExtenso,
  type Segmento,
  nomeDoAviso,
} from '@barbearia/core';
import {
  confiancaDoCliente,
  saldoDeFidelidade,
  pacotesDoClienteNaApi,
  fiadoDoClienteNaApi,
  resumoFinanceiroDoClienteNaApi,
  avaliacoesDoClienteNaApi,
  assinaturaDoClienteNaApi,
  planosNaApi,
  dependentesNaApi,
  type DependenteNaTela,
  type AssinaturaDoCliente,
  type PlanoNaTela,
  type AvaliacaoNaTela,
  type PacoteDoCliente,
  type SaldoDeFidelidade,
  consentimentosDaFicha,
  fotosDoClienteNaApi,
  templatesDoWhatsAppNaApi,
  fichaDoCliente,
  type ConfiancaDoCliente,
  type ConsentimentosNaFicha,
  type FotoNaFicha,
  type VisitaNaFicha,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { lerMotivoDaMeta, lerSessaoGestor } from '@/lib/sessao-gestor';
import { CONSENTIMENTOS_OPCIONAIS } from '@/lib/politica';
import {
  acaoAbrirPedidoDeDados,
  acaoAnonimizarCliente,
  acaoAjustarFidelidade,
  acaoConfiancaDoCliente,
  acaoApagarFoto,
  acaoConsentimentoNoBalcao,
  acaoPublicarFoto,
  acaoRegistrarFoto,
  acaoPreferencias,
  acaoAbrirComanda,
  acaoAssinar,
  acaoAgendarCancelamento,
  acaoCancelarAssinatura,
  acaoDesfazerCancelamento,
  acaoIncluirDependente,
  acaoRemoverDependente,
  acaoReembolsarPacote,
  acaoTransferirPacote,
  acaoDefinirLimiteDeFiado,
  acaoLancarSaldoInicialDeFiado,
  acaoSair,
} from '../../acoes';
import { secao } from '../../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { marcaDaRecusa } from '../../falha-da-leitura';
import {
  Apagar,
  Assinatura,
  Avaliacoes,
  Confianca,
  Consentimentos,
  DireitosDoTitular,
  Fiado,
  Fidelidade,
  Fotos,
  MandarMensagem,
  Pacotes,
  Visita,
} from './componentes';

/**
 * A ficha do cliente — SPEC §4.1 e §4.3.
 *
 * "A tela que o barbeiro abre antes de atender." Ela responde duas perguntas
 * na ordem em que elas aparecem na cadeira: **como esta pessoa gosta de ser
 * atendida** e **como ela vem sendo atendida**.
 *
 * O que evitar vem primeiro apesar de ser o campo menos preenchido. É o único
 * cuja falha machuca: alergia a pós-barba com álcool lida depois da navalha não
 * serviu para nada.
 *
 * A anotação aparece com **quem escreveu e quando**. Ninguém confia numa
 * anotação sem dono — "não usar navalha" escrito por quem saiu há dois anos
 * vale menos que o de ontem, e é o barbeiro quem decide isso, não a tela.
 */

export const metadata: Metadata = {
  title: 'Ficha do cliente',
  robots: { index: false, follow: false },
};

interface Props {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

type AbaDaFicha = 'visao' | 'historico' | 'fidelidade' | 'financeiro';

function abaSegura(valor: string | undefined): AbaDaFicha {
  return valor === 'historico' || valor === 'fidelidade' || valor === 'financeiro' ? valor : 'visao';
}

const ABAS_DA_FICHA: readonly { chave: AbaDaFicha; rotulo: string }[] = [
  { chave: 'visao', rotulo: 'Visão geral' },
  { chave: 'historico', rotulo: 'Histórico' },
  { chave: 'fidelidade', rotulo: 'Fidelidade' },
  { chave: 'financeiro', rotulo: 'Financeiro' },
];

const FALHA: Record<string, string> = {
  cliente_nao_encontrado: 'Este cliente não existe mais.',
  // A mensagem avulsa (bloco 92). "Não saiu" não é falha nossa: são as guardas
  // de consentimento, teto e janela de silêncio, e o motivo vem logo abaixo.
  nao_saiu: 'A mensagem não saiu.',
  sem_canal: 'O WhatsApp da casa ainda não está ligado, então nada chega ao cliente.',
  sem_texto_aprovado: 'Não há texto aprovado para este aviso.',
  tipo_invalido: 'Este texto fala de um horário marcado e não serve para mensagem avulsa.',
  confirmacao_invalida: 'Para apagar, digite APAGAR no campo de confirmação.',
  forbidden_anonimizar: 'Sua conta não apaga dados de cliente.',
  preferencia_invalida: 'Escolha uma das opções de conversa.',
  forbidden: 'Sua conta não vê as anotações dos clientes.',
  invalid_request: 'Confira os campos: alguma anotação ficou longa demais.',
  // A assinatura (blocos 45 a 47).
  assinatura_nao_encontrada: 'Esta assinatura já foi cancelada ou não tem saída agendada.',
  ja_assina: 'Este cliente já tem um plano. Cancele o atual para trocar.',
  e_o_titular: 'Ele já é o titular deste plano.',
  ja_e_dependente: 'Esta pessoa já usa a cota de outro plano.',
  request_failed: 'Não deu para carregar. Tente de novo.',
};


/**
 * Total sobre a união, e não `Record<string, string>`.
 *
 * A tela já deriva as opções de `CONVERSAS`; só o rótulo era escrito à mão, e
 * sem `??` de rede: uma quarta preferência no domínio desenharia um rádio com o
 * `<span>` **vazio** ao lado. Total, o compilador cobra a frase antes.
 */
const ROTULO_DA_CONVERSA: Readonly<Record<Conversa, string>> = {
  silencioso: 'Silêncio',
  indiferente: 'Tanto faz',
  conversa: 'Conversa',
};

const dinheiro = (centavos: number): string =>
  `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

function dia(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    .format(new Date(iso));
}


export default async function FichaPage({ params, searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const { id } = await params;
  const query = await searchParams;
  const aba = abaSegura(first(query['aba']));
  const erro = first(query['erro']);
  const motivo = erro ? await lerMotivoDaMeta() : null;
  const salvo = first(query['salvo']) === '1';
  // Origem fechada: a ficha não aceita URL arbitrária no retorno. Depois do V1,
  // Clientes é a porta padrão; Meu Dia/Dia só sobrevivem quando a própria tela
  // de origem os declarou.
  const origem = first(query['de']) === 'meu-dia' ? 'meu-dia' : first(query['de']) === 'dia' ? 'dia' : 'clientes';
  const voltar = origem === 'meu-dia' ? '/admin/meu-dia' : origem === 'dia' ? '/admin/dia' : '/admin/clientes';

  const pediu = first(query['pedido']) === '1';
  // Sinal próprio, e não `salvo=1`: reaproveitá-lo faria a tela dizer "Anotação
  // salva" depois de ajustar quem paga sinal. Aviso que fala de outra coisa é o
  // mesmo defeito de duas telas discordando (CLAUDE.md §6).
  const ajustou = first(query['ajuste']) === '1';
  // Sinal próprio pelo mesmo motivo do ajuste de sinal: "Anotação salva" depois
  // de mexer no limite de fiado é a tela falando de outra coisa.
  const salvoFiado = first(query['salvo']);

  // As duas leituras juntas: são independentes, e encadeá-las somaria a
  // latência de uma na outra numa tela que o barbeiro abre com o cliente
  // sentado.
  const veSinal = estado.staff.permissions.includes('finance.deposit');
  // O saldo é dinheiro, e a rota exige as duas permissões que ela devolve.
  const veSaldo =
    estado.staff.permissions.includes('finance.view') &&
    estado.staff.permissions.includes('customers.view');
  const veClube = estado.staff.permissions.includes('finance.subscription_manage');
  // Ver foto é permissão própria e a rota audita a leitura: pedir sem ela
  // devolveria 403 em toda abertura de ficha da recepção, e encheria a trilha.
  /** Mandar mensagem é `marketing.send`; a lista de textos é `whatsapp.manage`. */
  const podeMandar =
    estado.staff.permissions.includes('marketing.send') &&
    estado.staff.permissions.includes('whatsapp.manage');
  const veFotos = estado.staff.permissions.includes('customers.view_photos');
  // V2: a aba é também fronteira de leitura. `hidden` sozinho só esconderia
  // HTML depois de já consultar WhatsApp, fotos, clube e dinheiro em toda
  // abertura da ficha. Cada área busca apenas o que pode desenhar.
  const visaoAtiva = aba === 'visao';
  const historicoAtivo = aba === 'historico';
  const fidelidadeAtiva = aba === 'fidelidade';
  const financeiroAtivo = aba === 'financeiro';
  const [ficha, consentimentos, confianca, fidelidade, pacotes, avaliacoes, assinatura, planosDoClube, fiado, resumoFinanceiro, fotos, textos] =
    await Promise.all([
      fichaDoCliente(token, id),
      visaoAtiva ? consentimentosDaFicha(token, id) : Promise.resolve(null),
      financeiroAtivo && veSinal ? confiancaDoCliente(token, id) : Promise.resolve(null),
      fidelidadeAtiva && veSaldo ? saldoDeFidelidade(token, id) : Promise.resolve(null),
      fidelidadeAtiva && veSaldo ? pacotesDoClienteNaApi(token, id) : Promise.resolve(null),
      historicoAtivo && estado.staff.permissions.includes('reviews.view')
        ? avaliacoesDoClienteNaApi(token, id)
        : Promise.resolve(null),
      fidelidadeAtiva && veSaldo ? assinaturaDoClienteNaApi(token, id) : Promise.resolve(null),
      fidelidadeAtiva && veClube ? planosNaApi(token) : Promise.resolve(null),
      financeiroAtivo && veSaldo ? fiadoDoClienteNaApi(token, id) : Promise.resolve(null),
      veSaldo ? resumoFinanceiroDoClienteNaApi(token, id) : Promise.resolve(null),
      visaoAtiva && veFotos ? fotosDoClienteNaApi(token, id) : Promise.resolve(null),
      visaoAtiva && podeMandar ? templatesDoWhatsAppNaApi(token) : Promise.resolve(null),
    ]);

  /**
   * Os dependentes vêm numa segunda ida, e de propósito.
   *
   * Só existem quando a pessoa **tem** assinatura, e a maioria não tem — pedi-los
   * junto seria uma chamada a mais em toda abertura de ficha para responder uma
   * pergunta que quase nunca é feita.
   */
  const familia =
    veClube && assinatura?.ok && assinatura.dados.assinatura
      ? await dependentesNaApi(token, assinatura.dados.assinatura.id)
      : null;

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href={voltar}>
        ← {estado.businessName}
      </a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  if (!ficha.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('cliente')}>
        {topo}
        <h1 className="painel__titulo">Ficha</h1>
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(ficha.code)}>
          {FALHA[ficha.code] ?? FALHA['request_failed']}
          <a className="ui-button ui-button--secondary painel__saida" href={voltar}>
            Voltar
          </a>
        </div>
      </main>
    );
  }

  const { preferencias, linhaDoTempo } = ficha.dados;
  const destaques = destaquesDaFicha(preferencias);
  const conversa = fraseDaConversa(preferencias.conversa);
  const vazia = fichaEstaVazia(preferencias);
  // O cabeçalho promete o acumulado da relação inteira. A timeline é limitada
  // às dez ocorrências mais recentes, então nunca pode ser usada para este total.
  const totalGastoCents = resumoFinanceiro?.ok ? resumoFinanceiro.dados.gastoTotalCents : null;

  return (
    <main className="ui-container painel__conteudo" {...secao('cliente')}>
      {topo}

      <section className="cliente-cabecalho" data-nivel="primario">
        <div className="cliente-cabecalho__identidade">
          <div>
            <h1 className="painel__titulo">{ficha.dados.nome}</h1>
            <p className="painel__sub">
              {ficha.dados.desde ? `Cliente desde ${dia(ficha.dados.desde)}` : 'Cliente da casa'}
              {ficha.dados.telefoneFinal ? ` · final ${ficha.dados.telefoneFinal}` : ''}
            </p>
          </div>
          <div className="cliente-cabecalho__metricas" aria-label="Resumo do relacionamento">
            <span><strong className="tabular">{ficha.dados.visitas}</strong> visitas</span>
            {totalGastoCents !== null ? <span><strong className="tabular">{reais(totalGastoCents)}</strong> no total</span> : null}
          </div>
        </div>

        <div className="cliente-cabecalho__segmento">
          <span className={`ritmo__selo ritmo__selo--${ficha.dados.segmento}`}>
            {ROTULO_DO_SEGMENTO[ficha.dados.segmento as Segmento] ?? ficha.dados.segmento}
          </span>
          <span>{ficha.dados.explicacaoDoSegmento}</span>
        </div>

        <nav aria-label="Ações deste cliente" className="cliente-acoes-contexto">
          {estado.staff.permissions.includes('appointments.create') ? (
            <a className="ui-button ui-button--primary" href={`/admin/dia/marcar?c=${encodeURIComponent(id)}&cn=${encodeURIComponent(ficha.dados.nome)}`}>Agendar</a>
          ) : null}
          {podeMandar ? (
            <a className="ui-button ui-button--secondary" href={`/admin/cliente/${encodeURIComponent(id)}?aba=visao&de=${origem}#mandar-mensagem`}>WhatsApp</a>
          ) : null}
          {estado.staff.permissions.includes('cashier.open') ? (
            <form action={acaoAbrirComanda}>
              <input name="customerId" type="hidden" value={ficha.dados.customerId} />
              <input name="idempotencyKey" type="hidden" value={randomUUID()} />
              <button className="ui-button ui-button--secondary" type="submit">Nova comanda</button>
            </form>
          ) : null}
        </nav>
      </section>

      <nav aria-label="Seções da ficha" className="cliente-abas">
        {ABAS_DA_FICHA.map((item) => (
          <a
            aria-current={aba === item.chave ? 'page' : undefined}
            className={aba === item.chave ? 'cliente-abas__item cliente-abas__item--ativo' : 'cliente-abas__item'}
            href={`/admin/cliente/${encodeURIComponent(id)}?aba=${item.chave}&de=${origem}`}
            key={item.chave}
          >
            {item.rotulo}
          </a>
        ))}
      </nav>

      <section className="cliente-resumo" data-nivel="contexto" aria-label="Resumo do cliente">
        <div><span className="cliente-resumo__rotulo">Preferências</span><strong>{destaques[0]?.valor ?? conversa ?? 'Ainda não anotadas'}</strong></div>
        <div><span className="cliente-resumo__rotulo">Ritmo</span><strong>{ficha.dados.cicloDias !== null ? `volta a cada ${ficha.dados.cicloDias} dias` : 'ainda sem padrão'}</strong></div>
        <div><span className="cliente-resumo__rotulo">Última visita</span><strong>{ficha.dados.ultimaVisita ? dia(ficha.dados.ultimaVisita) : 'primeira visita'}</strong></div>
      </section>

      <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso">
        {/* Quando a mensagem não saiu, o motivo é a informação inteira: as
            quatro razões legítimas — revogou o marketing, já recebeu hoje,
            teto do mês, janela de silêncio — não são erro, e sem a frase o
            balcão aperta de novo achando que falhou. */}
        {motivo ? <p className="whatsapp__motivo">{motivo}</p> : null}
      </AvisoDeRecusa>

      {first(query['feito']) === 'mensagem' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Mensagem enviada pelo WhatsApp da casa.
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Anotação salva.
        </div>
      ) : null}

      {ajustou ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Ajuste salvo. O motivo ficou na trilha.
        </div>
      ) : null}

      {salvoFiado === 'limite' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Limite salvo. A partir de agora a comanda deixa fiar até esse valor.
        </div>
      ) : null}

      {salvoFiado === 'pacote-transferido' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Pacote passado adiante. As unidades que sobravam agora são da outra pessoa.
        </div>
      ) : null}

      {salvoFiado === 'saldo-inicial' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Saldo lançado no extrato, com o motivo. Ele aparece em{' '}
          <a href="/admin/fiado">Pendências</a>.
        </div>
      ) : null}

      {pediu ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Pedido registrado. Ele vence em 15 dias e aparece em{' '}
          <a href="/admin/lgpd">Pedidos de dados</a>.
        </div>
      ) : null}

      <section hidden={aba !== 'visao'} className="cliente-aba-conteudo" data-nivel="detalhe">
      {vazia ? (
        <div className="vazio">
          <p className="vazio__titulo">Ninguém anotou nada ainda</p>
          <p className="vazio__saida">
            Escreva o que você descobrir hoje. Da próxima vez — com você ou com outro barbeiro —
            o corte sai certo de primeira.
          </p>
        </div>
      ) : (
        <section className="como-corta">
          {destaques.length > 0 ? (
            <ul className="como-corta__lista">
              {destaques.map((item) => (
                <li className="como-corta__item" key={item.rotulo}>
                  <span className="como-corta__rotulo">{item.rotulo}</span>
                  <span className="como-corta__valor">{item.valor}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {conversa ? <p className="como-corta__conversa">{conversa}</p> : null}
          {preferencias.observacoes ? (
            <p className="como-corta__nota">{preferencias.observacoes}</p>
          ) : null}
          {ficha.dados.anotadoPor ? (
            <p className="como-corta__autor">
              Anotado por {ficha.dados.anotadoPor}
              {ficha.dados.anotadoEm ? ` em ${dia(ficha.dados.anotadoEm)}` : ''}
            </p>
          ) : null}
        </section>
      )}

      <details className="anotar">
        <summary className="anotar__abrir">{vazia ? 'Anotar' : 'Mudar a anotação'}</summary>

        <form action={acaoPreferencias} className="formulario anotar__forma">
          <input name="customerId" type="hidden" value={ficha.dados.customerId} />
          <input name="de" type="hidden" value={voltar} />

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="produtosEvitar">
              O que evitar
            </label>
            <input className="ui-field__input" defaultValue={preferencias.produtosEvitar ?? ''}
                   id="produtosEvitar" maxLength={240} name="produtosEvitar"
                   placeholder="Álcool no pós-barba" type="text" />
            <p className="ui-field__hint">Alergia, produto que irrita, o que já deu errado.</p>
          </div>

          <div className="anotar__dupla">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="maquinaLaterais">Laterais</label>
              <input className="ui-field__input" defaultValue={preferencias.maquinaLaterais ?? ''}
                     id="maquinaLaterais" maxLength={120} name="maquinaLaterais"
                     placeholder="Máquina 1" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="tipoDegrade">Degradê</label>
              <input className="ui-field__input" defaultValue={preferencias.tipoDegrade ?? ''}
                     id="tipoDegrade" maxLength={120} name="tipoDegrade"
                     placeholder="Médio" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="topo">Topo</label>
              <input className="ui-field__input" defaultValue={preferencias.topo ?? ''}
                     id="topo" maxLength={120} name="topo" placeholder="Tesoura" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="barbaEstilo">Barba</label>
              <input className="ui-field__input" defaultValue={preferencias.barbaEstilo ?? ''}
                     id="barbaEstilo" maxLength={120} name="barbaEstilo"
                     placeholder="Aparar, sem navalha" type="text" />
            </div>
          </div>

          <fieldset className="painel__grupo">
            <legend className="ui-field__label">Durante o corte</legend>
            <div className="anotar__conversa">
              {CONVERSAS.map((opcao) => (
                <label className="marca" htmlFor={`conversa-${opcao}`} key={opcao}>
                  <input defaultChecked={preferencias.conversa === opcao}
                         id={`conversa-${opcao}`} name="conversa" type="radio" value={opcao} />
                  <span>{ROTULO_DA_CONVERSA[opcao]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="observacoes">Outras observações</label>
            <textarea className="ui-field__input" defaultValue={preferencias.observacoes ?? ''}
                      id="observacoes" maxLength={1000} name="observacoes" rows={3}
                      placeholder="Redemoinho do lado direito abre para cima" />
          </div>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Salvar anotação
          </button>
        </form>
      </details>

      </section>

      <section hidden={aba !== 'visao'} className="cliente-aba-conteudo" data-nivel="detalhe">
      {/*
        O cadastro apagado precisa se explicar (bloco 32).

        Sem este aviso a ficha aparece com um nome estranho, sem telefone e sem
        anotação — que é indistinguível de defeito, e o barbeiro liga para o
        dono. Estado desenhado, não improvisado.
      */}
      {ficha.dados.anonimizado ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="status">
          Os dados desta pessoa foram apagados a pedido dela ou por tempo sem vir. O histórico de
          atendimento e o que ela deve continuam, porque a lei obriga a guardar — o que saiu foi
          tudo que identificava quem era.
        </div>
      ) : null}

      {/* Falar com esta pessoa, do balcão (bloco 92).

          Fica antes dos consentimentos porque é ação do dia a dia, e eles são
          cadastro. Some para quem foi anonimizado: não há para onde mandar, e
          o telefone saiu junto com o resto. */}
      {podeMandar && textos?.ok && !ficha.dados.anonimizado ? (
        <MandarMensagem
          customerId={ficha.dados.customerId}
          de={voltar}
          textos={textos.dados.templates
            /**
             * Só aprovado — o recorte por tipo é da tela (blocos 96 e 132).
             *
             * O filtro daqui trazia os seis textos aprovados, incluindo
             * confirmação e os dois lembretes, e os três falam de um horário
             * marcado que quem recebe uma mensagem avulsa não tem. O domínio já
             * os recusava com `tipo_invalido` desde o bloco 92: eram três botões
             * "Mandar" que só podiam dar erro, que é a §6 pergunta 1 na forma
             * mais direta.
             *
             * O bloco 96 resolveu isso somando `TIPOS_DE_CAMPANHA` **a este
             * filtro**, e com isso apagou a diferença entre "a Meta não aprovou
             * nada" e "aprovou, e nenhum é de mandar à mão": a tela recebia zero
             * nos dois casos e escrevia a primeira frase. Quem tinha dois textos
             * aprovados lia que não tinha nenhum. A pergunta do tipo ficou onde
             * ela é feita, e esta lista voltou a significar o que o nome diz.
             */
            .filter((t) => t.estado === 'aprovado')
            .map((t) => ({ id: t.id, tipo: t.tipo, titulo: t.titulo, corpo: t.corpo }))}
        />
      ) : null}

      {consentimentos?.ok && !ficha.dados.anonimizado ? (
        <Consentimentos
          consentimentos={consentimentos.dados}
          customerId={ficha.dados.customerId}
          de={voltar}
          podeEditar={estado.staff.permissions.includes('customers.edit')}
        />
      ) : null}

      {veFotos && fotos?.ok && consentimentos?.ok && !ficha.dados.anonimizado ? (
        <Fotos
          consentimentos={consentimentos.dados}
          customerId={ficha.dados.customerId}
          fotos={fotos.dados.fotos}
          podeGerenciar={estado.staff.permissions.includes('customers.manage_photos')}
        />
      ) : null}

      {ficha.dados.anonimizado ? null : (
      <DireitosDoTitular
        customerId={ficha.dados.customerId}
        de={voltar}
        podeAbrirPedido={estado.staff.permissions.includes('customers.edit')}
        /*
          As três que a API exige, conferidas pela mesma função que ela usa.
          Recalcular "é só `customers.export`" aqui mostraria um botão que
          responde 403 — e a regra da casa é que a permissão exibida saia de
          onde a permissão é aplicada.
        */
        podeExportar={podeTudo(estado.staff.permissions, [
          'customers.export',
          'finance.view',
          'customers.view_notes',
        ])}
      />
      )}

      </section>

      <section hidden={aba !== 'fidelidade'} className="cliente-aba-conteudo" data-nivel="detalhe">
      {/* O saldo de fidelidade (bloco 41). A SPEC §4.8 pede a exibição "no app e
          no PDV" — a ficha é onde o balcão olha antes de cobrar. */}
      {fidelidade?.ok && fidelidade.dados.modo !== 'nenhum' && !ficha.dados.anonimizado ? (
        <Fidelidade
          customerId={ficha.dados.customerId}
          podeAjustar={estado.staff.permissions.includes('finance.loyalty_adjust')}
          saldo={fidelidade.dados}
        />
      ) : null}

      {/* Os pacotes (bloco 42). Fica na ficha porque é aqui que a recepção olha
          antes de cobrar — a mesma decisão do saldo de fidelidade. */}
      {pacotes?.ok && pacotes.dados.pacotes.length > 0 && !ficha.dados.anonimizado ? (
        <Pacotes
          customerId={ficha.dados.customerId}
          pacotes={pacotes.dados.pacotes}
          podeReembolsar={estado.staff.permissions.includes('finance.package_refund')}
          podeTransferir={estado.staff.permissions.includes('finance.package_transfer')}
        />
      ) : null}

      </section>

      <section hidden={aba !== 'financeiro'} className="cliente-aba-conteudo" data-nivel="detalhe">
      {/* Fiado (bloco 51). Fica ao lado do saldo e dos pacotes: é a mesma
          pergunta — o que esta pessoa já tem com a casa antes de cobrar. */}
      {fiado?.ok && !ficha.dados.anonimizado ? (
        <Fiado
          customerId={ficha.dados.customerId}
          fiado={fiado.dados}
          podeMexer={estado.staff.permissions.includes('finance.credit_limit')}
        />
      ) : null}

      </section>

      <section hidden={aba !== 'historico'} className="cliente-aba-conteudo" data-nivel="detalhe">
      {avaliacoes?.ok && avaliacoes.dados.avaliacoes.length > 0 ? (
        <Avaliacoes avaliacoes={avaliacoes.dados.avaliacoes} />
      ) : null}

      </section>

      <section hidden={aba !== 'fidelidade'} className="cliente-aba-conteudo" data-nivel="detalhe">
      {/* O clube (bloco 45). Fica na ficha porque é onde o balcão olha antes de
          cobrar — a mesma decisão do saldo, dos pacotes e das avaliações. */}
      {assinatura?.ok && !ficha.dados.anonimizado ? (
        <Assinatura
          assinatura={assinatura.dados.assinatura}
          customerId={ficha.dados.customerId}
          dependentes={familia?.ok ? familia.dados.dependentes : []}
          planos={planosDoClube?.ok ? planosDoClube.dados.planos.filter((p) => p.ativo) : []}
          podeMexer={veClube}
        />
      ) : null}

      </section>

      <section hidden={aba !== 'financeiro'} className="cliente-aba-conteudo" data-nivel="detalhe">
      {confianca?.ok && !ficha.dados.anonimizado ? (
        <Confianca
          confianca={confianca.dados}
          customerId={ficha.dados.customerId}
          de={voltar}
          podeAjustar={estado.staff.permissions.includes('customers.reliability_override')}
        />
      ) : null}

      </section>

      <section hidden={aba !== 'visao'} className="cliente-aba-conteudo" data-nivel="detalhe">
      {estado.staff.permissions.includes('customers.anonymize') && !ficha.dados.anonimizado ? (
        <Apagar customerId={ficha.dados.customerId} de={voltar} nome={ficha.dados.nome} />
      ) : null}

      </section>

      <section hidden={aba !== 'historico'} className="cliente-aba-conteudo" data-nivel="detalhe">
      <h2 className="ficha__titulo">Últimas vezes</h2>

      {linhaDoTempo.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhum atendimento ainda</p>
          <p className="vazio__saida">A primeira vez aparece aqui depois que você terminar.</p>
        </div>
      ) : (
        <ul className="visitas">
          {linhaDoTempo.map((visita) => (
            <Visita key={visita.id} visita={visita} />
          ))}
        </ul>
      )}
      </section>
    </main>
  );
}
