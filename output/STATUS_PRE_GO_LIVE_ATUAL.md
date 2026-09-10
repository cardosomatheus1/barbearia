# Pré-go-live — estado atual em 10/09/2026

**Lançamento completo ainda não aprovado.** Há código e provas locais para Stripe
SaaS, Baileys e NFS-e nacional própria, mas a cobertura fiscal universal solicitada
não está concluída. Testes externos não foram executados.

Alvo: `cardosomatheus1/barbearia`, base `3d90fc62de2947fda05aed32407d5a2f2852340b`,
desenvolvido na branch local `fix/pre-go-live-audit-20260909`. O proprietário
autorizou agora um primeiro commit/push em `master`, antes de concluir o fiscal,
e outro após as correções restantes. Este relatório acompanha essa primeira
entrega. A branch padrão remota consultada é `claude/barbershop-app-research-xvejhy`;
`master` será criada pela publicação. Nenhum deploy foi realizado. ERP Raiz usado
como referência e não alterado.

| Frente | Entrega local | Limite atual |
|---|---|---|
| Stripe SaaS | Cadastro hospedado, consentimento, cobrança reservada antes da rede, recuperação, 3DS do mesmo PI, webhook e conciliação | Credenciais/configuração e homologação Stripe não exercitadas nesta sessão. Stripe não recebe pagamentos das comandas |
| Pagamentos das lojas — fora desta entrega | Separação da conta Stripe do SaaS, recusa explícita de integração ausente, fakes proibidos em produção | Proprietário esclareceu que não precisa dos pagamentos online das barbearias nesta etapa. Stripe permanece exclusivamente para assinaturas SaaS |
| Baileys | QR por unidade, sessão cifrada, posse exclusiva, outbox, ACK, PN/LID, consentimento/opt-out, textos locais, campanhas, automações e frontend | Socket sintético; número real não pareado. Prova de navegador passou com main completo do worker e fábrica real; só o socket de rede foi substituído |
| Meta | Integração preservada; conciliação das unidades e separação dos textos de cada canal | Liberação Meta informada pelo proprietário; operação real do app/número/webhook não homologada nesta sessão |
| Fiscal próprio | A1/cadeia intermediária, DPS/XMLDSig/XSD, mTLS, snapshot/numeração, emissão/consulta/cancelamento, XML/DANFSe e frontend | MEI e Simples com ISS no DAS, sem retenção. Sem adaptadores municipais para os demais casos; sem homologação externa. Validação local de confiança ICP-Brasil/CRL e assinatura criptográfica da resposta fiscal permanecem abertas |
| Auditoria geral | Correções de migração, grants no restore, deploy por SHA, prontidão, isolamento de segredos, proxy/IP, relógios, rateio e integrações | Pilha, conferidores, proxy, restore, backup cifrado e rollback locais passaram. Docker/Compose real e infraestrutura produtiva não exercitados |

## Validação

A regressão integral **v6 passou**, exit 0, entre 07h53 e 08h41 UTC de 10/09:
29 verificações iniciais e 102 etapas de typecheck, build e testes. Os resumos
dos runners registram **4.266 casos Vitest e 313 TAP aprovados**, sem falhas,
cancelamentos ou testes pulados. As invariantes SQL também passaram; seus asserts
não entram nessas contagens. A identidade de toda a fonte permaneceu estável.

Suítes de aplicação: core 1.435, UI 90, web 191, cliente DB 10, identidade 208,
scheduling 286, onboarding 18, catálogo 53, financeiro 544, CRM 428, jobs 101,
plataforma 262 e API 545. O resumo por etapa e os hashes dos logs estão em
`EVIDENCIAS_CORRECOES_PRE_GO_LIVE/regressao-final-v6-resumo.json`.

A v3 anterior passou nas suítes, mas saiu 1 por duas verificações estáticas;
essas falhas foram corrigidas e a v6 substitui aquele resultado parcial.

Os conferidores adicionais revelaram IDs repetidos no catálogo e títulos ausentes
nos estados de recusa. Essas correções também passaram pelo build e navegador.
O conferidor financeiro duplicava receita de pacote e a semente mantinha a nota
antiga da vitrine; reparados sem alterar o cálculo financeiro do produto.

A v4 foi interrompida intencionalmente para corrigir o log fiscal. A v5 também
foi interrompida (exit 130): a revisão ampliada reproduziu exposição de tokens de
fila/oferta na API e em logs de acesso, redirecionamento e erro do Caddy.
A API agora registra o padrão da rota; o Caddy omite URI e cabeçalhos de pedido
e resposta em ambos os logs. A prova passou em 11 caminhos e erro 502, e a API
passou em 27 testes de log, incluindo quatro cenários HTTP que falharam antes.
Caddy/Next/API também passaram novamente após adaptar o conferidor ao padrão
de rota sem slug. A v6 repetiu o gate inteiro com fonte estável e resultado verde.
Os 380 arquivos de testes (320 JS/TS e 60 SQL)
têm runner identificado. O novo escalonamento foi testado com três falhas deliberadas:
preservou todos os códigos de saída e o limite de concorrência.

