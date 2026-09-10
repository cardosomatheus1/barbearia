# Transferência do trabalho do agente auxiliar

Em 10/09/2026 o proprietário pediu interromper o único auxiliar e continuar sem
agentes. `/root/whatsapp_manual_fluxos` foi interrompido; a continuidade pertence
ao agente principal. Nenhum novo auxiliar será iniciado sem novo mandato.

O trabalho está no clone de `cardosomatheus1/barbearia`, branch
`fix/pre-go-live-baileys-stripe-20260910`. As alterações abaixo estão locais,
sem commit/push desta continuação e sem ativação externa.

## Implementação encontrada

- Migração 0132: textos e fila manual, vínculo com campanhas/automações,
  idempotência, integridade, reserva por operador e registro de confirmação.
- Domínio em `packages/crm/src/manual`, integração nos despachos de campanhas e
  automações e cotas promocionais compartilhadas com os canais automáticos.
- API manual com permissões e unidade da sessão; subaba WhatsApp manual com
  fila, campanhas, automações, abertura de conversa, confirmação explícita,
  liberação, descarte, opt-out, histórico e retomada por gestor.
- Formulários preservam o texto após recusa. Ações menos frequentes ficam
  recolhidas. Abrir conversa não registra envio nem entrega/leitura.
- Cadastro público: checkbox opcional e desmarcado com nome da barbearia;
  migração 0134 guarda intenção com texto/versão/IP por 30 minutos. Marketing
  exige confirmação por sessão do cliente autenticada por OTP. Agendamento
  anônimo não reativa consentimento de telefone existente. Avisos contratuais
  mantêm o funcionamento anterior, explicado na interface.
- Revisão adicional dos percursos Meta e Baileys, com transportes simulados.

## Evidência conferida pelo principal

Arquivos em `output/EVIDENCIAS_CORRECOES_PRE_GO_LIVE/`:

| Evidência | Resultado registrado |
|---|---|
| `manual-fila-regressao` | 80 testes aprovados em manual/campanhas/automações |
| `manual-fila-privacidade` | 33 testes aprovados em manual/LGPD |
| `manual-api-fluxo-corrigido` | 2 cenários HTTP aprovados |
| `consentimento-cadastro-api` | 2 cenários HTTP aprovados, 49 fora do filtro |
| `manual-navegador-final` | Campanha e automação manual, reserva/retomada/confirmação/opt-out; quatro larguras |
| `baileys-revisao-final` | Percurso de navegador com transporte/socket simulado; consultar log para passos |
| `meta-revisao-final` | Campanha, automação, texto indisponível e estados de envio; quatro larguras, FakeWhatsAppProvider |
| `whatsapp-consentimento-build` | Build completo aprovado antes dos ajustes visuais finais |

Essas execuções validam as versões existentes na hora de cada comando; não
substituem a regressão sobre a fonte final. As tentativas anteriores reprovadas
foram preservadas. Nenhum pareamento, mensagem WhatsApp real ou aprovação Meta
foi produzido.

## Trabalho assumido pelo principal

- Revisar fonte e migrações, inclusive concorrência, opt-out, expiração e
  isolamento do novo consentimento.
- Corrigir/reexecutar `whatsapp-tipos-finais` (exit 2) e `whatsapp-guardas`
  (exit 1), sem tratá-los como aprovação.
- Corrigir a prévia manual de campanha/automação, que ainda mostra `{{1}}`
  cru; a guarda de prévia da web reprovou esse caso.
- Executar `prova_consentimento_navegador.py`, ainda sem evidência aprovada
  encontrada na transferência, incluindo OTP simulado e confirmação final.
- Fazer novo build após os últimos ajustes, repetir percursos afetados e
  incorporar tudo à regressão, medição, revisão de segurança e publicação final.

As pendências fiscais, operacionais e de publicação do principal continuam
válidas e estão separadas nos relatórios gerais; interromper o auxiliar não
encerrou nenhuma delas.

## Continuidade do principal após a transferência

