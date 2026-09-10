# Baileys no Barberdock — implementação local e validação

**Implementação local entregue; conexão com número real ainda não homologada.**
QR, sessão cifrada, envio manual, campanhas, automações, recebimento de PARAR e
frontend passaram no ensaio com API/web e processo completo do worker. A rede
WhatsApp foi simulada. O proprietário autorizou publicar esta entrega parcial
em `master`; não houve deploy. As seções
abaixo preservam o plano e a evolução das provas; o estado geral está em
[STATUS_PRE_GO_LIVE_ATUAL.md](STATUS_PRE_GO_LIVE_ATUAL.md).

Mandato: alternativa à Meta para números das unidades, campanhas, automações e
interface. Referência inspecionada: ERP Raiz, Baileys 6.7.24. A integração de
referência tem boas fronteiras de socket, persistência cifrada, posse por lease,
identidade PN/LID e confirmação de envio; seu singleton e schema por tenant não
servem diretamente ao RLS e às múltiplas unidades do Barberdock.

## Comportamento pretendido

- Uma escolha de canal por unidade. A seleção explícita impede fallback que
  mude o remetente ou contorne uma falha de template. A configuração da Meta é
  preservada quando o operador escolhe Baileys.
- Baileys conecta por QR com prazo, oferece reconexão e desconexão e mostra o
  motivo operacional. QR e chaves não vão para logs nem relatórios. Só o worker
  mantém sockets; a API registra comandos no banco.
- Mensagens do Baileys são textos locais editáveis, com variáveis e prévia.
  Não se inventa aprovação da Meta. O cadastro distingue canal e disponibilidade;
  campanhas/automação selecionam mensagens compatíveis com o canal atual.
- Consentimento, saída das promoções, janela de silêncio e limites por cliente
  continuam valendo. Ausência de aprovação de template não significa envio sem
  restrições nem imunidade a bloqueio da conta pelo WhatsApp.
- Botões exclusivos da Meta precisam de alternativa real: links para a agenda
  e resposta textual correlacionada ao aviso. Uma resposta ambígua não cancela
  horário automaticamente. PARAR revoga marketing sem depender de agendamento.
- Envio só é confirmado após aceitação externa. ID local da mensagem não é
  confirmação. Timeout após início do envio fica incerto, sem reenvio cego.
  Eventos atrasados reconciliam o resultado e não fazem o estado regredir.
- Número, credenciais e eventos são isolados por tenant/unidade/geração. Lease
  renovável e escritas com fencing impedem dois workers de usar a mesma sessão;
  desconexão ou perda da posse fecha o socket e impede novos envios.
- Frontend mostra resumo do canal, ação principal e mensagens. Detalhes técnicos
  e configuração do outro canal ficam recolhidos. QR não permanece após expirar.

## Entrega e prova

1. Contratos, migração RLS e armazenamento cifrado de sessão/outbox.
2. Runtime com socket injetável: pareamento, reinício, conflito, reconexão,
   número vinculado, ACK, recebimento e mensagens de saída.
3. Roteamento de todos os consumidores, incluindo avisos que hoje só usam
   console (nota fiscal, recado, clube e lista de espera). Sem falso sucesso.
4. API com permissões, auditoria e segredos protegidos; mensagens locais,
   campanhas e automações consistentes com o canal.
5. Frontend e percursos de navegador nas quatro larguras.
6. Testes unitários, Postgres real/RLS, concorrência e API; contrato da versão
   real da biblioteca sem abrir socket externo; verify e ensaios completos.

Não houve autorização para conectar números reais ou enviar mensagens neste
ensaio. A prova local usa socket sintético e não equivale a validação externa.
Commit/push à principal permanece condicionado ao término das demais atividades
e às verificações pedidas pelo usuário.


## Prova local em 10/09

O ensaio atualizado `baileys-browser-fila-corrigida` passou com envio manual pela
tela, criação de campanha e automação, consumo pela função real `rodada` da fila,
ACK sintético, QR expirado, campos preservados em erro, desconexão e quatro
larguras. Confere claim, handler, conclusão e liberação do claim. O processo main
completo do worker não foi executado neste ensaio. O frontend preserva os detalhes
recolhidos e a configuração Meta ao trocar de canal. Uma atualização tardia após
desconectar já não desfaz a seleção ainda não salva do operador.

Runtime/posse/LGPD passaram em testes dirigidos. A cota promocional do retorno
agora usa a mesma reserva de campanha/automação/manual. A opção de senha de acesso
foi retirada do editor da unidade: a identidade usa mensageria da plataforma.

Recuperação da oferta e descoberta acima de 100 rotas passaram em testes de banco.
Anonimização remove também conteúdo de tentativas em transmissão/incertas e não
permite que recibos tardios restaurem o dado. Permanecem o resultado da regressão
integral em curso, os ensaios operacionais e homologação com número de teste
autorizado. A revisão fiscal universal ainda está aberta.

## Prova com processo completo — 10/09, 06h50 UTC

`baileys-worker-completo-final` passou. O navegador operou API/web reais e o
processo `apps/worker/dist/main.js` executou os handlers reais, runtime, fábrica
e armazenamento de autenticação da biblioteca. Apenas `makeWASocket`, na fronteira
de rede, foi substituído por um socket sintético. Não foi necessário alterar
código de produto para instalar essa substituição; o carregador existe só em output.

Foram conferidos: QR expirado/renovado, conexão, texto local, envio manual, campanha
e automação criadas pela tela, confirmação, estados da fila e retirada do claim,
PARAR recebido e consentimento revogado, desconexão, retorno à Meta e quatro
larguras. Capturas `baileys-worker-conectado-390.png` e
`baileys-worker-automacoes-1280.png` foram inspecionadas visualmente.

Esta prova complementa a anterior, que não executava o main completo. Continua
sendo um ensaio local: não houve pareamento real nem envio à rede WhatsApp.