A medição `medicao-fonte-v6` passou após a v6, exit 0, em 659,29 segundos, em
banco local separado. Ela repetiu navegador/carga após os últimos ajustes de log
e fatura. As métricas abaixo são dessa execução final, encerrada às 08h52 UTC.
A comparação posterior confirmou a mesma fonte do verify v6. `git diff --check`
passou; `segredos-estado-v6` passou na árvore atual e no histórico Git às 08h53 UTC.

Ensaios aprovados nesta rodada:

- Medição: build completo, telas em quatro larguras, 10 percursos, worker retomado
  após SIGKILL. Agenda com P95 365 ms e 840 horários ocupados. Disputa: 1 criação,
  99 conflitos 409, zero 500 e replay idempotente.
- Conferência: números por domínio, 30 telas com dados e 36 destinos visíveis;
  recusa do gerente verificada separadamente em quatro larguras.
- Remarcação e cancelamento pelo navegador, com confirmação no banco.
- Proxy real Caddy/Next/API: IPs distintos mantêm cotas próprias e falsificação
  de cabeçalhos não renova a cota nem revela a credencial interna.
- Restore: 142 tabelas, 173 políticas, 138 tabelas com FORCE RLS, schema e grants;
  login real da aplicação e dois tenants exercitados.
- Dump real cifrado/decifrado/restaurado: conteúdo idêntico, schema, login/RLS;
  corrupção e chave errada recusadas sem arquivo parcial.
- Baileys no main completo do worker: QR, mensagem manual, campanha, automação,
  confirmação, recebimento de PARAR, desconexão, retorno à Meta e quatro larguras.
  Biblioteca de auth e fábrica reais; transporte externo sintético.
- Stripe SaaS e cadastro fiscal no navegador; contratos HTTP/SDK sintéticos.
- Transporte fiscal com intermediária obrigatória em servidor TLS local.
- Rollback com 30 mil clientes e 90 mil lançamentos; estrutura e conteúdo restaurados.

Os tempos de recuperação são locais, sem promessa de RTO produtivo. A cobertura
fiscal universal e as homologações externas permanecem abertas. A matriz
`PENDENCIAS_FISCAIS_PROPRIAS.md` distingue implementação faltante de prova externa.

O verify verde executou todos os testes inventariados, mas não significa cobertura
de todos os fluxos possíveis. Ainda faltam provas completas pelo navegador para
lista de espera/oferta/aceite, walk-in até atendimento/fechamento, compra e consumo
de pacote/ciclo operacional de clube e duas unidades simultâneas. Pagamentos e
estornos online das lojas foram retirados deste aceite pelo esclarecimento do
proprietário. O checkout de venda avulsa e o fluxo de cliente que remarca
e cancela já têm prova própria. As configurações produtivas de OTP central e
Turnstile também não foram homologadas nesta sessão.

As pendências gerais, incluindo essas diferenças de cobertura, estão consolidadas
em `PENDENCIAS_PRE_GO_LIVE_ATUAIS.md`.

## Evidências e condição de publicação

Comandos e resultados ficam em `EVIDENCIAS_CORRECOES_PRE_GO_LIVE/`;
histórico de achados/correções em `CORRECOES_PRE_GO_LIVE.md`;
fonte e inventários nos arquivos `FONTE_CORRECOES_PRE_GO_LIVE.json`,
`INVENTARIO_TESTES_CORRECOES_PRE_GO_LIVE.json` e
`INVENTARIO_CORRECOES_PRE_GO_LIVE.json`.

O mandato mais recente autoriza publicar esta entrega parcial em `master` agora,
seguida de outro commit/push após o fiscal e as validações locais restantes.
A homologação externa ficará com o proprietário. A publicação deste código não
declara conclusão do fiscal universal nem aprovação do lançamento completo.

Na preparação do primeiro commit, a verificação do índice incluiu pela primeira
vez os arquivos novos. `git diff --cached --check` aponta somente espaços/CRLF
originais dos XSD oficiais e linhas de contexto do patch unificado da libsignal.
Esses artefatos foram preservados sem alteração; o restante do índice passou.
Detalhes em `EVIDENCIAS_CORRECOES_PRE_GO_LIVE/diff-primeira-publicacao.json`.
A nova varredura `segredos-pre-publicacao` também passou.
