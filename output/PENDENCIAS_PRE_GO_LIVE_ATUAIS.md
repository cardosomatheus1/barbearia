# Pendências do lançamento — 10/09/2026

Repositório correto: `cardosomatheus1/barbearia`. O ERP Raiz foi referência e não recebeu alterações desta entrega.

## Implementação entregue nesta rodada

| Pedido | Estado do código |
|---|---|
| Stripe para o SaaS | Assinatura, cadastro/cartão, autenticação adicional, webhook e conciliação; sem checkout Stripe por barbearia |
| Meta e Baileys | Integrações por unidade, textos de cada conexão, campanhas, automações, recuperação e frontend |
| Área WhatsApp fácil de entender | Meta recomendada e com custos; Baileys gratuito e com risco de banimento; manual sem envio automático. Cadastro Meta passo a passo e conteúdo avançado recolhido |
| Fila manual | Preparação de campanhas/lembretes, reserva/retomada, abertura da conversa, confirmação do operador, liberação/descarte, opt-out e histórico |
| Consentimento público | Aceite opcional com nome da casa, confirmação autenticada, trilha, expiração e replay sem reativar consentimento revogado |
| Fiscal próprio nacional | Certificado A1, confiança/CRLs, XML assinado, consulta/cancelamento, arquivo cifrado e DANFSe local nos perfis documentados |
| Fiscal municipal reutilizado | Motor OpenAC MIT incorporado, transporte direto, backend/API/tela, numeração, recuperação e arquivo cifrado |

Os três percursos WhatsApp v13 passaram com API/web/banco reais e transporte sintético. O proprietário interrompeu a regressão integral v16 para solicitar commit/push imediato. A única falha da v15 foi corrigida e os 24 testes dirigidos passaram. Permanecem sem conclusão a rodada v16 e os complementares finais de Docker/Compose, percursos, medição, restauração, rollback, backup cifrado, fuso, segredos e dependências.

## Próxima entrega e limites

Retenção de ISS e salão-parceiro foram adiados expressamente pelo proprietário. Municípios sem adaptador reutilizável estão fora do recorte solicitado; não há promessa de cobertura fiscal universal. O catálogo municipal tem 198 registros, 136 elegíveis em produção e 127 em homologação por análise estática.

Outros perfis IBS/CBS além do atendimento presencial, benefícios/situações fiscais especiais e representação matriz/filial não são inferidos. O A1 deve corresponder ao CNPJ integral da unidade. NF-e/NFC-e de mercadorias e documentos do próprio SaaS não fazem parte do emissor NFS-e da barbearia. Ver `PENDENCIAS_FISCAIS_PROPRIAS.md`.

## Homologação e ativação externas

O proprietário assumiu a homologação: credenciais/webhook/cobrança Stripe; cadastro/número/templates/webhook/OTP Meta; pareamento/entrega/reconexão Baileys; CNPJ/regime/município/A1, emissão, consulta, rejeição, timeout e cancelamento fiscal. Configurar confiança oficial e sua renovação, fontes DANFSe, domínio/HTTPS, Turnstile, backup e monitoramento no destino também depende da implantação.

Nenhum teste local transmite mensagem real, cobra ou emite nota. Publicação de código não aplica migrações nem realiza deploy.

## Publicação e evidências

A base `75a4158` está publicada em master. Publicação imediata em `main` solicitada pelo proprietário, sem aguardar o restante das validações. Estado corrente: `STATUS_PRE_GO_LIVE_ATUAL.md`. A avaliação de uso está em `AVALIACAO_FLUXO_WHATSAPP.md`; comandos, resultados e limites da validação estão registrados em `RELATORIO_ENTREGA_PRE_GO_LIVE.md`.
