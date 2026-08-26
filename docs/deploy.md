# Ir ao ar

> O que comprar, o que apontar e o que rodar. Do VPS vazio ao produto no ar em
> um comando — e a volta atrás pronta antes de precisar dela.

## 1. O que comprar

Duas coisas, e nenhuma delas é VPN. **VPN é túnel de rede privada e não hospeda
nada**; o que hospeda é um **VPS** — uma máquina Linux com IP público.

| O quê | Onde | Quanto | O que olhar |
|---|---|---|---|
| **Domínio** | Registro.br (`.com.br`, exige CPF/CNPJ) ou Cloudflare/Namecheap (`.com`) | ~R$ 40/ano | o `.com.br` passa confiança no Brasil e é o que o cliente digita |
| **VPS** | Vultr, Hostinger, Magalu Cloud ou AWS Lightsail — **região São Paulo** | ~R$ 60–120/mês | 2 vCPU, **4 GB de RAM**, 60 GB de disco, Ubuntu 24.04 |

**Por que São Paulo importa.** O painel é renderizado no servidor: cada tela é
uma ida do navegador ao VPS e dele ao banco. Num servidor nos Estados Unidos são
uns 120 ms a mais em cada uma, e a recepção sente — ela abre a mesma tela
trezentas vezes por dia. Para o cliente que agenda uma vez por mês, quase não
muda.

**Por que 4 GB.** Na mesma máquina rodam Postgres, a API, o worker, o site e o
porteiro. Com 2 GB o build da imagem já aperta, e o Postgres é o primeiro a ser
morto pelo sistema quando a memória acaba — o que aparece como "o site caiu" sem
nada no log da aplicação.

**Sobre dado de brasileiro.** A LGPD não exige que os dados fiquem no Brasil,
mas a barbearia é a controladora e você é o operador: hospedar aqui encurta
qualquer conversa sobre transferência internacional, e o produto já traz o
encarregado por barbearia (`tenants.dpo_name/dpo_email`, público por exigência
do art. 41 §1).

## 2. O DNS, antes de tudo

No painel do domínio, um registro:

```
Tipo   Nome   Valor
A      @      <o IP do seu VPS>
A      www    <o mesmo IP>        (opcional)
```

O certificado TLS é emitido pelo Let's Encrypt, que **confere o domínio pedindo
uma requisição de volta**. Sem o registro A apontando para a máquina, o
certificado não sai e o site fica sem HTTPS — com o erro escondido no log de um
contêiner. Por isso `deploy/instalar.sh` confere o DNS na primeira linha e para
com uma frase em vez de deixar isso para depois.

> Se usar Cloudflare, deixe a nuvem **cinza** (só DNS) até o certificado sair. A
> nuvem laranja intercepta a validação.

## 3. O comando

Na máquina, como root:

```bash
curl -fsSL https://raw.githubusercontent.com/cardosomatheus1/barbearia/claude/barbershop-app-research-xvejhy/deploy/instalar.sh \
  | bash -s -- barbearia.com.br voce@email.com
```

> O endereço acima carrega o script de uma branch específica porque é preciso
> nomear uma para baixar o arquivo. O que ele **instala** é a branch padrão do
> repositório, resolvida no remoto — nome de branch escrito no script seria a
> lista paralela de sempre, e quebraria no dia em que alguém renomeasse.

Ele instala o Docker se faltar, clona o repositório em `/opt/barbearia`, **gera
os segredos obrigatórios**, aplica as 118 migrações, sobe os cinco serviços, espera o
site responder e agenda o backup diário.

Roda de novo sem estragar nada: os segredos já gerados são preservados. Não é
conforto — regerar `MFA_SECRET_KEY` tornaria ilegível o segundo fator de todo
mundo, e regerar `STAFF_EMAIL_PEPPER` faria ninguém mais conseguir entrar,
porque é ele que indexa o login.

### A conta que falta

Uma coisa não nasce de nenhuma rota, de propósito: a conta da **plataforma** —
a que bloqueia barbearia inadimplente, troca plano e liga recurso.

