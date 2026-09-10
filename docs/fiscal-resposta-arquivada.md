# Confiança da resposta e documento arquivado

Uma nova autorização ou confirmação de cancelamento passa por XSD, assinatura
XML, comparação ao pedido, pin independente do assinante e validação atual de
cadeia/revogação com OpenSSL. A prontidão e a transmissão também exigem ao menos
um assinante do catálogo com cadeia válida. Ter um A1 válido não comprova que o
certificado da autoridade continua válido.

As raízes e CRLs vêm de `FISCAL_CONFIANCA_DIR`. Para o caminho das autoridades,
o arquivo público `cadeias.pem` contém intermediárias; o atualizador descrito
em `fiscal-renovacao-confianca.md` o produz na mesma geração. Na configuração
manual, forneça esse arquivo quando houver intermediárias. A lista de pins
`FISCAL_AUTORIDADES_PEM_B64` continua separada: confiar em uma CA não concede
autoridade fiscal a todos os certificados emitidos por ela.

O recebimento grava, junto com o XML cifrado, um registro também cifrado e
autenticado contendo hash do XML, certificado usado, data da verificação e
hashes do catálogo de raízes/CRLs consultado. A migração 0131 protege esse
registro contra alteração e vincula sua existência ao documento correspondente.
O contexto criptográfico vincula barbearia, unidade, nota e tipo de documento.

A geração posterior do DANFSe confere esse registro, o hash do XML e novamente
a assinatura com o certificado arquivado. Assim, a troca do catálogo atual ou
o vencimento posterior do certificado não apagam a capacidade de reproduzir
o documento já recebido. Cancelamento continua definido pelo estado fiscal;
a impressão interna de uma nota cancelada recebe sua marca de cancelamento.
Uma resposta nova continua sujeita ao catálogo e à revogação atuais.

Documentos anteriores à migração não ganham evidência retroativa. Se ainda
forem verificáveis pela confiança atual, a geração pode registrar essa nova
verificação com a data em que ela ocorreu. Se não forem, a operação recusa e
preserva o XML para conferência. Não altera datas nem inventa uma aprovação antiga.

Esse registro é evidência interna protegida da verificação feita pelo software.
Ele não é carimbo do tempo ICP-Brasil nem substitui um serviço de validação de
longo prazo. Os hashes não arquivam o conteúdo integral das CRLs antigas; uma
verificação independente futura precisa da preservação externa desses catálogos
e das políticas de revogação, inclusive eventual comprometimento retroativo.
Não se atribui validade jurídica nova a um documento por conseguir gerar seu PDF.

Testes locais exercitam autoridade revogada, cadeia inválida, nova resposta com
certificado expirado, isolamento da prova, XML alterado, imutabilidade no banco,
rotação do catálogo e PDF histórico. Os certificados são sintéticos.
