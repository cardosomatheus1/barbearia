# DANFSe próprio — NT008 v1.02

A API de DANFSe do ADN foi suspensa em 03/08/2026, conforme a
[NT008 v1.02](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/nt-008-se-cgnfse-danfse-20260714-v1-02.pdf).
O worker agora gera o PDF localmente, a partir do XML autorizado cifrado. A
assinatura da autoridade é verificada antes da representação. O A1 do emitente
não participa da geração do PDF e nenhuma chamada de rede é feita nessa etapa.

O documento usa A4 em uma página, blocos e ordem da NT008, QR Code para consulta
oficial, marca de homologação e campos ausentes representados por traço. Não
completa valores fiscais a partir do cadastro atual. O perfil presencial com
IBS/CBS mostra a classificação, base, alíquotas, totais e tributos aproximados.
Descrição extensa pode receber reticências conforme §2.1; o XML permanece
disponível integralmente. O canhoto opcional foi suprimido.

O PDF fica cifrado no banco. Falha de geração não desfaz autorização fiscal e é
recuperada pela fila. O link público só abre uma nota autorizada. A impressão
interna de nota cancelada é regenerada com a marca d'água `CANCELADA`, usando o
estado de cancelamento confirmado no banco.

## Instalação das fontes

Configure `FISCAL_DANFSE_FONTES_DIR` com caminho absoluto contendo arquivos
licenciados, conforme a exigência tipográfica da NT008:

- `arial.ttf`: Arial regular, para a marca de cancelamento.
- `arial-bold.ttf`: Arial negrito, para títulos e rótulos.
- `microsoft-sans-serif.ttf`: Microsoft Sans Serif, para conteúdo.

Os Composes montam a pasta como somente leitura na API e no worker. Os arquivos
não pertencem ao Git e não são enviados pelos tenants. Não há substituição
automática de fontes em produção. A instalação deve conferir identidade e
licenciamento dos arquivos: o software valida sua leitura e tamanho, não prova a
licença nem autentica a marca comercial da fonte. Sem os arquivos, o PDF fica
pendente e o suporte recebe um motivo identificável.

Nos ensaios locais foram utilizadas Helvetica e Liberation Sans **sintéticas para
o teste tipográfico**, explicitamente injetadas. Isso prova geração, conteúdo,
layout e integração, mas não comprova a instalação das fontes exigidas na
implantação externa.

## Origem dos recursos e limites

Logo e catálogo municipal vêm do portal oficial. URLs e hashes ficam em
`packages/finance/assets/danfse/origem.json`. A UF é derivada do prefixo IBGE,
porque a coluna correspondente está ausente em parte da planilha oficial.
O catálogo de 5.570 registros serve para imprimir localidades; ele não declara
cobertura de emissão por todos os municípios.

`pdfkit` gera o documento e `qrcode-generator` gera o QR Code vetorial. O leitor
`pdfjs-dist` é dependência de desenvolvimento usada para conferir páginas, texto,
link de consulta e renderização. As imagens locais são de notas sintéticas.

O gerador atende os perfis atualmente emitidos pelo software. Representação de
documentos substituídos e de perfis futuros deve acompanhar a implementação
desses fluxos. Documentos com prova cifrada de verificação preservada podem ser
regenerados após rotação do catálogo; documentos antigos sem essa prova precisam
de validação atual e podem ficar indisponíveis se o assinante não puder mais ser
verificado. O registro interno não é um carimbo do tempo ICP-Brasil nem um
arquivo independente de longo prazo. Ver [resposta arquivada](fiscal-resposta-arquivada.md).
