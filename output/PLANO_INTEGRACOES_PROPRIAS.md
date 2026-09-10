# Continuação das integrações e auditoria

**Atualização de autorização em 10/09:** publicar o estado validado em `master`
agora, continuar fiscal/validações locais e publicar novo commit ao concluir.
Homologação externa fica com o proprietário. Isso substitui a condição anterior
de aguardar todo o trabalho antes da primeira publicação, preservada abaixo como
histórico do plano.

Mandato atualizado em 2026-09-09: concluir todas as atividades anteriores,
fiscal próprio aproveitando o Raiz, Stripe só para assinaturas do SaaS e,
depois do fiscal/revisão da auditoria, Baileys como alternativa à Meta.
Commit e push para a branch principal da **barbearia** autorizados ao final,
condicionados à conclusão e aos testes aprovados. O ERP Raiz é referência.
Essa autorização não solicita mensagens externas, cobranças, emissão fiscal
real ou alterações de dados produtivos durante o desenvolvimento.

## Ordem e critérios

1. Concluir adaptação fiscal própria: certificados, DPS, validação XML, mTLS,
   emissão/consulta/cancelamento, persistência de tentativas e documentos,
   credenciais por unidade sob RLS, configuração e estados no frontend.
   Distinguir suporte nacional do emissor de habilitação efetiva do município;
   não sinalizar cobertura não comprovada. Homologação externa deve ficar
   explícita, sem protocolo ou autorização fabricados.
2. Finalizar as correções da auditoria, a assinatura SaaS por Stripe e rever
   impactos sobre os fluxos existentes. Preservar os relatórios históricos.
3. Inspecionar o Baileys do Raiz e planejar a adaptação antes de editar o fluxo
   principal de WhatsApp. A implementação deve contemplar:
   - conexão por número e unidade, QR/link, sessão cifrada, isolamento entre
     tenants, reconexão, revogação e exclusão da sessão;
   - contrato comum com capacidades explícitas por canal: Meta usa templates
     e aprovação; Baileys usa mensagens próprias, com conteúdo e estado
     modelados para esse canal;
   - automações, campanhas, avisos transacionais, consentimento, opt-out,
     idempotência, limites operacionais e recuperação depois de falha;
   - entrega, erro e recebimento traduzidos para estados compreensíveis;
   - frontend com escolha de integração e revelação das opções pertinentes,
     evitando misturar aprovação Meta com a edição de mensagens Baileys.
4. Regressão final após todas as implementações, com fonte estável: todos os
   testes automatizados, migrações locais, builds/types, segurança, navegador,
   números/telas, desempenho sem concorrência, proxy, backup/restore/rollback.
   Inventário e evidências devem distinguir executado, falhou e não executado.
5. Conferir diff e branch remota atual; commit e push somente depois de atender
   às condições autorizadas. Não publicar uma conclusão parcial como go-live.

## Estado atualizado em 10/09

- Raiz reaproveitado como referência para A1, assinatura e ciclo fiscal; a emissão
  de NFS-e não estava implementada naquele repositório. Provas do reaproveitamento em
  `REAPROVEITAMENTO_RAIZ.md`.
- Emissor nacional próprio ligado a API/worker/tela com XSD, mTLS, numeração,
  snapshot, emissão/consulta/cancelamento, XML/DANFSe. Cobertura parcial;
  homologação externa e expansão municipal/regimes permanecem abertas.
- Stripe SaaS com cadastro hospedado, reserva antes da rede, recuperação da mesma
  tentativa, confirmação 3DS na tela, webhook e conciliação. Cobrança de comanda,
  clube e split não usam a conta Stripe do SaaS.
- O proprietário esclareceu que pagamentos online de cada barbearia não precisam
  entrar nesta etapa. Implementar adquirente/KYC/split das lojas não é condição
  de conclusão da integração Stripe solicitada.
- Baileys ligado por unidade com sessão cifrada, QR, posse do socket, ACK, outbox,
  campanhas, automações e opt-out. A tela separa opções de cada canal. Número real
  não foi homologado nesta sessão.
- Testes dirigidos, navegador sintético e instalação limpa passaram. A regressão
  integral v6 passou com fonte estável, 4.266 casos Vitest e 313 TAP, além das
  invariantes SQL. Medição final v6 também passou. Isso não fecha as lacunas de
  cobertura de navegador nem a homologação externa; ver
  `PENDENCIAS_PRE_GO_LIVE_ATUAIS.md`.
- Commit e push principal continuam condicionados à conclusão e à validação.
