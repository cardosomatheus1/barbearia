import type { Metadata } from 'next';

/**
 * A política de privacidade do produto (bloco 89).
 *
 * ## Por que ela é uma página, e não um documento
 *
 * A Meta exige **URL pública** de política de privacidade para aprovar um app
 * na App Review — um PDF ou um texto colado num editor não serve, e a
 * verificação é automática antes de qualquer humano olhar. Ela também é o que a
 * LGPD art. 9º chama de informação prévia ao titular, e o que o cliente da
 * barbearia lê quando quer saber quem guarda o telefone dele.
 *
 * ## A distinção que organiza o texto inteiro
 *
 * **A barbearia é controladora; o Barber Dock é operador.** Não é sutileza
 * jurídica: é o que decide para quem o titular reclama, quem responde por um
 * vazamento e quem pode apagar o quê. Já está escrita no schema — `tenants`
 * carrega `dpo_name`/`dpo_email` porque o art. 41 §1 manda a **controladora**
 * divulgar o encarregado dela, e a plataforma não responde por dado que não é
 * dela.
 *
 * Uma política que dissesse "nós tratamos seus dados" apagaria essa linha e
 * prometeria em nome de mil e duzentas empresas que não a autorizaram.
 *
 * ## Nada aqui é promessa nova
 *
 * Cada afirmação sai de algo que o código já faz — cifragem do token, RLS por
 * barbearia, cinco anos sem interação, noventa dias do texto anônimo,
 * anonimização em vez de exclusão. Política que promete o que o produto não faz
 * é o pior documento possível: ela vira a prova contra quem a publicou.
 */

export const metadata: Metadata = {
  title: 'Privacidade — Barber Dock',
  description:
    'Como o Barber Dock trata dados pessoais: o que é da barbearia, o que é nosso, por quanto tempo fica e como exercer seus direitos.',
};

/** Muda quando o texto muda, e é o que separa duas versões numa contestação. */
const VERSAO = '2026-08';

