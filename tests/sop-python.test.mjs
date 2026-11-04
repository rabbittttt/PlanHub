import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveSopPython} from '../scripts/sop-python.mjs';

const workspace=path.resolve('fixture workspace');
const root=path.join(workspace,'portal');
const sourceRoot=path.join(workspace,'SOP source');
const interpreter=base=>path.join(base,'.venv',...(process.platform==='win32'?['Scripts','python.exe']:['bin','python']));
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

test('legacy SOP_PYTHON keeps command names and anchors path values',()=>{
  for(const value of ['custom-python','../runtime/python.exe']) {
    const expected=value.includes('/')?path.resolve(root,value):value;
    const selected=resolveSopPython({root,sourceRoot,env:{SOP_PYTHON:value},exists:()=>false,run:command=>{
      assert.equal(command,expected);return ready(path.resolve(root,'resolved-python.exe'));
    }});
    assert.equal(selected,path.resolve(root,'resolved-python.exe'));
  }
});

test('local environments prefer SOP source, then portal, then workspace',()=>{
  const candidates=[interpreter(sourceRoot),interpreter(root),interpreter(workspace)];
  for(let start=0;start<candidates.length;start++) {
    const present=new Set(candidates.slice(start));
    const calls=[];
    const selected=resolveSopPython({root,sourceRoot,env:{},exists:value=>present.has(value),run:command=>{
      calls.push(command);return ready(command);
    }});
    assert.equal(selected,candidates[start]);assert.deepEqual(calls,[candidates[start]]);
  }
});

test('an existing environment with missing dependencies fails without switching runtimes',()=>{
  const calls=[];
  assert.throws(()=>resolveSopPython({root,sourceRoot,env:{},exists:()=>true,run:command=>{
    calls.push(command);return {status:1,stdout:'',stderr:"ModuleNotFoundError: No module named 'openpyxl'"};
  }}),/虚拟环境.*无法用于 SOP[\s\S]*openpyxl/);
  assert.deepEqual(calls,[interpreter(sourceRoot)]);
});

test('invalid explicit configuration fails instead of using an automatic environment',()=>{
  const calls=[];
  assert.throws(()=>resolveSopPython({root,sourceRoot,env:{SOP_PYTHON_PATH:'missing/python.exe'},exists:()=>true,run:command=>{
    calls.push(command);return missing;
  }}),/SOP_PYTHON_PATH.*无法用于 SOP/);
  assert.deepEqual(calls,[path.resolve(root,'missing/python.exe')]);
});

test('a virtual environment directory without its interpreter reports the damaged environment',()=>{
  const calls=[];
  assert.throws(()=>resolveSopPython({root,sourceRoot,env:{},exists:value=>value===path.join(sourceRoot,'.venv'),run:command=>{
    calls.push(command);return missing;
  }}),/虚拟环境.*无法用于 SOP/);
  assert.deepEqual(calls,[interpreter(sourceRoot)]);
});

test('PATH is used without looking up a private runtime cache',()=>{
  const calls=[];
  const selected=resolveSopPython({root,sourceRoot,env:{USERPROFILE:path.join(workspace,'user')},exists:value=>{
    assert.doesNotMatch(value,/codex-runtimes/);return false;
  },run:command=>{calls.push(command);return ready(path.join(workspace,'system-python.exe'));}});
  assert.deepEqual(calls,['python']);assert.equal(selected,path.join(workspace,'system-python.exe'));
});

test('only an absent PATH command falls through; incompatible Python fails clearly',()=>{
  const calls=[];
  const selected=resolveSopPython({root,sourceRoot,env:{},exists:()=>false,run:command=>{
    calls.push(command);return command==='python'?missing:ready(path.join(workspace,'python3'));
  }});
  assert.deepEqual(calls,['python','python3']);assert.equal(selected,path.join(workspace,'python3'));
  assert.throws(()=>resolveSopPython({root,sourceRoot,env:{},exists:()=>false,run:()=>({status:1,stderr:'Python 3.10+ is required'})}),/Python 3.10\+/);
  assert.throws(()=>resolveSopPython({root,sourceRoot,env:{},exists:()=>false,run:()=>missing}),/找不到 Python/);
});
