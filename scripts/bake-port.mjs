// 桥端口"烘焙"到插件 client.js 的**可测**实现（2026-10-17 从 server-manager.mjs 抽出）。
//
// 为什么单独一个模块：`server-manager.mjs` 是脚本（顶层有副作用），测试不能 import 它；
// 而这段逻辑有真实的"写出坏文件 ⇒ 整段静默死亡"风险，必须有门禁（见 test-bake-bridge-port.mjs）。

import { Script } from 'node:vm'

/** 插件 client.js 里等待被替换的**带引号**占位符字面量。 */
export const PORT_PLACEHOLDER = "'__DSH_BRIDGE_PORT__'"

/**
 * 生成"烘焙后的源码"（纯函数，不碰磁盘）。
 *
 * **只替换带引号的字面量** `'__DSH_BRIDGE_PORT__'`：不带引号的
 * `globalThis.__DSH_BRIDGE_PORT__` 是读取路径，必须原样保留 —— 早先的替换把它改成
 * `globalThis.12345`，那是 SyntaxError，`<script src>` 整个文件失效、插件全灭
 * （与 0.18.0 顶栏事故同族：整段静默死亡）。
 *
 * @param {string} raw 原始 client.js 内容
 * @param {string|number} port 桥端口
 * @returns {{source: string, changed: boolean}}
 */
export function bakeBridgePortSource(raw, port) {
  const next = raw.split(PORT_PLACEHOLDER).join(`'${port}'`)
  return { source: next, changed: next !== raw }
}

/**
 * 判定一段源码是否为**合法脚本**（与浏览器 `<script src>` 同语义）。
 *
 * 用 `node:vm` 的 `Script` 编译：它按**脚本**解析，与浏览器一致。
 * 两个被否掉的替代品（都实测过）：
 *   - `new Function(src)` —— 函数体语义，会放过脚本里非法的顶层 `return` ⇒ 假通过；
 *   - `node --check` —— 对 `.js` 按 **CommonJS** 解析（顶层 `return` 合法）⇒ 同样假通过，
 *     且要落临时文件 + 起子进程。
 *
 * @param {string} source 待判定的源码
 * @returns {{ok: boolean, why: string}} 失败时 why 为可读原因（供日志检索）
 */
export function checkScriptSyntax(source) {
  try {
    new Script(source)
    return { ok: true, why: '' }
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) }
  }
}
