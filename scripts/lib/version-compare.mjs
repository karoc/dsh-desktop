// 版本比较的**共享实现**（数值差：a > b ⇒ >0；语义与 dsh-watch 的 cmp() 一致）。
//
// 为什么单独成文件而不是在调用点再抄一份：仓库为「三份版本比较各自漂移」出过事故（审计 P0-1/P0-2：
// main 上三份同时错，修的时候又只改了两份）。`test-version-compare-parity.mjs` 从**源文本**抽出
// watch / probe / manager 三份实现互相比对结论；本文件是第 4 个调用点（SLA 报表判断「地板是否覆盖某版本」），
// 必须一起进门禁，否则它就是没人管的孤本 —— 所以 parity 套件现在也抽这一份。
//
// 注意：本文件不能被 server-manager 复用（manager 随包发布，见 parity 套件头部的方案 A/B 取舍）。
//
// 口径要点（与 watch 完全一致，逐条都有事故背景）：
//   · 无预发布必须返回**空数组**：`'0.2.1'.split('-')[1]` 是 undefined，旧写法 `?? ''` 再 split('.')
//     得到 `['']`（长度 1）⇒ 正式版被判成"有预发布标识"，`0.2.1 < 0.2.1-rc.2`（rc 转正那一刻静默漏报）。
//   · 正式版 > 同号任何预发布（semver §11.3）；多段预发布（0.1.0-alpha-1）用 slice(1).join('-') 保留。
//   · 不实现 semver §10 的 build metadata 忽略规则（同 watch/probe/manager；npm tag 里不会出现）。
export function cmpVersion(a, b) {
  const bare = (v) => (v ?? '').split('-')[0].split('.').map(Number)
  const pre = (v) => { const s = String(v ?? '').split('-').slice(1).join('-'); return s === '' ? [] : s.split('.') }
  const [A, B] = [bare(a), bare(b)]
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0)
  const [x, y] = [pre(a), pre(b)]
  if (x.length === 0 && y.length === 0) return 0
  if (x.length === 0) return 1
  if (y.length === 0) return -1
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const u = x[i] ?? ''
    const v = y[i] ?? ''
    const un = /^\d+$/.test(u)
    const vn = /^\d+$/.test(v)
    if (un && vn) { if (+u !== +v) return +u - +v }
    else if (u !== v) return u < v ? -1 : 1
  }
  return 0
}
