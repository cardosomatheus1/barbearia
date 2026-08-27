import type { Metadata } from 'next';

/**
 * A porta da frente do Barber Dock.
 *
 * ## O que esta página vende, e para quem
 *
 * Não é a página de uma barbearia — essa é `/{slug}`. Esta é a do **produto**,
 * e quem chega nela é o dono de uma barbearia que já usa alguma coisa e está
 * insatisfeito. Ele não quer ler "solução completa de gestão": quer saber se
 * isto resolve o problema que ele tem hoje.
 *
 * Daí a tese: **a seção mais importante é a do que costuma quebrar.** Cada linha
 * dela é um problema concreto da operação, com o efeito que ele tem no dia — o
 * oposto de uma parede de depoimentos. Ela fala do problema, nunca de um
 * concorrente com nome: o leitor está ali para reconhecer o próprio dia, não
 * para assistir alguém ser julgado.
 *
 * ## Landing sem componente client-side
 *
 * A landing é renderizada no servidor e não abre componente client-side próprio. O
 * que no mock era JavaScript virou CSS: as abas viraram uma faixa que rola, o
 * "revelar ao rolar" saiu, e a paleta de comandos — que é enfeite de marketing —
 * não entrou. O que ficou de movimento é ambiente, e some inteiro em
 * `prefers-reduced-motion`.
 *
 * ## O elemento assinatura é a corda
 *
 * O selo tem um anel de cordame, e ele vira o divisor entre as seções — um filete
 * trançado desenhado em CSS. É o detalhe que não sai de um template: vem do
 * desenho da marca e não de uma paleta.
 */

export const metadata: Metadata = {
  title: 'Barber Dock — agenda, caixa e gestão para barbearias',
  description:
    'Agenda por duração real, fila de espera, comanda, caixa, fiado e comissão para barbearias. Importe sua base de clientes por planilha e trabalhe no navegador.',
};

/**
 * As telas do produto, fotografadas.
 *
 * ## Por que existe
 *
 * A página falava do sistema sem mostrá-lo. Quem chega aqui é dono de
 * barbearia insatisfeito com o que usa hoje, e a primeira pergunta dele é
 * visual: "com o que eu vou trabalhar?". Texto responde por último.
 *
 * ## Por que são fotos e não desenho
 *
 * Cada uma é um print do produto rodando, com a barbearia de demonstração que
 * `scripts/semear-demo.mjs` cria — os números na tela são os que o motor
 * calculou, não valores digitados num mock. Numa página cuja tese é "medimos,
 * não imaginamos", ilustrar com maquete seria contradizê-la na própria dobra.
 *
 * Refazer: suba o sistema, rode `node tirar-prints.cjs <segredo-do-2fa>` e
 * converta para 1200px de largura.
 *
 * ## Sem estado client-side, como o resto da landing
 *
 * A tira rola com `scroll-snap` e os atalhos são âncoras — o navegador já sabe
 * fazer as duas coisas. Abas de verdade exigiriam estado no cliente, e o
 * produto inteiro é renderizado no servidor.
 */
const TELAS = [
  {
    id: 'tela-dashboard',
    nome: 'Painel',
    titulo: 'Painel: o que merece atenção hoje',
    arquivo: 'dashboard',
    alto: 'Painel do dono: faturamento do período, meta, ocupação e o que merece ação hoje',
    nota: 'Faturamento, meta e ocupação no período, com comparação para mostrar onde vale agir.',
  },
  {
    id: 'tela-dia',
    nome: 'O dia',
    titulo: 'O dia: quem chegou, atrasou e ainda falta',
    arquivo: 'dia',
    alto: 'Painel do balcão com quem chegou, quem está na cadeira e quem faltou',
    nota: 'Quem chegou, quem está na cadeira e há quanto tempo. A linha do agora separa o que passou do que ainda precisa acontecer.',
  },
  {
    id: 'tela-marcar',
    nome: 'Marcar',
    titulo: 'Marcar: só aparecem horários que cabem',
    arquivo: 'marcar',
    alto: 'Tela de marcação pelo balcão, com a grade de horários que cabem',
    nota: 'A grade usa a duração real do serviço em vez de forçar todo atendimento em blocos fixos de quinze minutos.',
  },
  {
    id: 'tela-cliente',
    nome: 'Pelo cliente',
    titulo: 'Cliente: agenda pelo link, sem instalar app',
    arquivo: 'cliente-agendar',
    alto: 'Página pública da barbearia, com foto, endereço, serviços e preços',
    nota: 'Endereço, telefone, foto, preço e horários livres na mesma página.',
  },
  {
    id: 'tela-comanda',
    nome: 'Comanda',
    titulo: 'Comanda: o atendimento já nasce com o combinado',
    arquivo: 'comanda',
    alto: 'Comanda aberta com itens do atendimento e as formas de pagamento',
    nota: 'Serviço e preço da reserva já entram na comanda para o balcão não começar do zero.',
  },
] as const;

