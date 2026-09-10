# Simples Nacional com ISS fora do DAS

O cadastro do emissor permite escolher o recolhimento municipal do ISS para
empresa ME/EPP optante pelo Simples. O padrão permanece ISS no DAS. A escolha
fica em `fiscal_native_settings.iss_outside_das` (migração 0133), aparece no
formulário e é congelada com a nota antes da transmissão.

Neste perfil, os tributos federais continuam no Simples e a DPS informa
`opSimpNac=3` e `regApTribSN=2`. Os percentuais aproximados federal, estadual e
municipal são obrigatórios para habilitar a emissão e usam o grupo `pTotTrib`.
Não se reaproveita o percentual total do DAS nem se calcula o imposto a recolher
a partir desses percentuais informativos.

Quando o enquadramento exigir também os tributos federais fora do DAS, a terceira
opção do formulário registra `federaisForaDas`/`federal_outside_das` (migração
0135) e a DPS informa `regApTribSN=3`, mantendo `opSimpNac=3`. O banco e o domínio
recusam federais fora do DAS com ISS no DAS. As duas escolhas são congeladas no
snapshot; mudar o cadastro não altera documentos já preparados. Esse perfil
também exige os três percentuais informativos. Não há motor de apuração de
tributos federais nem retenções implícitas.

O perfil continua restrito a serviço sem retenção em município ativo no emissor
nacional. A alíquota municipal é determinada pelo emissor, sem `pAliq` na DPS,
conforme E0635. Município sem emissor nacional é recusado antes de transmitir.
A escolha não implementa retenções, benefícios nem adaptação
a emissores municipais próprios.

A referência é o Anexo I SEFIN/ADN DPS/NFS-e SNNFS-e v1.01 de 09/02/2026,
campo `regApTribSN` e regras E0635/E0640. O contribuinte precisa confirmar o
enquadramento com seu contador. Os testes locais validam XML pelo bundle
documentado, snapshot e isolamento em PostgreSQL, API e comportamento da tela;
o aceite pela autoridade depende da homologação externa do proprietário.
