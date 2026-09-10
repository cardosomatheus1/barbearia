"""Compose de produção em projeto descartável local, sem integrações externas.

Requer imagem barbearia-auditoria:20260910 previamente construída pelo Dockerfile
real. Usa CA local do Caddy, portas de loopback e segredos aleatórios temporários.
Não lê .env do checkout, não semeia clientes e remove apenas seu próprio projeto.
"""
from pathlib import Path
import base64, json, os, re, secrets, subprocess, tempfile, time, uuid

root = Path(__file__).resolve().parents[1]
tools = Path('/home/ec2-user/codex-tmp/barbearia-audit-tools')
docker = str(tools / 'docker/docker')
socket = 'unix:///tmp/barbearia-docker-run/docker.sock'
project = 'bbaudit' + uuid.uuid4().hex[:10]
image = 'barbearia-auditoria:20260910'
env = {k: os.environ[k] for k in ('PATH', 'LANG') if k in os.environ}
env.update(DOCKER_HOST=socket, DOCKER_CONFIG=str(tools / 'docker-config'), NO_PROXY='*')
name = 'barbearia-audit.test'
web = 'https://' + name + ':18443'
base = (root / 'deploy/compose.yml').read_text()
required = set(re.findall(r'\$\{([A-Z_]+):\?', base))
settings = {key: secrets.token_hex(32) for key in required}
for key in ['MFA_SECRET_KEY', 'WHATSAPP_TOKEN_KEY', 'WEBHOOK_SECRET_KEY', 'BACKUP_ENCRYPTION_KEY']:
    settings[key] = base64.b64encode(secrets.token_bytes(32)).decode()
settings.update(DOMINIO=name, ACME_EMAIL='auditoria@example.invalid', APP_VERSION='audit-local',
    PSP_MODO='nenhum', COMANDA_PSP_MODO='nenhum', FISCAL_MODO='nenhum', WHATSAPP_MODO='nenhum',
    BAILEYS_HABILITADO='0', BOT_PROTECTION_MODO='nenhum', IDENTITY_MESSAGING_MODO='console')