```bash
cd /opt/barbearia
docker compose -f deploy/compose.yml --env-file .env run --rm \
  -e SUPER_ADMIN_PASSWORD='<uma senha longa>' api \
  node scripts/criar-super-admin.mjs "Seu Nome" voce@email.com --operador
```

Sem `--operador` a conta nasce `viewer`, que só lê. É por essa conta que você
liga a **nota fiscal** para uma barbearia, quando houver emissor contratado.

## 4. O que fica no ar

```
                      internet
                         │  80 / 443
                   ┌─────▼─────┐
                   │   caddy   │  TLS automático
                   └──┬─────┬──┘
              /api/*  │     │  todo o resto
                 ┌────▼─┐ ┌─▼─────┐
                 │ api  │ │  web  │  SSR, fala com a api por dentro
                 └───┬──┘ └───┬───┘
                     │        │
                 ┌───▼────────▼───┐      ┌────────┐
                 │       db       │◄─────┤ worker │  fila, avisos, cobrança
                 └────────────────┘      └────────┘
```

**Nada além do Caddy tem porta na internet.** O banco não é alcançável de fora;
quem precisa dele entra na máquina. A API é falada de servidor para servidor
dentro da rede do compose, e o `/api/*` público existe só para o que **tem** que
vir de fora: o webhook do adquirente e as chaves de API.

## 5. Atualizar, e voltar

```bash
deploy/atualizar.sh    # backup → migração → imagem nova → confere
deploy/voltar.sh       # sobe a anterior; o banco não é tocado
```

A volta é barata por uma razão específica: **toda migração deste repositório é
aditiva**, então a versão de ontem roda contra o banco de hoje. Isso é cobrado
no portão por `packages/db/test/migracao-aditiva.test.mjs`, que varre as 83
migrações atrás de `DROP TABLE`, `DROP COLUMN`, `RENAME`, mudança de tipo e
`SET NOT NULL`.

A outra volta — restaurar o backup — é só para quando a **migração** corrompeu
algo, e ela perde o que foi escrito depois do dump. Está medida em
`docs/go-live.md`: 2,7 s para 30 mil clientes.

## 5.1 Atualizar sozinho

```bash
deploy/auto-atualizar.sh --ligar       # a cada 5 min, a cada commit novo
deploy/auto-atualizar.sh --desligar
tail -f /var/log/barbearia-deploy.log  # o que ele fez
```

Ele pergunta ao GitHub se a branch padrão andou. Andou, sobe — pelo mesmo
`atualizar.sh` de sempre, com backup antes de migrar.

**Sem portão do lado de fora, a rede de segurança fica aqui dentro**, em três
camadas:

1. a migração falha → `atualizar.sh` para antes de trocar a imagem, e o site
   nunca sai do ar;
2. a versão nova sobe e **não responde** → o script volta sozinho para a
   anterior;
3. o commit que quebrou é anotado e **nunca é tentado de novo** — sem isso o
   laço seria sobe, quebra, volta, sobe de novo em cinco minutos, com o site
   piscando a cada volta do cron.

Quando o GitHub Actions estiver rodando na conta, `--ligar --exigir-esteira`
troca isso pelo mais seguro: só sobe commit que a esteira aprovou. Enquanto a
esteira não roda, exigir o verde significaria **nunca subir** — e um deploy que
nunca acontece é pior que um deploy sem rede.

**Não é webhook de propósito.** Webhook exigiria guardar uma chave do servidor
no GitHub e abrir um endereço que aceita chamada de fora. Perguntando de dentro
não há segredo guardado em lugar nenhum nem porta nova: continua 80 e 443 e mais
nada. O custo é até cinco minutos de latência entre o push e o ar.

## 6. O backup

Diário, às 04:17, quinze dias de retenção, com o arquivo conferido antes de a
rotação apagar os antigos.

**Ele fica na mesma máquina até você configurar para onde mandá-lo**, e o script
avisa isso em toda execução. Backup no mesmo disco cobre o erro humano
("apaguei o cliente errado") e **não cobre** o caso que tira a barbearia do ar,
que é a máquina sumir. Para resolver:

