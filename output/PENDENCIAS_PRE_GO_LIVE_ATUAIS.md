# Pendências do pedido de lançamento completo — 10/09/2026

Alvo: `cardosomatheus1/barbearia`. Esta lista consolida o que permanece aberto
no pedido atual e acompanha a primeira publicação parcial autorizada em `master`.
O ERP Raiz foi referência e não foi alterado.

## Implementação

1. **Fiscal próprio para todos os municípios e perfis solicitados.** O emissor
   nacional atual cobre MEI e Simples com ISS no DAS, sem retenção. Faltam
   adaptadores municipais, outros regimes/retenções, salão-parceiro, IBS/CBS,
   CNPJ alfanumérico/representação matriz-filial, confiança ICP-Brasil e revogação,
   assinatura criptográfica da autoridade na resposta e confirmação normativa
   dos algoritmos. Ver `PENDENCIAS_FISCAIS_PROPRIAS.md` para os limites precisos.

**Escopo de pagamentos esclarecido pelo proprietário:** Stripe apenas para
receber as assinaturas do SaaS. Pagamentos online de cada barbearia foram retirados
da lista de entregas desta etapa; não se exige implementar gateway, KYC ou split
das lojas para encerrar essa integração. A indisponibilidade desses mecanismos
continua explícita no código; registro manual no caixa permanece separado.

## Prova externa e configuração do lançamento

O proprietário assumiu a homologação externa. Esses itens continuam necessários
para ativação, mas não bloqueiam a primeira publicação de código autorizada.

- **Stripe SaaS:** configurar conta/credenciais/webhook e exercer cadastro do
  cartão, cobrança, autenticação 3DS, recusa, conciliação e estorno no ambiente
  de testes da Stripe. Código e contratos locais passaram; não houve rede Stripe.
- **Baileys:** parear número de teste, exercer envio/recebimento, campanha,
  automação, reconexão/reinício e opt-out na rede WhatsApp. A prova local passou
  com main/fábrica/auth reais e socket simulado; não houve número real pareado.
- **Meta:** aproveitar a liberação informada pelo proprietário, configurar e
  validar app/número/webhook/templates e entrega real. Liberação de acesso não
  prova os fluxos desta instalação. OTP central tem configuração própria e
  também precisa de entrega real quando exigido pelo agendamento.
- **Fiscal:** CNPJ/município/regime de homologação, certificado A1 configurado
  fora do Git e provas oficiais de emissão, rejeição, consulta após timeout,
  duplicidade, cancelamento e documento. Isso complementa o código ainda faltante.
- **Cadastro:** configurar/verificar Turnstile no domínio de destino. O mecanismo
  possui testes; conta/chaves/configuração produtiva não foram exercitadas.

## Testes e operação

- **Concluído:** verify integral v6, exit 0, fonte estável, 29 guardas iniciais,
  102 etapas, 4.266 casos Vitest e 313 TAP aprovados; invariantes SQL aprovadas.
  Os 380 arquivos de testes têm runner. Contagens são dos resumos de execução,
  não uma alegação de cobertura integral do produto.
- **Concluído:** medição `medicao-fonte-v6`, após as últimas correções, exit 0,
  com build, API/web/worker, queda/retomada, quatro larguras e 10 percursos.
  Carga com 840 horários ocupados e P95 365 ms. Na concorrência: 1 reserva,
  99 conflitos 409, zero 500 e confirmação do banco/replay idempotente.
- **Aceite de navegador ainda parcial:** faltam percursos completos de lista de
  espera/oferta/aceite, walk-in/atendimento/fechamento, compra/consumo de pacote e
  ciclo operacional de clube e duas unidades simultâneas. Há testes de domínio/API,
  que não substituem esses percursos. Cobrança/estorno online das lojas não fazem
  parte do aceite desta etapa após o esclarecimento do proprietário.
  Venda avulsa/caixa, remarcação/cancelamento do cliente e Baileys/Stripe têm provas
  próprias; a prova fiscal pelo navegador cobre configuração e certificado.
- **Infraestrutura:** executar imagem/Compose reais e verificar configuração,
  segredos, HTTPS, prontidão, atualização/rollback e backup no ambiente de destino.
  Caddy/Next/API/worker, backup cifrado, restore e rollback de dados passaram em
  ensaios locais. Docker/Compose e infraestrutura produtiva não foram exercitados.

## Publicação

O proprietário autorizou um primeiro commit/push em `master` imediatamente e
outro depois de finalizar o fiscal e as validações locais restantes. Essa instrução
substitui a condição anterior de esperar toda a implementação. A branch padrão
remota consultada é `claude/barbershop-app-research-xvejhy`; `master` será criada
para esta entrega. Deploy e ativação externa não ocorreram.

O Baileys com frontend/campanhas/automações e o Stripe SaaS estão implementados
localmente. Não há autorização fiscal emitida nem mensagem ou cobrança real
produzida por esta execução. Testes verdes do que existe não encerram as lacunas
de implementação e de aceite listadas acima.