def execute(args, *, capture=False, check=True):
    r = subprocess.run(args, cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode and check:
        text = r.stdout
        for value in settings.values():
            if len(value) >= 16:
                text = text.replace(value, '[SEGREDO_SINTETICO]')
        print(text[-6000:])
        raise RuntimeError('Comando Docker/Compose falhou: ' + str(r.returncode))
    return r.stdout if capture else r.returncode

with tempfile.TemporaryDirectory(prefix='barbearia-compose-') as directory:
    temp = Path(directory)
    for folder in ('confianca', 'fontes'):
        (temp / folder).mkdir()
    settings.update(FISCAL_CONFIANCA_DIR=str(temp/'confianca'), FISCAL_DANFSE_FONTES_DIR=str(temp/'fontes'))
    envfile = temp/'teste.env'
    envfile.write_text(''.join(k+'='+v+'\n' for k,v in settings.items()))
    envfile.chmod(0o600)
    caddy = temp/'Caddyfile'
    caddy.write_text((root/'deploy/Caddyfile').read_text().replace('{\n', '{\n\tlocal_certs\n', 1))
    # As únicas adaptações são imagem já construída, endereço local e CA local.
    # Migrations, comandos, dependências, healthchecks e roteamento são os reais.
    override = temp/'compose.yml'
    services = ['validar','preparar','api','worker','web']
    body = 'services:\n'
    for service in services:
        body += '  '+service+':\n    image: '+image+'\n    pull_policy: never\n'
        if service != 'preparar':
            body += '    environment:\n      WEB_URL: '+web+'\n'
    body += '''  caddy:
    ports: !override
      - '127.0.0.1:18080:80'
      - '127.0.0.1:18443:443'
    volumes:
      - '''+str(caddy)+''':/etc/caddy/Caddyfile:ro
'''
    override.write_text(body)
    compose = [docker,'compose','-p',project,'--env-file',str(envfile),'-f',str(root/'deploy/compose.yml'),'-f',str(override)]
    try:
        cfg = json.loads(execute(compose+['config','--format','json'],capture=True))
        assert not cfg['services']['db'].get('ports')
        assert not cfg['services']['api'].get('ports')
        assert not cfg['services']['web'].get('ports')
        assert all(p['host_ip']=='127.0.0.1' for p in cfg['services']['caddy']['ports'])
        assert all(cfg['services'][s]['environment']['FISCAL_MODO']=='nenhum' for s in ['api','worker'])
        print(json.dumps({'etapa':'compose-config','resultado':'passou'}),flush=True)
        execute(compose+['up','-d','--no-build','--wait','--wait-timeout','240'])
        expected = len(list((root/'packages/db/migrations').glob('*.sql')))
        sql = compose+['exec','-T','db','psql','-U','postgres','-d','barbearia','-X','-tAc']
        assert int(execute(sql+['SELECT count(*) FROM schema_migrations'],capture=True).strip()) == expected
        assert execute(sql+['SELECT count(*) FROM tenants'],capture=True).strip() == '0'
        print(json.dumps({'etapa':'subida-sem-seed','migracoes':expected,'resultado':'passou'}),flush=True)
        execute(compose+['exec','-T','worker','node','scripts/worker-pronto.mjs'])
        execute(compose+['exec','-T','worker','node','--test','--import','./apps/api/node_modules/tsx/dist/loader.mjs','scripts/ponte-fiscal-real.test.mjs'])
        print(json.dumps({'etapa':'motor-municipal-real-na-imagem','resultado':'passou','redeFiscal':False}),flush=True)
        execute(compose+['cp','caddy:/data/caddy/pki/authorities/local/root.crt',str(temp/'ca.crt')])
        curl = ['curl','--fail','--silent','--show-error','--max-time','20','--noproxy','*',
            '--cacert',str(temp/'ca.crt'),'--resolve',name+':18443:127.0.0.1']
        homepage = execute(curl+[web+'/'],capture=True)
        assert '<html' in homepage and 'Barber' in homepage
        health = json.loads(execute(curl+[web+'/api/health/pronto'],capture=True))
        assert health['status']=='ok'
        print(json.dumps({'etapa':'https-ca-local-api-web-worker','resultado':'passou'}),flush=True)
        sentinel = str(uuid.uuid4())
        execute(sql+["INSERT INTO tenants (id,name) VALUES ('"+sentinel+"','Sentinela sintética de persistência')"])
        execute(compose+['run','--rm','--no-deps','preparar'])
        assert int(execute(sql+['SELECT count(*) FROM schema_migrations'],capture=True).strip()) == expected
        execute(compose+['restart','db','api','worker','web'])
        execute(compose+['up','-d','--no-build','--wait','--wait-timeout','240'])
        assert execute(sql+["SELECT count(*) FROM tenants WHERE id='"+sentinel+"'"],capture=True).strip() == '1'
        execute(compose+['exec','-T','worker','node','scripts/worker-pronto.mjs'])
        health = json.loads(execute(curl+[web+'/api/health/pronto'],capture=True))
        assert health['status']=='ok'
        print(json.dumps({'etapa':'reaplicacao-reinicio-persistencia','resultado':'passou'}),flush=True)
        print(json.dumps({'resultado':'passou','imagem':image,'migracoes':expected,
            'compose':'deploy/compose.yml com portas/CA locais e imagem previamente construída',
            'integracoesExternas':False,'deploy':False}),flush=True)
    except BaseException:
        # Logs de processos podem conter configuração; execute redige os segredos
        # e só devolvemos estado, sem dump de ambiente ou payload de clientes.
        state = execute(compose+['ps','-a','--format','json'],capture=True,check=False)
        for line in state.splitlines():
            try:
                row=json.loads(line)
                print(json.dumps({k:row.get(k) for k in ['Service','State','Health','ExitCode']}))
            except (ValueError,TypeError):
                pass
        raise
    finally:
        cleanup = execute(compose+['down','--volumes','--remove-orphans'],check=False)
        print(json.dumps({'etapa':'limpeza-projeto-local','resultado':'passou' if cleanup == 0 else 'falhou','projeto':project}),flush=True)
        if cleanup:
            raise RuntimeError('Falha ao remover projeto descartável ' + project)
