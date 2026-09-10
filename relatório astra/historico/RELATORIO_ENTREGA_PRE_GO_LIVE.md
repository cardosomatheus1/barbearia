# Entrega da auditoria pré-go-live — barbearia

Status: **código preparado para publicação imediata em main, a pedido do proprietário; validação final interrompida**.
Repositório: `cardosomatheus1/barbearia`. Referência anterior publicada: `75a4158`.
O proprietário solicitou interromper os testes e fazer commit/push imediato para `main`. Este registro não declara aprovação integral da fonte final.

## Escopo aplicado

| Área | Implementação |
|---|---|
| Assinaturas SaaS | Stripe para a assinatura da plataforma, cadastro/cartão, autenticação adicional, webhook e conciliação; sem checkout Stripe por barbearia |
| Meta | Conexão oficial recomendada, custos informados, cadastro passo a passo, editor por aviso, templates e regras integrados a campanhas/automações |
| Baileys | Conexão por unidade, textos locais, campanhas/automações, worker e recuperação; sem exigir aprovação de template Meta |
| WhatsApp manual | Fila/Campanhas/Lembretes sem envio automático; subaba com fila persistente, reserva, abertura da conversa, confirmação pelo operador, retomada, descarte, opt-out e histórico; abrir WhatsApp não significa envio confirmado |
| Cadastro/consentimento | Aceite opcional com nome da casa, confirmação pelo cliente autenticado, registro do consentimento, proteção contra reativação por replay e expiração da intenção |
| NFS-e nacional | Emissor direto, certificado A1, assinatura/validação, snapshots cifrados, consulta, cancelamento e DANFSe local para os perfis documentados |
| NFS-e municipal | Motor C# com fonte OpenAC.Net.NFSe MIT incorporada, backend/API/tela, numeração, recuperação e arquivo cifrado; transporte direto às prefeituras |

Retenção de ISS e salão-parceiro foram adiados explicitamente pelo proprietário
para a próxima entrega. Municípios sem adaptador reutilizável não foram
implementados do zero, conforme limitação expressa do escopo.

## Fiscal municipal reutilizado

Fonte OpenAC fixada em `1b09acef0ac4541ed4bab8daf97f804ad8951e3d`, com licença,
hashes dos 659 arquivos originais e seis adaptações de infraestrutura registradas.
O ERP Raiz serviu de referência para o leitor A1; seus emissores NF-e/NFC-e não
foram apresentados como adaptadores NFS-e.

O catálogo tem 198 registros; 136 são elegíveis em produção e 127 em homologação
por análise estática dos métodos e endpoints existentes. Esses números **não são
homologações reais**. A tela orienta o uso do portal quando o município não tem
fluxo completo no catálogo.

A integração arquiva o pedido serializado/assinado antes de transmitir. Após
falha incerta, consulta o RPS ou cancelamento sem reenviar automaticamente.
Consulta e retorno são comparados à unidade, numeração, valores, tomador e datas.
O histórico conserva a primeira resposta e as tentativas de cancelamento.

São Paulo atende o layout 1 sem desconto; operações incompatíveis preservam o
recebimento da comanda e recebem orientação fiscal. O PDF municipal é uma
representação auxiliar, com marca de cancelamento, e o XML original permanece
acessível. Regras especiais, benefícios, outros perfis IBS/CBS e representação
matriz/filial não foram inferidos: a interface documenta os perfis aceitos e
exige certificado do CNPJ completo da unidade.

## Revisão do fluxo WhatsApp

A entrada distingue as três opções, a navegação de consulta não ativa uma conexão e o modo manual avisa que não pausa envios automáticos existentes. A prévia acompanha o texto digitado; botões desmarcados não ativam padrões ocultos. Os três percursos v13 passaram nas quatro larguras, com transportes sintéticos. Ver `AVALIACAO_FLUXO_WHATSAPP.md`.

## Evidências dirigidas já concluídas

- Motor municipal: 34 C# e 2 TAP da ponte real, sem rede fiscal.
- Contrato/banco municipal: 30 testes aprovados em `municipal-integracao-banco-v6`.
- Migração 0136: invariantes SQL cumulativas e 10 testes do cliente de banco.
- Build completo e percurso fiscal de navegador nas larguras 360/390/768/1280.
- Prontidão fiscal P95 73 ms e fechamento com A1/snapshot/fila P95 97 ms;
  20 amostras locais, sem comunicação com o fisco.
- Guardas iniciais aprovadas; 54 testes de guardas fiscais/certificação aprovados.
- Inventário: 398 arquivos de teste identificados, sem arquivo fora de runner.
  Inventário não equivale a contagem de testes executados.

A regressão v15 executou todas as etapas: 4.418 Vitest aprovados e uma falha na guarda estática de permissões; 321 TAP e 34 C# aprovados. As permissões fiscais já existiam: a ordem dos decoradores foi alinhada ao padrão do projeto e os 24 testes dirigidos passaram. A v16 foi interrompida a pedido, com 2410 Vitest e 34 C# aprovados até esse ponto, sem falhas reportadas. Os complementares v16 não começaram. Ver `EVIDENCIAS_CORRECOES_PRE_GO_LIVE/interrupcao-v16-publicacao.json`. Provas anteriores permanecem disponíveis, sem serem apresentadas como aprovação integral da fonte final.

## Validação e ativação externas

Ficam com o proprietário, conforme combinado: credenciais/webhook e cenários
Stripe; números/templates/webhooks/OTP Meta; pareamento e entrega Baileys;
credenciamento e homologação fiscal por município, CNPJ e regime. Confiança
oficial/renovação, fontes do DANFSe, domínio/HTTPS, backup e monitoramento devem
estar configurados no destino. Testes locais usam dados e transportes sintéticos.

Nenhum pagamento, mensagem ou documento fiscal real foi disparado. Publicar
código não aplica migração nem realiza deploy. Publicação imediata em `main` solicitada pelo proprietário; o commit que contém este relatório é a entrega preparada.
