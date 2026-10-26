import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'
import { ElInput, ID_INJECTION_KEY } from 'element-plus'

test('the character anchor input binds persisted text and structured anchors to ElInput', async () => {
  const fileUrl = new URL('../src/components/filmCreate/AssetWorkbench.vue', import.meta.url)
  const source = readFileSync(fileUrl, 'utf8')
  const template = source.match(/<el-input\s+v-if="editCharacterForm.identity_anchors"[\s\S]*?\/>/)?.[0]
  assert.ok(template, 'character editor must expose its anchor input')
  const { code } = compile(template, { mode: 'function', prefixIdentifiers: true })
  const render = new Function('Vue', code)(Vue)
  for (const anchors of ['{"hair_style":"short hair"}', { hair_style: 'short hair' }]) {
    const app = Vue.createSSRApp({
      render() {
        const vnode = render(this, [])
        const expected = typeof anchors === 'string' ? anchors : JSON.stringify(anchors, null, 2)
        assert.equal(vnode.props.modelValue ?? vnode.props['model-value'], expected, 'ElInput must receive its modelValue')
        return vnode
      },
      data: () => ({ editCharacterForm: { identity_anchors: anchors } }),
    })
    app.component('el-input', ElInput)
    app.provide(ID_INJECTION_KEY, { prefix: 100, current: 0 })
    const html = await renderToString(app)
    assert.match(html, /<textarea/, 'the bound input must render as a textarea')
  }
})
