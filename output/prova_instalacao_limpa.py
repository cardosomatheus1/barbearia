"""Frozen install in a disposable directory; validates the installed libsignal patch."""
from pathlib import Path
import os, shutil, subprocess, tempfile

root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='barbearia-frozen-') as directory:
    target=Path(directory)
    manifests=[root/'package.json',root/'pnpm-lock.yaml',root/'pnpm-workspace.yaml']
    manifests+=list(root.glob('packages/*/package.json'))+list(root.glob('apps/*/package.json'))
    for original in manifests:
        dest=target/original.relative_to(root);dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(original,dest)
    shutil.copytree(root/'patches',target/'patches')
    subprocess.run(['pnpm','install','--ignore-scripts','--frozen-lockfile','--offline',
        '--store-dir','/home/ec2-user/codex-tmp/barbearia-audit-tools/pnpm-store'],cwd=target,check=True)
    proof=target/'packages/crm/patch-proof.mjs'
    proof.write_text('''import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const r=createRequire(require.resolve('@whiskeysockets/baileys'));
const {SessionRecord}=r('libsignal');
const session={indexInfo:{closed:-1},privateKey:'SYNTHETIC_PRIVATE_KEY_MUST_NOT_BE_LOGGED'};
const calls=[];const originals={};
for(const key of ['info','warn','error']){originals[key]=console[key];console[key]=(...args)=>calls.push(args);}
try{const record=new SessionRecord();record.closeSession(session);record.closeSession(session);record.openSession(session);
assert.equal(session.indexInfo.closed,-1);assert.ok(!JSON.stringify(calls).includes(session.privateKey));}
finally{Object.assign(console,originals);}
console.log('Fresh frozen install: libsignal preserves state and does not log private session material.');
''')
    subprocess.run(['node',str(proof)],cwd=target,check=True)