const MODULOS = [
  {
    kicker: 'Agenda',
    titulo: 'Cada serviço abre o espaço que realmente precisa',
    texto:
      'A grade usa duração, buffer e recurso de cada serviço. Se sobrou uma janela que cabe outro atendimento, ela pode voltar para a agenda.',
    classe: 'lp-bento__item--grande',
  },
  {
    kicker: 'Balcão',
    titulo: 'Encaixe sem empurrar o resto do dia',
    texto:
      'Quem chega sem marcar entra na fila, acompanha a posição pelo celular e o balcão vê o impacto antes de confirmar o encaixe.',
    classe: 'lp-bento__item--alto',
  },
  {
    kicker: 'Dinheiro',
    titulo: 'Saiba o que entrou, saiu e ficou para depois',
    texto:
      'Comanda, caixa, sangria e fiado ficam registrados no fluxo financeiro, com divergências visíveis no fechamento.',
    classe: 'lp-bento__item--largo',
  },
  {
    kicker: 'Comissão',
    titulo: 'Fechou a comissão, o histórico não muda',
    texto:
      'O período fechado fica imutável. Se houver estorno depois, entra um novo lançamento em vez de apagar o que já aconteceu.',
    classe: 'lp-bento__item--pequeno',
  },
  {
    kicker: 'Avisos',
    titulo: 'Lembrete sem mensagem de madrugada',
    texto:
      'Confirmação, aviso de 24h, aviso de 2h e convite de retorno respeitam o fuso da unidade e a janela de silêncio das 21h às 8h.',
    classe: 'lp-bento__item--pequeno',
  },
] as const;

/**
 * O que costuma quebrar numa barbearia, e o que fazemos diferente.
 *
 * ## Por que sem sobrenome
 *
 * A versão anterior contava que o sistema de uma barbearia identificável tinha
 * sido auditado, listava os achados com o código do dossiê e dizia quanto cada
 * um custava a ela. Era verdade e era verificável — e expunha a barbearia e o
 * fornecedor dela numa página de vendas. O leitor não estava aprendendo sobre o
 * problema dele; estava assistindo alguém ser julgado.
 *
 * O conteúdo continua sendo o mesmo, porque ele **é** de categoria: grade fixa,
 * fuso do aparelho, combo com duração errada e página sem endereço aparecem em
 * software de barbearia inteiro, não num só. O que saiu foi o dedo apontado.
 *
 * ## O que não pode sair junto
 *
 * A concretude. "Serviço de 20 min começava 09:15 e deixava buraco" é o que faz
 * um dono reconhecer o próprio dia; trocar por "otimize sua agenda" transforma
 * a seção na parede de marketing que ela existe para não ser.
 */
