import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveSopPython} from '../scripts/sop-python.mjs';

const workspace=path.resolve('arbitrary parent 中文 & spaces','Project');
const root=path.join(workspace,'tools','nested portal');
const sourceRoot=path.join(workspace,'SOP source');
const interpreter=(platform=process.platform)=>path.join(workspace,'.venv',...(platform==='win32'?['Scripts','python.exe']:['bin','python']));
const ready=executable=>({status:0,stdout:JSON.stringify({executable}),stderr:''});
const missing={error:Object.assign(new Error('not found'),{code:'ENOENT'}),status:null};

test('explicit Python path wins and relative values use the portal directory',()=>{
  const expected=path.resolve(root,'..','.venv','chosen python.exe');
  const calls=[];
  const selected=resolveSopPython({root,sourceRoot,env:{SOP_PYTHON_PATH:'../.venv/chosen python.exe',SOP_PYTHON:'wrong-command',CUSTOM_MARKER:'preserved'},exists:()=>true,run:(command,args,options)=>{
    calls.push(command);assert.equal(command,expected);assert.equal(options.cwd,root);
    assert.equal(options.env.CUSTOM_MARKER,'preserved');assert.equal(options.env.PYTHONDONTWRITEBYTECODE,'1');
    return ready(expected);
  }});
  assert.equal(selected,expected);assert.deepEqual(calls,[expected]);
});

test('legacy explicit SOP_PYTHON keeps command names and anchors path values',()=>{
  for(const value of ['custom-python','../runtime/python.exe']) {
    const expected=value.includes('/')?path.resolve(root,value):value;
    const selected=resolveSopPython({root,sourceRoot,env:{SOP_PYTHON:value},exists:()=>false,run:command=>{
      assert.equal(command,expected);return ready(path.resolve(root,'resolved-python.exe'));
    }});
    assert.equal(selected,path.resolve(root,'resolved-python.exe'));
  }
});

test('nested projects always use Project/.venv even when every local environment exists',()=>{
  const calls=[];
  const checked=[];
  const selected=resolveSopPython({root,sourceRoot,env:{},exists:value=>{checked.push(value);return true;},run:command=>{
    calls.push(command);return ready(command);
  }});
  assert.equal(selected,interpreter());assert.deepEqual(calls,[interpreter()]);assert.deepEqual(checked,[interpreter()]);
});

test('a shared environment with missing dependencies fails without switching runtimes',()=>{
  const calls=[];
  assert.throws(()=>resolveSopPython({root,sourceRoot,env:{},exists:()=>true,run:command=>{
    calls.push(command);return {status:1,stdout:'',stderr:"ModuleNotFoundError: No module named 'openpyxl'"};
  }}),/Project 共享环境.*无法用于 SOP[\s\S]*openpyxl/);
  assert.deepEqual(calls,[interpreter()]);
});

test('invalid explicit configuration fails instead of using the shared environment',()=>{
  const calls=[];
  assert.throws(()=>resolveSopPython({root,sourceRoot,env:{SOP_PYTHON_PATH:'missing/python.exe'},exists:()=>true,run:command=>{
    calls.push(command);return missing;
  }}),/SOP_PYTHON_PATH.*无法用于 SOP/);
  assert.deepEqual(calls,[path.resolve(root,'missing/python.exe')]);
});

test('a missing shared interpreter cannot fall back to project environments or PATH',()=>{
  const checked=[];
  assert.throws(()=>resolveSopPython({root,sourceRoot,env:{},exists:value=>{checked.push(value);return value!==interpreter();},run:()=>assert.fail('No other interpreter may run')}),/找不到 Project 共享 Python/);
  assert.deepEqual(checked,[interpreter()]);
});

test('a portal outside Project fails before trying PATH or private caches',()=>{
  assert.throws(()=>resolveSopPython({root:path.join(path.parse(root).root,'standalone-portal-fixture'),sourceRoot,env:{PATH:'available-python'},exists:()=>true,run:()=>assert.fail('No fallback may run')}),/找不到 Project 工作区/);
});

test('the shared interpreter uses the platform virtual-environment layout',()=>{
  for(const platform of ['win32','linux']) {
    const selected=resolveSopPython({root,env:{},platform,exists:()=>true,run:command=>{
      assert.equal(command,interpreter(platform));return ready(command);
    }});
    assert.equal(selected,interpreter(platform));
  }
});
