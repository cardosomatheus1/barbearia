@echo off
rem Clique duas vezes neste arquivo.
rem
rem Ele existe porque `scripts/rodar-local.sh` nao roda no Windows: `.sh` nao e
rem executavel la, clicar duas vezes abre o editor de texto, e o PowerShell nao
rem tem `bash`. Este `.cmd` e o que o Windows entende, e ele delega ao Docker --
rem que traz Node, pnpm e PostgreSQL prontos, em vez de exigir as tres
rem instalacoes na maquina.
rem
rem Sem acento no arquivo inteiro de proposito: o console do Windows abre em
rem code page 850, acento vira caractere quebrado, e a mensagem de erro passa a
rem parecer defeito do programa.

setlocal
cd /d "%~dp0"

echo.
echo   Barbearia -- subindo o sistema
echo.

where docker >nul 2>nul
if errorlevel 1 goto sem_docker

docker info >nul 2>nul
if errorlevel 1 goto docker_parado

rem Os segredos sao sorteados aqui e guardados em .env, que fica fora do Git.
rem O compose recusa subir sem eles, de proposito: segredo com valor fixo no
rem repositorio seria segredo publicado.
if not exist ".env" (
  echo   Sorteando os segredos locais...
  powershell -NoProfile -Command ^
    "$b=[byte[]]::new(16); $r=[Security.Cryptography.RandomNumberGenerator]::Create();" ^
    "$hex={param($n) $x=[byte[]]::new($n); $r.GetBytes($x); ($x|%%{$_.ToString('x2')}) -join ''};" ^
    "$b64={$x=[byte[]]::new(32); $r.GetBytes($x); [Convert]::ToBase64String($x)};" ^
    "$linhas=@('# Gerado por RODAR-NO-WINDOWS.cmd. Fora do Git.', ('POSTGRES_PASSWORD=' + (&$hex 16)), ('APP_DB_PASSWORD=' + (&$hex 16)), ('STAFF_EMAIL_PEPPER=' + (&$hex 32)), ('MARKETPLACE_ORIGIN_SECRET=' + (&$hex 32)), ('API_KEY_PEPPER=' + (&$hex 32)), ('MFA_SECRET_KEY=' + (&$b64)), ('WEBHOOK_SECRET_KEY=' + (&$b64)), ('WHATSAPP_TOKEN_KEY=' + (&$b64)));" ^
    "Set-Content -Path '.env' -Value $linhas -Encoding ascii"
  if errorlevel 1 goto sem_env
  if not exist ".env" goto sem_env
)

echo   Construindo e subindo. Na primeira vez leva alguns minutos.
echo   Quando parar de rolar texto, abra no navegador:
echo.
echo       http://localhost:3001
echo.
echo   Entrar no painel:  teste@teste.com  /  testeteste
echo.
echo   Para parar: aperte Ctrl+C nesta janela.
echo.

docker compose --profile demo up --build
echo.
echo   O sistema parou. Feche a janela ou rode este arquivo de novo.
pause
goto fim

:sem_docker
echo   [X] O Docker nao esta instalado.
echo.
echo   Baixe o Docker Desktop, instale, reinicie o computador e rode este
echo   arquivo de novo:
echo.
echo       https://www.docker.com/products/docker-desktop/
echo.
pause
goto fim

:docker_parado
echo   [X] O Docker esta instalado, mas nao esta rodando.
echo.
echo   Abra o Docker Desktop pelo menu Iniciar, espere o icone da baleia
echo   ficar verde, e rode este arquivo de novo.
echo.
pause
goto fim

:sem_env
echo   [X] Nao consegui gerar o arquivo .env com os segredos locais.
echo.
echo   Crie um arquivo chamado .env nesta pasta com quatro linhas, trocando
echo   os valores por texto aleatorio seu:
echo.
echo       POSTGRES_PASSWORD=troque-por-algo-aleatorio
echo       APP_DB_PASSWORD=troque-por-algo-aleatorio
echo       STAFF_EMAIL_PEPPER=troque-por-algo-aleatorio
echo       MARKETPLACE_ORIGIN_SECRET=troque-por-algo-aleatorio
echo       API_KEY_PEPPER=troque-por-algo-aleatorio
echo       MFA_SECRET_KEY=base64-de-32-bytes
echo       WEBHOOK_SECRET_KEY=base64-de-32-bytes
echo       WHATSAPP_TOKEN_KEY=base64-de-32-bytes
echo.
pause

:fim
endlocal
