# A imagem que roda o produto inteiro numa máquina só.
#
# ## Por que ela existe
#
# `scripts/rodar-local.sh` exige Node 22, pnpm e um PostgreSQL 16 com três
# extensões — quatro instalações e outras tantas chances de errar, e no Windows
# ele nem roda, porque `.sh` não é executável lá. Quem recebeu o projeto para
# **olhar** não deveria precisar montar um ambiente de desenvolvimento antes.
#
# Aqui dentro vai tudo: Node, pnpm, o cliente do Postgres e o repositório
# construído. O `docker-compose.yml` junta com o banco, e o comando é um só.
#
# ## Uma imagem, não três
#
# API, worker e web saem do mesmo build porque **são o mesmo monorepo**: os três
# importam os mesmos pacotes de `packages/`, e separar produziria três imagens
# com o mesmo conteúdo e três builds a manter em sincronia. O compose sobe três
# serviços a partir dela, cada um com o seu comando — que é onde a separação
# realmente importa, porque um pode cair e reiniciar sem os outros.
FROM node:22-bookworm-slim

# `postgresql-client` porque os scripts do repositório falam com o banco por
# `psql`: bootstrap do role e as migrações são SQL, e reescrevê-los em JS só
# para caber no contêiner criaria um segundo caminho para o mesmo trabalho —
# e é o segundo caminho que sai de sincronia sem ninguém ver.
# `curl` é a sonda de pronto do próprio script.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client curl ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# O lockfile e os manifestos primeiro: enquanto nenhuma dependência muda, o
# Docker reaproveita a camada de instalação e um `docker compose up` depois de
# editar código não baixa nada de novo.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json          packages/core/
COPY packages/db/package.json            packages/db/
COPY packages/db/prisma/schema.prisma    packages/db/prisma/
COPY packages/ui/package.json            packages/ui/
COPY packages/scheduling/package.json    packages/scheduling/
COPY packages/identity/package.json      packages/identity/
COPY packages/onboarding/package.json    packages/onboarding/
COPY packages/catalog/package.json       packages/catalog/
COPY packages/finance/package.json       packages/finance/
COPY packages/jobs/package.json          packages/jobs/
COPY packages/crm/package.json           packages/crm/
COPY packages/platform/package.json      packages/platform/
COPY apps/api/package.json               apps/api/
COPY apps/web/package.json               apps/web/
COPY apps/worker/package.json            apps/worker/

# O `postinstall` de `packages/db` gera o cliente do Prisma — por isso o
# `schema.prisma` sobe junto com os manifestos, e não com o resto do código.
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm -r build

# Documentação, não publicação: quem abre a porta é o compose.
EXPOSE 3000 3001
