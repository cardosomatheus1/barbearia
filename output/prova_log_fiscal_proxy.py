"""Prova o log do Caddy com link fiscal sintético, sem servidor externo."""
from pathlib import Path
import http.client, json, os, re, secrets, subprocess, sys, tempfile, time

root=Path(__file__).resolve().parents[1]
runtime=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
token=secrets.token_urlsafe(96)+'.'+secrets.token_urlsafe(32)
chave=secrets.token_urlsafe(32)
espera_exposicao='--expect-leak' in sys.argv
with tempfile.TemporaryDirectory(prefix='proxy-fiscal-',dir=runtime) as d:
    pasta=Path(d); log=pasta/'acesso.log'; cfg=pasta/'Caddyfile'
    config=(root/'deploy/Caddyfile').read_text()
    config=re.sub(r'www\.\{\$DOMINIO\} \{\n.*?\n\}', '',config,flags=re.S)
    config=config.replace('{$DOMINIO} {','http://127.0.0.1:3502 {')
    # Redirecionamentos da aplicação também podem devolver links privados.
    config=re.sub(r'reverse_proxy (api:3000|web:3001) \{\s*import origem_confiavel\s*\}',
        'header X-Action-Redirect "https://example.invalid/nota/'+token+'"\nrespond "ok"',config)
    config=config.replace('handle /media/* {', 'handle /falha/* {\n reverse_proxy unix/'+str(pasta/'ausente.sock')+'\n}\nhandle /media/* {')
    config=config.replace('/var/log/caddy/acesso.log',str(log)).replace('\n{\n','\n{\n admin off\n',1)
    cfg.write_text(config)
    with (pasta/'servidor.log').open('w') as saida:
        processo=subprocess.Popen(['/home/ec2-user/codex-tmp/barbearia-audit-tools/caddy','run','--config',str(cfg),'--adapter','caddyfile'],
            env={**os.environ,'ACME_EMAIL':'audit@example.invalid','INTERNAL_PROXY_SECRET':chave},stdout=saida,stderr=subprocess.STDOUT)
        def get(caminho,headers=None,status_esperado=200):
            c=http.client.HTTPConnection('127.0.0.1',3502,timeout=3)
            try:
                c.request('GET',caminho,headers=headers or {}); r=c.getresponse(); r.read(); assert r.status==status_esperado
            finally:c.close()
        try:
            for _ in range(50):
                assert processo.poll() is None, 'Caddy encerrou na partida'
                try:get('/sonda');break
                except OSError:time.sleep(.1)
            else:raise AssertionError('Caddy não iniciou')
            headers={'Referer':'https://example.invalid/nota/'+token,'X-Barberdock-Proxy-Key':chave}
            caminhos=[p+token+'?copia='+token for p in ['/nota/', '//nota/', '/%6eota/', '/nota%2F/', '/%6E%6F%74%61/']]
            caminhos += ['/barbearia/fila/'+token, '/barbearia/vaga/'+token,
                '/api/v1/b/barbearia/queue/'+token, '/api/v1/b/barbearia/offer/'+token,
                '/api/v1/webhooks/whatsapp?hub.verify_token='+token,
                '/admin/clientes?busca='+token]
            for caminho in caminhos:
                get(caminho,headers)
            get('/admin/dia',headers)
            get('/falha/'+token,headers,502)
        finally:
            processo.terminate();processo.wait(timeout=5)
    acesso=log.read_text()
    bruto=acesso+(pasta/'servidor.log').read_text()
    if espera_exposicao:
        assert token in bruto
        print(json.dumps({'exposicao_reproduzida':True,'dados_sinteticos':True}))
    else:
        assert token not in bruto and chave not in bruto, 'Log conserva credencial sintética'
        entradas=[json.loads(l) for l in acesso.splitlines()]
        assert len(entradas)==len(caminhos)+3
        assert all('uri' not in e['request'] and 'headers' not in e['request'] for e in entradas)
        assert all('resp_headers' not in e for e in entradas)
        assert all(e['status'] in [200,502] and e['request']['method']=='GET' for e in entradas)
        assert sum(e['status']==502 for e in entradas)==1
        print(json.dumps({'resultado':'passou','uris_e_cabecalhos_omitidos':True,'caminhos_com_credencial':len(caminhos),'falha_upstream_sem_credencial_no_log':True,'metadados_preservados':True}))