const ACHADOS = [
  {
    area: 'Agenda',
    problema: 'Grade fixa de 15 em 15 desperdiça os minutos que não cabem no bloco.',
    efeito: 'Um corte de 20 min começando às 09:15 deixa cinco minutos soltos.',
    resposta: 'A grade sai da duração do serviço e reaproveita a janela quando outro atendimento cabe.',
  },
  {
    area: 'Cardápio',
    problema: 'Um combo cadastrado com 30 min, quando as partes somam 40, coloca atraso dentro do próprio cadastro.',
    efeito: 'O atraso nasce antes mesmo de o primeiro cliente sentar na cadeira.',
    resposta: 'O validador mostra a diferença entre a duração cadastrada e a soma real antes que ela vire rotina no salão.',
  },
  {
    area: 'Fuso',
    problema: 'O horário da unidade não pode depender do relógio do aparelho de quem acessa.',
    efeito: 'Um aparelho fora do horário correto pode mostrar uma grade deslocada.',
    resposta: 'A agenda usa o fuso da barbearia, independentemente do relógio do celular.',
  },
  {
    area: 'Escolha',
    problema: 'Quem quer o primeiro horário livre não deveria abrir um profissional por vez.',
    efeito: 'Comparar barbeiro por barbeiro transforma uma escolha simples em várias tentativas.',
    resposta: '“Qualquer profissional” mostra o horário mais cedo entre todos.',
  },
  {
    area: 'Página',
    problema: 'Endereço, telefone e horário de funcionamento não deveriam ficar separados do agendamento.',
    efeito: 'Quem só quer saber onde fica ou se está aberto precisa procurar em outro lugar.',
    resposta: 'A página pública reúne essas informações e os horários livres antes de pedir o agendamento.',
  },
  {
    area: 'Cadastro',
    problema: 'Conta de balcão não é barbeiro e não deveria aparecer como um.',
    efeito: 'Ocupação e comissão passam a carregar uma agenda que não pertence a nenhum profissional.',
    resposta: 'Conta de balcão fica separada de cadeira e não entra como barbeiro nos relatórios.',
  },
] as const;

const SUPERFICIES = [
  {
    nome: 'O cliente',
    titulo: 'Cliente: agenda sem criar conta',
    aparelho: 'celular, em pé, na rua',
    texto:
      'Entra pelo link da bio, vê os horários livres e agenda. Para remarcar ou cancelar depois, usa um código de seis dígitos.',
  },
  {
    nome: 'O balcão',
    titulo: 'Balcão: acompanha o dia sem trocar de página',
    aparelho: 'notebook aberto o dia inteiro',
    texto:
      'Vê quem chegou, quem está atrasado e quem ainda falta atender. Se alguém aparece sem horário, marca sem sair da rotina do dia.',
  },
  {
    nome: 'O barbeiro',
    titulo: 'Barbeiro: vê quem vem agora e o que precisa saber',
    aparelho: 'celular, entre um cliente e outro',
    texto:
      'O próximo cliente, a ficha de atendimento e os próprios números ficam acessíveis no celular entre um atendimento e outro.',
  },
  {
    nome: 'O dono',
    titulo: 'Dono: compara o resultado antes de decidir',
    aparelho: 'onde estiver',
    texto:
      'Faturamento, ocupação e faltas aparecem com comparação de período para o número ter contexto antes de virar decisão.',
  },
] as const;

