import styles from './modos.module.css';

/**
 * A conexão da unidade — **duas** opções, não três (bloco 137).
 *
 * A tela perguntava "Como você quer enviar?" e oferecia Meta, Baileys e Manual
 * com o mesmo desenho. Elas não são a mesma pergunta: Meta e Baileys são a
 * conexão, uma por unidade, e decidem o que sai sozinho; manual é o transporte
 * de **um texto**, convive com qualquer conexão e nunca sai sozinho.
 *
 * Achatadas, o cartão de manual era o único que levava para outra página — e a
 * pessoa que o escolhia ia para lá recriar a campanha do zero. Manual passou
 * para junto dos textos, que é onde ele é escolhido de verdade.
 */
export function ModosWhatsApp({ modo, ativo }: { modo: 'meta' | 'baileys'; ativo: 'meta' | 'baileys' | null }) {
  return <section aria-labelledby="escolha-whatsapp" className={styles.escolha}>
    <h2 id="escolha-whatsapp" className="cartao-balcao__titulo">Sua conexão</h2>
    <p className={styles.nota}>
      Ela decide o que sai <strong>sozinho</strong>. Mensagem para você mandar à mão não depende
      de conexão nenhuma e continua disponível nas duas.
    </p>
    <nav aria-label="Conexão do WhatsApp" className={styles.modos}>
      <a href="/admin/whatsapp?modo=meta#configuracao" className={styles.modo} aria-current={modo === 'meta' ? 'page' : undefined}>
        <span className={styles.etiqueta}>Recomendado · oficial</span>
        <strong>Meta</strong>
        <span>Envios automáticos com mensagens aprovadas. Há custos de envio, conforme as regras da Meta.</span>
        <span className={styles.destino}>{ativo === 'meta' ? 'Conexão escolhida · ver configuração' : 'Ver passo a passo →'}</span>
      </a>
      <a href="/admin/whatsapp?modo=baileys#configuracao" className={styles.modo} aria-current={modo === 'baileys' ? 'page' : undefined}>
        <span className={styles.etiqueta}>Alternativa não oficial</span>
        <strong>Baileys</strong>
        <span>Integração gratuita, sem tarifa da API Meta. Você escreve as mensagens, sem aprovação. Pode causar bloqueio ou banimento da conta.</span>
        <span className={styles.destino}>{ativo === 'baileys' ? 'Conexão escolhida · ver configuração' : 'Ver conexão por QR Code →'}</span>
      </a>
    </nav>
  </section>;
}

/**
 * O contexto no topo de Campanhas e Automações.
 *
 * Ele dizia **"Envio automático · Meta"** e oferecia *"Prefiro enviar
 * manualmente"* como saída — afirmando o destino da campanha antes da lista que
 * o decide, e tratando manual como desistência em vez de escolha. Agora ele diz
 * só a conexão, como contexto; o destino de cada mensagem está escrito na
 * própria opção, no passo em que ela é escolhida.
 */
export function ContextoDeEnvio({ canal }: { canal: 'meta' | 'baileys' | null }) {
  return <div className={styles.contexto}>
    <p><strong>Conexão{canal ? ` · ${canal === 'meta' ? 'Meta' : 'Baileys'}` : ' não escolhida'}</strong><br />
      {canal === 'meta' ? 'O que sai sozinho vai por mensagem aprovada pela Meta, com custo por envio.'
        : canal === 'baileys' ? 'O que sai sozinho vai pelo número conectado por QR Code, sem aprovação e com risco de banimento.'
        : 'Sem conexão, só saem as mensagens que você mandar à mão, pela fila.'}
      {' '}Cada mensagem abaixo diz para onde ela vai.
    </p>
    <p><a href="/admin/whatsapp">Configurar WhatsApp</a> · <a href="/admin/whatsapp/manual">Mensagens para enviar</a></p>
  </div>;
}

/**
 * As três famílias de mensagem, **sempre as três** (bloco 137).
 *
 * A tela só desenhava os textos do modo selecionado **e** ativo: quem estava na
 * Meta nunca via os do Baileys, e os manuais moravam noutra página. Três mundos
 * isolados, cada um invisível de dentro dos outros — e a barbearia concluía que
 * as outras duas capacidades não existiam.
 *
 * Separar não é esconder. Cada grupo aparece sempre, com o que exige escrito ao
 * lado e a contagem do que já existe; o que muda conforme a conexão é a frase
 * que diz se aquele grupo sai sozinho hoje.
 */
export function ResumoDasMensagens({ meta, baileys, manuais, ativo }: {
  readonly meta: number; readonly baileys: number; readonly manuais: number;
  readonly ativo: 'meta' | 'baileys' | null;
}) {
  const quantas = (n: number) => n === 0 ? 'nenhuma ainda' : n === 1 ? '1 mensagem' : `${n} mensagens`;
  return <section aria-labelledby="suas-mensagens" className={styles.escolha}>
    <h2 id="suas-mensagens" className="cartao-balcao__titulo">Suas mensagens</h2>
    <p className={styles.nota}>
      Cada mensagem pertence a uma família, e é ela que decide o destino quando você usa a
      mensagem numa campanha ou automação.
    </p>
    <nav aria-label="Famílias de mensagem" className={styles.modos}>
      <a className={styles.modo} href="/admin/whatsapp?modo=meta#mensagens-meta">
        <span className={styles.etiqueta}>{quantas(meta)}</span>
        <strong>Pela Meta</strong>
        <span>
          Precisam de aprovação da Meta antes de sair.{' '}
          {ativo === 'meta' ? 'Saem sozinhas, porque esta é a sua conexão.' : 'Só saem sozinhas com a conexão Meta.'}
        </span>
        <span className={styles.destino}>Ver e criar →</span>
      </a>
      <a className={styles.modo} href="/admin/whatsapp?modo=baileys#mensagens-baileys">
        <span className={styles.etiqueta}>{quantas(baileys)}</span>
        <strong>Pelo Baileys</strong>
        <span>
          Você escreve o texto, sem aprovação de ninguém.{' '}
          {ativo === 'baileys' ? 'Saem sozinhas, porque esta é a sua conexão.' : 'Só saem sozinhas com a conexão Baileys.'}
        </span>
        <span className={styles.destino}>Ver e escrever →</span>
      </a>
      <a className={styles.modo} href="/admin/whatsapp/manual">
        <span className={styles.etiqueta}>{quantas(manuais)}</span>
        <strong>Mensagens para enviar</strong>
        <span>
          Você escreve o texto, sem aprovação. Nunca saem sozinhas: viram uma fila com a conversa
          pronta, e valem com qualquer conexão — inclusive sem nenhuma.
        </span>
        <span className={styles.destino}>Ver a fila e os textos →</span>
      </a>
    </nav>
  </section>;
}
