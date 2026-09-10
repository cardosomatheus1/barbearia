# NFS-e: não optante pelo Simples Nacional

O perfil `normal` representa `opSimpNac=1` na DPS. Ele não determina Lucro Real ou
Presumido e não calcula apuração federal. O fluxo atual contempla serviço sem
retenção, benefício ou regime especial em município que confirme participação
no emissor nacional. IBS/CBS e demais situações permanecem no plano fiscal.

A unidade informa três percentuais aproximados da Lei 12.741/2012: federal,
estadual e municipal. São informativos; não substituem ISS devido nem retenções.
Não há valor padrão. Zero precisa ser informado explicitamente. Cada percentual
deve estar entre 0 e 100%, com até duas casas decimais, armazenado como inteiro
em pontos-base. A migração `0128_nfse_nao_optante.sql` exige os três valores juntos
ou todos nulos. Não muda dados de notas já emitidas.

O cadastro, a API e a geração do documento exigem os percentuais antes de habilitar
o perfil. O snapshot os guarda ao solicitar a nota: mudar o cadastro depois não
altera uma DPS pendente ou autorizada. O formulário só mostra esses campos para
não optante; as opções de perfil vêm da lista do domínio.

Referência: Anexo I SEFIN/ADN DPS/NFS-e v1.01, publicação de 09/02/2026, obtida do
portal oficial da NFS-e. O XML passa no XSD oficial preservado no repositório.

- E0162: não informar `regApTribSN` para não optante ou MEI.
- E0617: não informar `pAliq` para não optante com município de incidência ativo;
  a alíquota vem da parametrização municipal. O fluxo recusa município que não
  confirme o emissor nacional antes de transmitir a DPS.
- E0706/E0707/E0708: percentuais aproximados entre 0 e 100%.
- E0713: não optante não informa `indTotTrib` nem `pTotTribSN`; usa o grupo
  `pTotTrib` com as três esferas.

Passar no XSD e nos testes locais não comprova habilitação do CNPJ, aceitação
pela autoridade nem cobertura de todos os municípios. O documento vigente e a
aplicabilidade de IBS/CBS devem ser considerados no fechamento fiscal e na
homologação externa conduzida pelo proprietário.
