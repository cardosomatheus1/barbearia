# Evidências da auditoria pré-go-live

Estado atual: [STATUS_PRE_GO_LIVE_ATUAL.md](STATUS_PRE_GO_LIVE_ATUAL.md).
Pendências: [PENDENCIAS_PRE_GO_LIVE_ATUAIS.md](PENDENCIAS_PRE_GO_LIVE_ATUAIS.md).
Limites fiscais: [PENDENCIAS_FISCAIS_PROPRIAS.md](PENDENCIAS_FISCAIS_PROPRIAS.md).

A primeira publicação em `master` foi autorizada antes da conclusão fiscal.
Ela contém código validado, relatórios, scripts de prova, inventários e resumos
das verificações finais. O verify v6 e a medição final passaram com a mesma fonte.
Homologação externa fica com o proprietário; não houve deploy nesta execução.

Logs completos e a coleção de capturas permanecem no ambiente local de auditoria;
não são necessários para instalar ou executar o produto. Relatórios históricos
podem referenciar esses artefatos locais. Os resumos finais versionados contêm
comandos, resultados e hashes dos logs. Scripts de prova usam bancos sintéticos
e alguns dependem das ferramentas locais indicadas em seus caminhos; nunca se
devem executá-los contra dados produtivos.

Nenhum estado de autenticação local, certificado de cliente, segredo ou dump
de banco faz parte desta publicação.