- Tipos de CRM/API/jobs e 199 testes da web aprovados. Guardas SQL e Node
  corrigidas/reexecutadas com resultado aprovado.
- Prévia manual agora substitui as variáveis por exemplos. Build web
  `web-consolidado-build` e percurso `manual-navegador-pos-revisao` aprovados.
- Consentimento público conferido no navegador. A revisão adicional reproduziu
  duas falhas antes da correção: vínculo SQL com cliente errado e resposta de
  erro depois de a reserva já ter sido confirmada. Migração 0134 protege vínculo
  e texto; a API preserva a reserva e a tela oferece o caminho das preferências.
  `consentimento-integridade-api`: cinco casos aprovados, 49 fora do filtro.
  `consentimento-integridade-navegador-isolado`: cadastro, OTP, confirmação e
  recuperação da falha nas quatro larguras. A tentativa anterior com slug
  reaproveitado encontrou cache de outro banco efêmero; cada ensaio agora usa
  slug exclusivo, sem alterar a regra do produto.
- Confirmações em abas diferentes usam a trava do cliente antes do pedido,
  compatível com a ordem da anonimização. Replay após revogação não reativa o
  aceite. Intenções distintas continuam exigindo confirmação explícita por OTP;
  não se presume aceite por repetição do agendamento.
- Vínculo de criação da fila manual com o template da automação protegido no
  banco. A revisão reproduziu a inserção indevida antes da correção. Edição
  posterior da automação preserva o snapshot já preparado. `manual-origem-validada`:
  13 cenários de banco aprovados.

Esses resultados encerram os itens específicos de transferência acima, mas a
regressão integral sobre a fonte final e as demais pendências do projeto seguem
abertas. O auxiliar permanece interrompido.

## Retomada autorizada em 10/09, durante a verificação

O usuário reautorizou apenas um auxiliar. A revisão dirigida identificou e
corrigiu a unidade dos limiares no resumo manual e o aviso de ativação no replay
de aceite já consumido. API devolve novoAceite; página/ação respeitam replay.
Acrescentou teste da retenção de intenções expiradas e ampliou os dois pilotos.
`consentimento-replay-web-unit`: três casos aprovados. Nenhum build ou teste de
banco/navegador foi executado pelo auxiliar nesta rodada; o principal assumiu
essas validações. Não houve novo commit/push.

## Validação final dirigida pelo principal — 16:27 UTC

- `consentimento-replay-build`: build completo, saída 0.
- `consentimento-replay-api`: cinco casos selecionados aprovados; 49 fora do filtro.
- `consentimento-retencao-crm`: um caso selecionado aprovado; 22 fora do filtro.
- `consentimento-replay-browser`: cadastro opcional, OTP sintético, confirmação,
  replay após revogação e recuperação da falha aprovados nas quatro larguras.
- `manual-limiares-browser`: campanha, retomada, confirmação pelo operador,
  limites em estrelas/unidades/zero e automação com opt-out aprovados nas quatro larguras.
- Prints de cadastro, replay e fila/manual examinados pelo principal. Nenhuma rede WhatsApp.
- Inventário atualizado: 392 arquivos, zero sem runner; isso não substitui os
  resultados da regressão v9, ainda em andamento.

O único auxiliar concluiu também uma pesquisa oficial somente leitura sobre
assinatura e matriz/filial. Não há outros auxiliares ativos. O resultado está em
`REVISAO_CONTRATOS_FISCAIS_20260910.md`.

## Verificação municipal final — 10/09, 18:55 UTC

O único auxiliar concluiu leitura dos limites fiscais, cancelamento, histórico e
PDF, sem executar suítes nem alterar arquivos. Identificou divergência indevida
de inscrição municipal SP com zeros à esquerda, corrigida pelo principal com
teste de integração. Orientações sobre CNPJ completo do A1 e perfil IBS/CBS
presencial foram explicitadas na tela. Não encontrou outro defeito concreto
nesses trechos. Retenção de ISS e salão-parceiro foram adiados pelo proprietário.
