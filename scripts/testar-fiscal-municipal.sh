#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# SDK 10 é necessário pelo gerador da dependência OpenAC. O runtime é LTS 10.
DOTNET_FISCAL="${DOTNET_BIN:-dotnet}"
"$DOTNET_FISCAL" test integrations/fiscal-municipal/tests/FiscalMunicipal.Tests.csproj -p:RestoreLockedMode=true --nologo
node scripts/verificar-fiscal-municipal.mjs
"$DOTNET_FISCAL" publish integrations/fiscal-municipal/src/FiscalMunicipal.csproj -c Release -r linux-x64 --self-contained true -p:RestoreLockedMode=true -o integrations/fiscal-municipal/publish --nologo
node --test --import ./apps/api/node_modules/tsx/dist/loader.mjs scripts/ponte-fiscal-real.test.mjs
