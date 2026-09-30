import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome='/usr/bin/google-chrome', runDir=resolve('.epoptes/run'); mkdirSync(runDir,{recursive:true});
const profile=mkdtempSync(`${runDir}/chrome-`), url=pathToFileURL(resolve('index.html')).href+'?test=1';
const common=[`--user-data-dir=${profile}`,'--no-sandbox','--disable-dev-shm-usage','--headless','--disable-gpu','--allow-file-access-from-files','--hide-scrollbars','--window-size=1440,1000'];
try {
  const dom=spawnSync(chrome,[...common,'--dump-dom','--virtual-time-budget=3000',url],{encoding:'utf8',timeout:15000});
  assert.equal(dom.error,undefined,dom.error?.message); assert.equal(dom.status,0,dom.stderr);
  assert.match(dom.stdout,/id="test-result"[^>]*>PASS</,'browser-side assertions did not pass');
  const shot=resolve('tower-defense.png');
  const capture=spawnSync(chrome,[...common,`--screenshot=${shot}`,'--virtual-time-budget=1500',url],{encoding:'utf8',timeout:15000});
  assert.equal(capture.error,undefined,capture.error?.message); assert.equal(capture.status,0,capture.stderr); assert.ok(statSync(shot).size>10000,'screenshot too small');
  console.log(`PASS: real Chrome controls and runtime assertions; screenshot ${shot}`);
} finally { rmSync(profile,{recursive:true,force:true}); }
