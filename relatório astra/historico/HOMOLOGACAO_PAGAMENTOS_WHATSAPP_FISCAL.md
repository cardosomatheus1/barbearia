# Integrações — evidência e homologação pendente

Versão examinada: `3d90fc62de2947fda05aed32407d5a2f2852340b`, em 09/09/2026.

O proprietário definiu lançamento completo com pagamentos, WhatsApp e fiscal; informou fiscal ainda não implementado, pagamentos por configurar e liberação total da Meta obtida. A auditoria confirmou as lacunas de código abaixo. A aprovação Meta foi registrada como informação do proprietário, sem solicitar novamente essa aprovação.

Nenhuma conta/sandbox de provedor foi disponibilizada para esta execução. Os testes locais usam bancos sintéticos, providers desativados ou respostas simuladas declaradas pelo teste. **Não houve cobrança, estorno externo, emissão de nota, submissão de template ou envio de mensagem real.** Não há integração externa homologada por esta auditoria.

| Capacidade | Código e prova local | Situação para lançamento completo | Aceite externo necessário |
|---|---|---|---|
| Comanda — Pix | Adapter Stripe, webhook e reconciliação presentes; suites locais e contrato do adapter examinados | Configuração e homologação pendentes | Criar Pix, pagar, expirar/cancelar, perder/repetir evento, reconciliar e conferir comanda/caixa/valor liquidado |
| Comanda — cartão | Intenção criada sem captura/confirmação acessível ao usuário; AUD-01 | Bloqueado por implementação | Captura segura, aprovação, recusa, autenticação adicional, abandono, conciliação e estorno |
| Comanda — link hospedado | Checkout Session implementada, com retorno configurável | Configuração e homologação pendentes | Abrir checkout em dispositivo do cliente, concluir/cancelar, webhook tardio/duplicado, conciliação, isolamento de conta e estorno |
| Estorno de pagamento externo | Contratos e fluxo local presentes | Não certificado contra adquirente | Parcial/total conforme oferta, reenvio, timeout depois da aceitação, eventos fora de ordem, caixa fechado, comissão/estoque/fiscal consistentes |
| Cobrança do SaaS | Adapter/ciclo da plataforma distinto da cobrança da barbearia | Configuração e homologação pendentes | Contratação, recorrência, troca de plano, prorrata quando prevista, inadimplência, bloqueio/reativação e conciliação |
| Clube de assinatura da barbearia | Worker usa provider que recusa; tokenização pendente; AUD-03 | Automação externa ausente | Cadastro do instrumento sem PAN/CVV, consentimento/mandato, cobrança, retry, suspensão, cancelamento e expiração do instrumento |
| Split/recebedores | Provider simulado mantém pendência e recusa repasse; AUD-03 | Integração real ausente | KYC, conta vinculada, autorização de recebimento, taxas, liquidação, reentrega e estorno de repasse |
| Sinal do agendamento | Decisão/política e registro manual presentes; cobrança online e devolução constam como lacuna no roadmap | Fluxo online não certificado/pendente | Cobrança vinculada à reserva antes de existir comanda, confirmação e devolução conforme política, sem duplicidade |
| NFS-e da barbearia | Provider somente `nenhum`/`fake`; produção recusa fake; AUD-02 | Bloqueado por implementação | Provedor, município/regime/emitente; emissão, rejeição, consulta após timeout, reentrega, cancelamento, documento e vínculo com venda |
| NF-e/NFC-e de revenda | Documento de mercadoria consta como lacuna própria | Definir aplicabilidade com contabilidade; não presumir cobertura pela NFS-e | Credenciamento e regras estaduais, emissão/cancelamento e separação correta de serviço/produto |
| Fiscal do próprio SaaS | Distinto do documento emitido pela barbearia; lacuna declarada | Definir documento/processo da empresa operadora | Contabilidade da plataforma, emitente, cobrança e documento correspondente |
| WhatsApp — cadastro de conta/número | Embedded Signup, cadastro e provider Meta presentes; aprovação Meta informada pelo proprietário | Homologação pendente | Conta/número corretos por tenant/unidade, permissões, webhook público, assinatura e revogação/reconexão |
| WhatsApp — templates, avisos, campanhas | Fluxos locais, assinatura e estados examinados nas suites | Homologação pendente | Submeter/aprovar template, enviar a destinatário autorizado, receber `sent/delivered/read/failed`, rejeição, opt-out, limites e janela de atendimento |
| WhatsApp — OTP/acesso da equipe | Provider de identidade separado do canal de CRM | Homologação pendente | Template/canal configurados, entrega real, expiração/reenvio, rate limit e ausência de credencial em logs |
| WhatsApp — filiais | Conciliação periódica usa somente `primaryLocation`; AUD-14 | Bloqueado para certificação de múltiplas contas/unidades | Matriz e filial com números próprios, retorno e conciliação corretos, sem mistura de templates/credenciais |
| Agendamento por conversa no WhatsApp | Webhook registra resposta; não foi encontrado despacho desse texto ao agente conversacional. A conversa do site é outra superfície | Não presumir que o percurso web certifica WhatsApp conversacional | Fechar o caminho mensagem → intenção/proposta → aceite → reserva e confirmação, incluindo duplicidade, disputa e transferência para humano |

## Sequência para homologar após corrigir o código

1. Proprietário e responsáveis financeiro/fiscal definem contas, meios, documentos, recebedores, localidades e capacidades efetivamente vendidas. Isso não reduz o escopo fiscal já solicitado.
2. Engenharia prepara ambientes separados e configura os segredos fora do repositório; confirma URLs públicas e assinatura de webhooks, com configuração identificável por versão.
3. Executa cada cenário da matriz com dados sintéticos/destinatários autorizados em ambiente apropriado, registrando IDs técnicos não sensíveis, horário e estados local/externo. Não armazenar cartões, tokens, conteúdo pessoal ou documento fiscal de cliente no relatório.
4. Confere efeitos no banco, provedor, caixa, comissão, estoque e relatórios; repete falhas e eventos duplicados/atrasados. Uma resposta HTTP 200 isolada não encerra o cenário.
5. Anexa o resultado ao novo SHA candidato, retesta achados e emite novo parecer. Ativação em produção requer autorização própria e smoke controlado.

**Estado final desta matriz:** homologação externa pendente. A ausência dessa prova é um bloqueio de liberação, separado dos defeitos já reproduzidos no código.
