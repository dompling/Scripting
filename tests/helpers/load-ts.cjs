const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
let ts
try { ts = require('typescript') } catch {
  const compiler = (process.env.PATH || '').split(path.delimiter)
    .map(directory => path.join(directory, 'tsc'))
    .find(filename => fs.existsSync(filename))
  if (!compiler) throw new Error('Tests require an existing TypeScript installation (typescript or tsc on PATH).')
  ts = require(path.dirname(path.dirname(fs.realpathSync(compiler))))
}
const source = path.resolve(__dirname, '../../RefreshSideStore/src')
function loadTs(entry, mocks = {}, globals = {}) {
  const cache = new Map()
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Date, Map, Set, Error,
    btoa, atob, crypto: globalThis.crypto, ...globals })
  function load(filename) {
    filename = [filename, `${filename}.ts`, `${filename}.tsx`, path.join(filename, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile())
    if (!filename) throw new Error('Cannot resolve local test module')
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve },
    }).outputText
    const localRequire = specifier => {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier]
      return specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier)) : require(specifier)
    }
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(localRequire, module, module.exports)
    return module.exports
  }
  return load(path.resolve(source, entry))
}
module.exports = { loadTs }