export default function PrivacidadePage() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-nav__interno">
          <a className="lp-marca" href="/">
            {/* `width`/`height` no `<img>` e `aspect-ratio` no CSS: sem os dois o
                navegador não reserva o espaço e a marca empurra o texto ao
                carregar. */}
            <img
              alt="Barber Dock"
              className="lp-marca__selo"
              height={384}
              src="/barber-dock.png"
              width={384}
            />
            <span className="lp-marca__nome">
              Barber Dock
              <small>Sistema de gestão</small>
            </span>
          </a>
        </div>
      </header>

      <main className="lp-container legal">
        <h1 className="legal__titulo">Política de Privacidade</h1>
        <p className="legal__meta">
          Versão {VERSAO}. Vale para o site barberdock.com.br, para o painel de gestão e para o
          canal de WhatsApp operado pelo produto.
        </p>

        <h2 className="legal__secao">1. Quem responde pelos seus dados</h2>
        <p>
          Se você é <strong>cliente de uma barbearia</strong> que usa o Barber Dock, quem decide
          o que fazer com os seus dados é <strong>a barbearia</strong>. Ela é a controladora: foi
          ela que pediu seu nome e telefone, é ela que atende você, e é a ela que você pede
          correção ou exclusão.
        </p>
        <p>
          O Barber Dock é <strong>operador</strong>: fornecemos o sistema e tratamos os dados
          seguindo as instruções da barbearia. Não vendemos base de clientes, não usamos os
          dados de uma barbearia para outra, e não mandamos mensagem por conta própria para a
          base de ninguém.
        </p>
        <p>
          Cada barbearia publica o contato do encarregado dela na própria página. É o caminho
          mais curto — e o correto — para exercer seus direitos.
        </p>
        <p>
          Se você é <strong>dono ou funcionário de uma barbearia</strong> e usa o painel, aí o
          Barber Dock é controlador dos dados da sua conta: nome, e-mail de acesso e registro de
          uso do sistema.
        </p>

        <h2 className="legal__secao">2. Que dados são tratados</h2>
        <p>Do cliente da barbearia, e sempre por conta dela:</p>
        <ul className="legal__lista">
          <li>nome e telefone, que é como você é reencontrado quando volta;</li>
          <li>histórico de atendimentos, serviços, valores e formas de pagamento;</li>
          <li>
            anotações internas da barbearia sobre o atendimento, quando ela as usa;
          </li>
          <li>
            foto do corte, <strong>somente com autorização específica</strong> — e publicar essa
            foto exige uma segunda autorização, separada da primeira;
          </li>
          <li>
            CPF, apenas quando você pede nota fiscal e informa o documento para isso;
          </li>
          <li>
            data de nascimento, quando a barbearia a registra.
          </li>
        </ul>
        <p>
          Não há campo para número de cartão neste sistema. Pagamento por cartão é processado
          pelo adquirente, e deste lado ficam apenas a bandeira, os quatro últimos dígitos e uma
          referência opaca que não permite cobrar nada.
        </p>

        <h2 className="legal__secao">3. WhatsApp</h2>
        <p>
          As mensagens saem pelo <strong>número da própria barbearia</strong>, verificado por ela
          junto à Meta — nunca por um número da plataforma. Quem envia é a barbearia; o produto é
          a ferramenta.
        </p>
        <p>
          Mensagens sobre o seu atendimento — confirmação, lembrete, aviso de horário — fazem
          parte do serviço contratado. <strong>Promoção é outra coisa</strong>: exige autorização
          separada, registrada com data, endereço de origem e a versão exata do texto que você
          leu. Você pode retirá-la a qualquer momento, e a retirada é registrada como um fato
          novo, sem apagar o histórico.
        </p>
        <p>
          Nada é enviado entre 21h e 8h no fuso da barbearia, mesmo que o sistema tenha algo a
          dizer nesse intervalo.
        </p>
        <p>
          A credencial que a barbearia concede à plataforma para enviar em nome dela é guardada
          cifrada (AES-256-GCM) e nunca é devolvida a tela nenhuma — o painel mostra que ela
          existe, jamais o valor.
        </p>

        <h2 className="legal__secao">4. Com quem os dados são compartilhados</h2>
        <p>Só com quem é necessário para o serviço funcionar, e só o que cada um precisa:</p>
        <ul className="legal__lista">
          <li>
            <strong>Meta (WhatsApp Business Platform)</strong> — telefone e conteúdo das
            mensagens enviadas pela barbearia;
          </li>
          <li>
            <strong>Processadores de pagamento</strong> — os dados da transação, quando a
            barbearia usa cobrança online;
          </li>
          <li>
            <strong>Emissor de nota fiscal</strong> — os dados que a nota exige, quando você a
            pede;
          </li>
          <li>
            <strong>Provedor de hospedagem</strong> — onde o sistema roda.
          </li>
        </ul>
        <p>
          Não há venda de dados, não há troca com anunciante, e não há enriquecimento de base com
          terceiros.
        </p>

        <h2 className="legal__secao">5. Por quanto tempo</h2>
        <ul className="legal__lista">
          <li>
            <strong>Cadastro de cliente:</strong> até cinco anos sem nenhuma interação —
            atendimento, comanda, fiado ou fila. Antes de encerrar, a barbearia recebe aviso com
            trinta dias de antecedência, e uma visita nova cancela a saída.
          </li>
          <li>
            <strong>Registros fiscais e financeiros:</strong> pelo prazo que a lei exige, mesmo
            depois de o cadastro sair.
          </li>
          <li>
            <strong>Perguntas feitas sem identificação</strong> ao atendimento automático: o
            texto é apagado em noventa dias; fica só a contagem, que não identifica ninguém.
          </li>
          <li>
            <strong>Arquivo de importação de base:</strong> apagado assim que é aplicado.
          </li>
        </ul>

        <h2 className="legal__secao">6. Seus direitos</h2>
        <p>
          A LGPD garante confirmação, acesso, correção, portabilidade, informação sobre
          compartilhamento, revogação de consentimento e eliminação. Peça à barbearia que atende
          você: o sistema entrega a ela as ferramentas para responder, com prazo registrado no
          momento do pedido.
        </p>
        <p>
          Sobre exclusão, uma explicação honesta: o que o sistema faz é{' '}
          <strong>anonimizar</strong>, não apagar linha. Seu nome, telefone, documento, anotações
          e fotos saem do cadastro e não voltam; a venda e os valores permanecem sem ligação com
          você, porque a barbearia tem obrigação legal de guardar o registro fiscal. Apagar tudo
          levaria a contabilidade dela junto — e a lei exige as duas coisas ao mesmo tempo.
        </p>

        <h2 className="legal__secao">7. Segurança</h2>
        <ul className="legal__lista">
          <li>
            Os dados de cada barbearia são isolados no banco por política do próprio banco de
            dados, não por filtro escrito na aplicação;
          </li>
          <li>
            Credenciais e segredos são guardados cifrados, com chaves separadas por finalidade;
          </li>
          <li>
            Senhas nunca são guardadas em texto legível;
          </li>
          <li>
            Operações sensíveis — exportar base, acessar foto, alterar permissão, mover dinheiro
            — ficam em trilha de auditoria que não pode ser reescrita;
          </li>
          <li>
            Todo o tráfego é servido por HTTPS.
          </li>
        </ul>

        <h2 className="legal__secao">8. Cookies</h2>
        <p>
          O produto usa cookies estritamente necessários: manter você conectado ao painel e
          lembrar de qual barbearia é a sessão do cliente. Não há cookie de publicidade nem
          rastreamento entre sites.
        </p>

        <h2 className="legal__secao">9. Contato</h2>
        <p>
          Para assuntos de privacidade relativos à plataforma:{' '}
          <a href="mailto:privacidade@barberdock.com.br">privacidade@barberdock.com.br</a>.
        </p>
        <p>
          Para dados de cliente de uma barbearia específica, procure a barbearia — ela é a
          controladora, e o contato do encarregado dela está na página dela.
        </p>

        <h2 className="legal__secao">10. Mudanças</h2>
        <p>
          Quando este texto mudar, a versão no topo muda junto. Alterações que afetem
          consentimento já dado exigem consentimento novo — um aceite dado sob um texto não vale
          para outro.
        </p>
      </main>

      <footer className="lp-rodape">
        <div className="lp-container lp-rodape__interno">
          <p>Barber Dock — sistema de gestão para barbearias</p>
          <nav aria-label="Rodapé" className="lp-rodape__links">
            <a href="/">Início</a>
            <a href="/termos">Termos</a>
            <a href="/admin/entrar">Entrar</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
