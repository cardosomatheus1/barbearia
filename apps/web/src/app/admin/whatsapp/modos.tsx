import styles from './modos.module.css';

export function ModosWhatsApp({ modo, ativo }: { modo: 'meta' | 'baileys'; ativo: 'meta' | 'baileys' | null }) {
  return <section aria-labelledby="escolha-whatsapp" className={styles.escolha}>
    <h2 id="escolha-whatsapp" className="cartao-balcao__titulo">Como você quer enviar?</h2>
    <nav aria-label="Modo do WhatsApp" className={styles.modos}>
      <a href="/admin/whatsapp?modo=meta#configuracao" className={styles.modo} aria-current={modo === 'meta' ? 'page' : undefined}>
        <span className={styles.etiqueta}>Recomendado · oficial</span>
        <strong>Meta</strong>
        <span>Envios automáticos com mensagens aprovadas. Há custos de envio, conforme as regras da Meta.</span>
        <span className={styles.destino}>{ativo === 'meta' ? 'Conexão escolhida · ver configuração' : 'Ver passo a passo →'}</span>
      </a>
      <a href="/admin/whatsapp?modo=baileys#configuracao" className={styles.modo} aria-current={modo === 'baileys' ? 'page' : undefined}>
        <span className={styles.etiqueta}>Alternativa não oficial</span>
        <strong>Baileys</strong>
        <span>Integração gratuita, sem tarifa da API Meta. Envia automaticamente, mas pode causar bloqueio ou banimento da conta.</span>
        <span className={styles.destino}>{ativo === 'baileys' ? 'Conexão escolhida · ver configuração' : 'Ver conexão por QR Code →'}</span>
      </a>
      <a href="/admin/whatsapp/manual" className={styles.modo}>
        <span className={styles.etiqueta}>Sem envio automático</span>
        <strong>Manual</strong>
        <span>Você abre a conversa, envia pelo seu WhatsApp e marca como enviado. Não precisa conectar uma API.</span>
        <span className={styles.destino}>Abrir envio manual →</span>
      </a>
    </nav>
  </section>;
}

export function ContextoDeEnvio({ canal }: { canal: 'meta' | 'baileys' | null }) {
  return <div className={styles.contexto}>
    <p><strong>Envio automático{canal ? ` · ${canal === 'meta' ? 'Meta' : 'Baileys'}` : ''}</strong><br />
      {canal === 'meta' ? 'Mensagens aprovadas, com custos conforme as regras da Meta.' : canal === 'baileys' ? 'Sem aprovação de mensagens pela Meta. Conexão não oficial, com risco de banimento.' : 'Confira a conexão antes de iniciar os envios.'}
    </p>
    <p><a href="/admin/whatsapp">Configurar WhatsApp</a> · <a href="/admin/whatsapp/manual">Prefiro enviar manualmente</a></p>
  </div>;
}