export default function LandingPage() {
  return (
    <div className="lp">
      {/* Fundo: malha fina e feixes verticais. Puramente decorativo, fora do fluxo. */}
      <div aria-hidden="true" className="lp-ambiente">
        <span className="lp-feixe lp-feixe--1" />
        <span className="lp-feixe lp-feixe--2" />
        <span className="lp-feixe lp-feixe--3" />
      </div>

      <header className="lp-nav">
        <div className="lp-nav__interno">
          <a className="lp-marca" href="/">
            <img
              alt="Barber Dock"
              className="lp-marca__selo"
              height={384}
              src="/barber-dock.png"
              width={384}
            />
            <span className="lp-marca__nome">
              Barber Dock
              <small>Gestão para barbearias</small>
            </span>
          </a>

          <div className="lp-nav__acoes">
            <a className="ui-button ui-button--ghost" href="/admin/entrar">
              Entrar
            </a>
            <a className="ui-button ui-button--primary lp-beam" href="/admin/criar-conta">
              Criar minha conta
            </a>
          </div>

          {/* No celular as âncoras viram uma faixa que rola dentro de si — não
              somem. Esconder no aparelho pequeno seria decidir que não
              importavam; se não importam, saem de todas as larguras. */}
          <nav aria-label="Seções" className="lp-nav__links ui-scroll-x">
            <a href="#telas">Telas reais</a>
            <a href="#recursos">Rotina</a>
            <a href="#campo">Problemas</a>
            <a href="#superficies">Quem usa</a>
          </nav>
        </div>
      </header>

      <main>
        <section className="lp-heroi">
          <div className="lp-container lp-heroi__grade">
            <div>
              <p className="lp-selo">
                <span aria-hidden="true" className="lp-selo__ponto" />
                Gestão para barbearias
              </p>

              <h1 className="lp-heroi__titulo">
                Horários que cabem no dia.
                <br />
                <em>Caixa que fecha sem adivinhar.</em>
              </h1>

              <p className="lp-heroi__texto">
                O Barber Dock calcula a agenda pela duração real do serviço, mostra quem chegou,
                abre comanda, registra fiado e fecha comissão. Menos ajuste manual quando o
                movimento aperta.
              </p>

              <div className="lp-heroi__acoes">
                <a className="ui-button ui-button--primary ui-button--lg lp-beam" href="/admin/criar-conta">
                  Criar minha conta
                </a>
                <a className="lp-link" href="#campo">
                  Ver os 6 problemas tratados
                  <span aria-hidden="true">→</span>
                </a>
              </div>

              <ul className="lp-provas">
                <li>Abre no navegador, sem instalar app</li>
                <li>Importa sua base de clientes por planilha</li>
                <li>Dados de cada barbearia isolados no banco</li>
              </ul>
            </div>

            {/* A janela é HTML de verdade, não print: o que aparece aqui é o
                mesmo vocabulário da tela do balcão, e não envelhece sozinho
                quando a tela mudar. Fica em perspectiva, com o brilho varrendo
                a tela e os cartões de vidro por cima — é o volume que separa
                uma página de produto de uma folha de texto. */}
            <div className="lp-palco" aria-hidden="true">
              {/* A coluna dos cartões. Escalonada de propósito: alinhados entre
                  si eles viram uma tabela; desalinhados, leem como flutuando. */}
              <div className="lp-palco__pilha">
                <div className="lp-flutuante lp-flutuante--1">
                  <span className="lp-flutuante__rotulo">Ocupação hoje</span>
                  <strong className="lp-flutuante__valor tabular">87%</strong>
                  <span className="lp-flutuante__delta">+12% que sábado passado</span>
                </div>
                <div className="lp-flutuante lp-flutuante--2">
                  <span className="lp-flutuante__rotulo">Na fila</span>
                  <strong className="lp-flutuante__valor tabular">3</strong>
                  <span className="lp-flutuante__delta">espera média 14 min</span>
                </div>
                <div className="lp-flutuante lp-flutuante--3">
                  <span className="lp-flutuante__rotulo">Caixa do dia</span>
                  <strong className="lp-flutuante__valor tabular">R$ 5.820</strong>
                  <span className="lp-flutuante__delta">ticket R$ 69,28</span>
                </div>
              </div>

              <div className="lp-janela">
                <div className="lp-janela__barra">
                  <span className="lp-janela__sinais">
                    <i /><i /><i />
                  </span>
                  <span className="lp-janela__url">barberdock.app/admin/dia</span>
                </div>

                <div className="lp-janela__corpo">
                  <p className="lp-janela__dia">
                    Sábado <span className="tabular">14/03</span>
                  </p>

                  <ul className="lp-agenda">
                    <li className="lp-agenda__linha lp-agenda__linha--feito">
                      <span className="lp-agenda__hora tabular">09:00</span>
                      <span className="lp-agenda__quem">Carlos Souza</span>
                      <span className="lp-agenda__estado">Concluído</span>
                    </li>
                    <li className="lp-agenda__linha lp-agenda__linha--agora">
                      <span className="lp-agenda__hora tabular">09:40</span>
                      <span className="lp-agenda__quem">José Antônio</span>
                      <span className="lp-agenda__estado">Em atendimento</span>
                    </li>
                    <li className="lp-agenda__linha lp-agenda__linha--atrasado">
                      <span className="lp-agenda__hora tabular">10:20</span>
                      <span className="lp-agenda__quem">Bruno Carvalho</span>
                      <span className="lp-agenda__estado">Atrasado 6 min</span>
                    </li>
                    <li className="lp-agenda__linha">
                      <span className="lp-agenda__hora tabular">11:00</span>
                      <span className="lp-agenda__quem">Livre</span>
                      <span className="lp-agenda__estado">Encaixe</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* `ui-sangra`: a faixa é max-content e animada de propósito — não há
            conteúdo a alcançar atrás do recorte. */}
        <div className="lp-faixa ui-sangra">
          <div className="lp-faixa__trilho">
            {/* Duplicado para o laço não ter emenda visível. */}
            {[0, 1].map((volta) => (
              <span className="lp-faixa__grupo" key={volta}>
                <span>Agenda por duração real</span>
                <span>Fila de espera</span>
                <span>Comanda e caixa</span>
                <span>Fiado registrado</span>
                <span>Comissão com período fechado</span>
                <span>Lembretes no WhatsApp, quando o canal está conectado</span>
                <span>Ficha do cliente</span>
                <span>Metas por barbeiro</span>
                <span>Trilha de auditoria</span>
              </span>
            ))}
          </div>
        </div>

        <section className="lp-secao lp-secao--placar">
          <div className="lp-container">
            <dl className="lp-placar">
              <div className="lp-placar__item">
                <dt>Telas reais do produto</dt>
                <dd className="tabular">5</dd>
              </div>
              <div className="lp-placar__item">
                <dt>Problemas operacionais detalhados</dt>
                <dd className="tabular">6</dd>
              </div>
              <div className="lp-placar__item">
                <dt>Etapas no cadastro inicial</dt>
                <dd className="tabular">6</dd>
              </div>
              <div className="lp-placar__item">
                <dt>Apps para o cliente instalar</dt>
                <dd className="tabular">0</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="lp-secao" id="telas">
          <div className="lp-container">
            <p className="lp-sobrancelha">Veja antes de trocar</p>
            <h2 className="lp-titulo">Cinco telas reais, do painel do dono à comanda do balcão</h2>
            <p className="lp-intro">
              São telas do produto rodando com a barbearia de demonstração. Você vê o que o
              balcão usa, o que o cliente recebe e o que o dono acompanha.
            </p>

            {/* Âncoras, não abas: o navegador rola até o alvo sem uma linha de
                JavaScript. Cada uma é um alvo de 44px, como qualquer outro. */}
            <nav aria-label="Telas do sistema" className="lp-telas__atalhos ui-scroll-x">
              {TELAS.map((tela) => (
                <a className="lp-telas__atalho" href={`#${tela.id}`} key={tela.id}>
                  {tela.nome}
                </a>
              ))}
            </nav>
          </div>

          {/* Rola dentro de si, nunca leva a página junto (CLAUDE.md §5). */}
          <ul className="lp-telas ui-scroll-x">
            {TELAS.map((tela, indice) => (
              <li className="lp-telas__item" id={tela.id} key={tela.id}>
                <figure className="lp-telas__figura">
                  {/* `width`/`height` no elemento **e** `aspect-ratio` no CSS: sem os
                      dois o navegador não reserva o espaço e a foto empurra o
                      conteúdo ao carregar. */}
                  <img
                    alt={tela.alto}
                    className="lp-telas__foto"
                    height={750}
                    loading="lazy"
                    src={`/screens/${tela.arquivo}.jpg`}
                    width={1200}
                  />
                  <figcaption className="lp-telas__legenda">
                    <span className="lp-telas__ordem tabular">
                      {String(indice + 1).padStart(2, '0')}
                    </span>
                    <span>
                      <strong className="lp-telas__nome">{tela.titulo}</strong>
                      <span className="lp-telas__nota">{tela.nota}</span>
                    </span>
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-secao" id="recursos">
          <div className="lp-container">
            <p className="lp-sobrancelha">Da agenda ao dinheiro</p>
            <h2 className="lp-titulo">O que acontece no balcão já chega ao caixa</h2>
            <p className="lp-intro">
              Agenda, fila, comanda, fiado e comissão usam a mesma operação. O dado não precisa
              ser refeito em outra planilha no fechamento.
            </p>

            <div className="lp-bento">
              {MODULOS.map((modulo) => (
                <article className={`lp-bento__item ${modulo.classe}`} key={modulo.kicker}>
                  <p className="lp-bento__kicker">{modulo.kicker}</p>
                  <h3 className="lp-bento__titulo">{modulo.titulo}</h3>
                  <p className="lp-bento__texto">{modulo.texto}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <hr aria-hidden="true" className="lp-corda" />

        <section className="lp-secao" id="campo">
          <div className="lp-container">
            <p className="lp-sobrancelha">Problemas que viraram regra do produto</p>
            <h2 className="lp-titulo">
              Seis falhas de operação que o Barber Dock trata na origem
            </h2>
            <p className="lp-intro">
              Doze problemas foram levantados dentro de uma barbearia em funcionamento antes da
              primeira linha de código. Abaixo estão seis deles, com o efeito no dia e a regra
              criada para evitar que o mesmo problema seja aceito como normal.
            </p>

            <ul className="lp-achados">
              {ACHADOS.map((achado) => (
                <li className="lp-achado" key={achado.area}>
                  <p className="lp-achado__codigo">{achado.area}</p>
                  <div className="lp-achado__corpo">
                    <p className="lp-achado__problema">{achado.problema}</p>
                    <p className="lp-achado__efeito">{achado.efeito}</p>
                    <p className="lp-achado__resposta">{achado.resposta}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <hr aria-hidden="true" className="lp-corda" />

        <section className="lp-secao" id="superficies">
          <div className="lp-container">
            <p className="lp-sobrancelha">Um sistema, quatro rotinas</p>
            <h2 className="lp-titulo">Quatro rotinas sem obrigar todo mundo a trabalhar na mesma tela</h2>
            <p className="lp-intro">
              Cliente, balcão, barbeiro e dono veem a informação necessária para o próximo passo,
              no celular ou no notebook, sem manter uma versão separada do sistema.
            </p>

            <div className="lp-superficies">
              {SUPERFICIES.map((superficie) => (
                <article className="lp-superficie" key={superficie.nome}>
                  <h3 className="lp-superficie__nome">{superficie.titulo}</h3>
                  <p className="lp-superficie__aparelho">{superficie.aparelho}</p>
                  <p className="lp-superficie__texto">{superficie.texto}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-secao lp-secao--final">
          <div className="lp-container">
            <div className="lp-chamada">
              <div aria-hidden="true" className="lp-chamada__visual">
                <img
                  alt=""
                  className="lp-chamada__imagem"
                  decoding="async"
                  height={900}
                  loading="lazy"
                  src="/landing/cta-final-barbershop.webp"
                  width={1600}
                />
              </div>
              <div className="lp-chamada__conteudo">
                <p className="lp-chamada__kicker">Barbearia em operação, sistema no navegador</p>
                <h2 className="lp-chamada__titulo">Comece com sua base de clientes, não com uma tela vazia</h2>
                <p className="lp-chamada__texto">
                  O cadastro tem seis etapas, sua base de clientes entra por planilha e o endereço
                  antigo continua funcionando. Sem contrato de fidelidade, sem instalar app para o
                  cliente e sem recomeçar do zero.
                </p>
              </div>
              <div className="lp-chamada__acoes">
                <a className="ui-button ui-button--primary ui-button--lg lp-beam" href="/admin/criar-conta">
                  Criar minha conta
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-rodape">
        <div className="lp-container lp-rodape__interno">
          <p>Barber Dock — gestão para barbearias</p>
          {/* Privacidade e termos entram aqui porque a página que ninguém
              alcança é a página que não existe — e a Meta confere se as duas
              URLs respondem antes de qualquer humano olhar a submissão. */}
          <nav aria-label="Rodapé" className="lp-rodape__links">
            <a href="/admin/entrar">Entrar</a>
            <a href="/admin/criar-conta">Criar minha conta</a>
            <a href="/privacidade">Privacidade</a>
            <a href="/termos">Termos</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
