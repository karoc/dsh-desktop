// Node half: no-op. The browser half (client.js) does all the work; the node
// entry only exists so the package is a valid cordis loader entry for the
// `dsh.client` roster row injected via --patch.
export const name = 'desktop-plugin-console'
export function apply() {}
