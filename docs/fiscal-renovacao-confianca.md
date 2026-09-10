# Renovação automática das raízes e CRLs fiscais

O atualizador baixa exclusivamente fontes escolhidas pela instalação, confere
certificados por SHA256 do DER, verifica cadeia/CRLs com OpenSSL e publica os
arquivos em uma única troca atômica. O A1 do cliente não fornece URLs nem raízes
confiáveis. Não há descoberta automática de novas autoridades.

O manifesto público fica fora do Git, com o seguinte formato:

```json
{
  "version": 1,
  "cas": [
    { "id": "raiz", "root": true, "url": "https://fonte-oficial/certificado", "sha256": "SHA256_DO_DER_CONFERIDO" },
    { "id": "intermediaria", "root": false, "url": "https://fonte-oficial/intermediaria", "sha256": "SHA256_DO_DER_CONFERIDO" }
  ],
  "crls": [
    { "issuer": "raiz", "url": "https://fonte-oficial/lista-raiz" },
    { "issuer": "intermediaria", "url": "https://fonte-oficial/lista-intermediaria" }
  ]
}
```

Esses endereços e hashes são marcadores, não uma configuração utilizável.
Configure cada nível da cadeia efetivamente usado. A seleção inicial exige
conferência em canal oficial independente. Novas raízes ou certificados de CA
exigem atualização explícita do manifesto; repetir o download não os autoriza.
Certificados podem ser PEM/DER. CRLs também podem ser PEM/DER e, se a autoridade
somente oferecer HTTP, esse transporte é aceito para CRLs, que continuam sendo
autenticadas por assinatura. Certificados exigem HTTPS. Não são aceitos
redirecionamentos, credenciais na URL, portas alternativas ou IPs privados.

Execução única, no ambiente que receberá os arquivos:

```sh
node scripts/fiscal-confianca-atualizar.mjs --once /caminho/fontes-fiscais.json /caminho/fiscal-confianca
```

O modo `--loop` repete a verificação a cada 15 minutos. O override
`deploy/fiscal-confianca.compose.yml` adiciona esse processo ao Compose de
produção. Ele recebe somente o manifesto e o diretório de confiança; não recebe
banco, A1, senha, chave de cifragem ou credenciais dos outros canais. Ativá-lo e
preencher as fontes oficiais são ações de implantação, não realizadas pela auditoria.
O manifesto e o diretório devem existir no host antes de iniciar o serviço.

`FISCAL_CONFIANCA_MANIFESTO` aponta para o arquivo no host e
`FISCAL_CONFIANCA_DIR` para o diretório persistente. Os caminhos relativos do
override usam o diretório do Compose principal. API/worker montam esse mesmo
diretório apenas para leitura. Eles resolvem `current` uma vez por validação,
para não misturar raiz de uma geração com CRLs de outra. A instalação anterior,
com `raizes.pem`/`crls.pem` diretamente no diretório, permanece compatível; um
apontador `current` quebrado falha e não recorre aos arquivos antigos.

Uma CRL só é publicada se estiver vigente por mais uma hora, sua assinatura for
válida e sua data/número não retrocederem frente à geração anterior. Cada nível
é conferido contra as raízes autorizadas, incluindo a revogação das próprias
intermediárias. Nova revogação de A1 é aceita e passa a bloquear esse A1 no próximo
uso. Uma falha de download ou verificação preserva o material anterior, que
continua sujeito ao vencimento. Nunca se remove uma revogação para recuperar emissão.

`flock` impede atualizadores concorrentes; a morte do processo solta o lock sem
remoção manual. São necessários OpenSSL 3 e util-linux, incluídos na imagem.
Material sem mudança não cria nova geração. Gerações com mais de sete dias são
limpas pelo próprio atualizador, preservando a atual. O healthcheck recusa uma
instalação sem verificação bem-sucedida há uma hora ou com CRL próxima de expirar.
Monitore o healthcheck e o código `fiscal_confianca_atualizacao_falhou`; a aplicação
continua recusando CRLs vencidas independentemente da saúde do atualizador.

Os testes usam PKI sintética, com OpenSSL real: pin divergente, assinatura
adulterada, indisponibilidade, expiração, revogação, rollback, concorrência e
leitura da geração publicada. Não constituem prova de instalação ICP-Brasil real.
