import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSessionGates } from '../lib/gates.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'steward-gates-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = path.join(dir, 'node_modules', 'demo-plugin')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(pkg, 'index.js'), "const names = ['demo_old', 'demo_new']")
  const active = new Set()
  let names = ['demo_old']
  let block = null
  const agent = { id: 'session', ctx: { tools: { restrict({ deny }) {
    const entry = [...deny]
    active.add(entry)
    return () => active.delete(entry)
  } } } }
  let currentAgent = agent
  const ctx = { get(name) {
    return {
      tools: { schemas: () => names.map(name => ({ name })) },
      agents: { get: () => currentAgent, list: () => [currentAgent] },
    }[name]
  } }
  const gates = createSessionGates({ ctx, profileDir: async () => dir, consoleDir: async () => {
    if (block !== null) {
      const wait = block
      block = null
      wait.entered.resolve()
      await wait.resume.promise
    }
    return path.join(dir, '.plugin-console')
  } })
  t.after(() => gates.revokeAll())
  const catalog = { installedBundles: [{ name: 'demo-plugin' }], rows: [] }
  const disable = () => gates.setPolicy('session', { disabled: ['demo-plugin'] }, catalog)
  return { gates, catalog, active, pkg, disable,
    setNames(value) { names = value },
    replaceAgent() { currentAgent = { ...agent } },
    pause() { block = { entered: deferred(), resume: deferred() }; return block },
  }
}

test('concurrent applies leave one restriction, and enabling removes it', async t => {
  const f = await fixture(t)
  await f.disable()
  await Promise.all(Array.from({ length: 12 }, () => f.gates.apply('session', f.catalog)))
  assert.equal(f.active.size, 1)
  await f.gates.setPolicy('session', { disabled: [] }, f.catalog)
  assert.equal(f.active.size, 0)
})

test('concurrent policy writes and forget follow request order', async t => {
  const f = await fixture(t)
  await Promise.all([
    f.disable(),
    f.gates.setPolicy('session', { disabled: [] }, f.catalog),
  ])
  assert.deepEqual((await f.gates.readPolicy('session')).disabled, [])
  assert.equal(f.active.size, 0)
  await Promise.all([f.disable(), f.gates.forget('session')])
  assert.deepEqual(await f.gates.listPolicyFiles(), [])
  assert.equal(f.active.size, 0)
})

for (const action of ['revoke', 'revokeAll', 'replaceAgent']) {
  test(`${action} during policy I/O prevents a late restriction`, async t => {
    const f = await fixture(t)
    await f.disable()
    const wait = f.pause()
    const pending = f.gates.apply('session', f.catalog)
    await wait.entered.promise
    if (action === 'replaceAgent') { f.replaceAgent(); f.gates.revoke('session') }
    else f.gates[action]('session')
    assert.equal(f.active.size, 0)
    wait.resume.resolve()
    assert.equal((await pending).applied, false)
    assert.equal(f.active.size, 0)
    if (action !== 'revokeAll') {
      await f.gates.apply('session', f.catalog)
      assert.equal(f.active.size, 1)
    } else {
      await f.gates.apply('session', f.catalog)
      assert.equal(f.active.size, 0)
    }
  })
}

test('revokeAll cancels work that has not started', async t => {
  const f = await fixture(t)
  const pending = f.disable()
  f.gates.revokeAll()
  await pending
  assert.equal(f.active.size, 0)
})

test('a newly registered tool is denied while the ownership TTL is still warm', async t => {
  const f = await fixture(t)
  await f.disable()
  f.setNames(['demo_old', 'demo_new'])
  const result = await f.gates.apply('session', f.catalog)
  assert.deepEqual(result.denied, ['demo_new', 'demo_old'])
  assert.equal(f.active.size, 1)
})

test('explicit invalidation rescans unchanged tool names after source changes', async t => {
  const f = await fixture(t)
  await f.disable()
  await writeFile(path.join(f.pkg, 'index.js'), 'const names = []')
  f.gates.invalidateOwners()
  assert.deepEqual((await f.gates.apply('session', f.catalog)).denied, [])
  assert.equal(f.active.size, 0)
})

test('bundle membership changes invalidate the ownership cache', async t => {
  const f = await fixture(t)
  await f.disable()
  assert.deepEqual((await f.gates.apply('session', { ...f.catalog, installedBundles: [] })).denied, [])
  assert.equal(f.active.size, 0)
})