```bash
apt install rclone && rclone config          # um bucket, um Drive, o que for
echo 'BACKUP_REMOTO="meubucket:barbearia"' >> /opt/barbearia/.env
```

Com `MEDIA_STORAGE=local`, o backup diário sai em **duas partes inseparáveis e criptografadas**:
`barbearia-*.dump.enc` (PostgreSQL) e `barbearia-*-media.tar.gz.enc` (imagens do volume
`/data/media`). O dump/tar em claro existe apenas durante geração e validação local; depois é
cifrado com AES-256-GCM usando `BACKUP_ENCRYPTION_KEY`, autenticado e removido antes de qualquer
upload/rotação.

Com `MEDIA_STORAGE=s3`, as imagens não moram no VPS e o script **não** cria um tar
vazio fingindo ter copiado o bucket. Configure versionamento/retention no S3/R2/
MinIO e mantenha o dump PostgreSQL em destino remoto.

Para restaurar, primeiro decifre **localmente** com a mesma chave do `.env`:

```bash
set -a; . /opt/barbearia/.env; set +a
node /opt/barbearia/scripts/backup-crypto.mjs decrypt \
  /var/backups/barbearia/barbearia-CARIMBO.dump.enc /tmp/barbearia.dump
node /opt/barbearia/scripts/backup-crypto.mjs decrypt \
  /var/backups/barbearia/barbearia-CARIMBO-media.tar.gz.enc /tmp/barbearia-media.tar.gz
```

Depois restaure o banco com `pg_restore` e, no modo local, a mídia:

```bash
cat /tmp/barbearia-media.tar.gz \
  | docker compose -f /opt/barbearia/deploy/compose.yml --env-file /opt/barbearia/.env \
      exec -T api tar -C /data/media -xzf -
rm -f /tmp/barbearia.dump /tmp/barbearia-media.tar.gz
```

A `BACKUP_ENCRYPTION_KEY` é parte do próprio backup: perder essa chave torna os artefatos
irrecuperáveis. Guarde uma cópia dela fora do VPS, em cofre de segredos.

E, uma vez, ensaie a volta **neste servidor** — não aqui, não na máquina de
desenvolvimento. É o item que continua aberto no go/no-go, e o único jeito de
saber que o backup presta é restaurá-lo.

## 7. O que ainda depende de você

| Integração | Como liga | Sem ela |
|---|---|---|
| **Adquirente** | `PSP_MODO=stripe` + `STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET` no `.env` | a plataforma fatura e você registra o pagamento que viu no extrato |
| **Nota fiscal** | emissor contratado + `FISCAL_MODO`, e o toggle no Super Admin por barbearia | a nota não é oferecida, e não aparece no painel |
| **WhatsApp** | conta na Meta, empresa verificada, número cadastrado por barbearia | o aviso cai no canal de reserva |

O webhook da Stripe aponta para `https://SEU_DOMINIO/api/v1/webhooks/psp` — o
segredo dele é **próprio**, porque a Stripe gera um por endereço.

## 7.1 Mídia em object storage

O modo local funciona sem serviço externo. Para usar object storage privado S3
compatível — AWS S3, Cloudflare R2 ou MinIO — configure com:

```bash
cd /opt/barbearia
deploy/configurar-midia-s3.sh \
  'https://SEU-ENDPOINT-S3' \
  'barberdock-media' \
  'ACCESS_KEY' \
  'SECRET_KEY' \
  'auto'
```

A URL vista pelo cliente **não muda**: continua `https://SEU_DOMINIO/media/...`.
O bucket pode e deve permanecer privado; a API assina as chamadas internamente.
Depois de configurar, habilite versionamento/retention no provedor e envie uma
foto de teste em **Fotos e marca**.

## 8. O primeiro tenant

Multi-tenant não tem "go live": tem o **primeiro tenant**. Uma barbearia só,
acompanhada diariamente — e o acompanhamento é por **consulta ao banco**, não
por ausência de erro no log. A razão está escrita em `docs/go-live.md` §5: um
gatilho ficou inerte por dois commits, sem erro e sem log.

As perguntas do dia: a comissão saiu? o consentimento gravou? o aviso foi
entregue? a comanda fechou com o caixa aberto?
