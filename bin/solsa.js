#!/usr/bin/env node

const { Bundle } = require('../lib/bundle')
const cp = require('child_process')
const fs = require('fs')
const minimist = require('minimist')
const os = require('os')
const Module = require('module')
const path = require('path')
const util = require('util')
const tmp = require('tmp')
const yaml = require('js-yaml')

// resolve module even if not in default path
const _resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, parent) {
  if (request.startsWith('solsa')) {
    try {
      return _resolveFilename(request, parent)
    } catch (error) {
      return require.resolve(request.replace('solsa', '..'))
    }
  } else {
    return _resolveFilename(request, parent)
  }
}

tmp.setGracefulCleanup()

let errors = 0

function init (argv) {
  let context
  try {
    context = argv.context || cp.execSync('kubectl config current-context', { stdio: [0, 'pipe', 'ignore'] }).toString().trim()
  } catch (err) {
    console.error('Warning: Current context is not set')
    errors++
  }

  let config = { contexts: [] }
  const name = argv.config || process.env.SOLSA_CONFIG || path.join(os.homedir(), '.solsa.yaml')
  try {
    config = yaml.safeLoad(fs.readFileSync(name))
    if (!Array.isArray(config.contexts)) {
      console.error(`Warning: Cannot find contexts in configuration file "${name}"`)
      errors++
      config.contexts = []
    } else {
      if (context) {
        if (!config.contexts.find(({ name }) => name === context)) {
          console.error(`Warning: Cannot find context "${context}" in configuration file "${name}"`)
          errors++
        } else {
          config.context = context
        }
      }
    }
  } catch (err) {
    console.error(`Warning: Unable to load configuration file "${name}"`)
    errors++
  }
  return config
}

const argv = minimist(process.argv.slice(2), {
  string: ['config', 'context', 'output'],
  alias: { context: 'c', output: 'o' }
})
const command = argv._[0]
const source = argv._[1]

if (argv._.length !== 2 || !['yaml', 'build', 'push'].includes(command)) {
  console.error('Usage:')
  console.error('  solsa <command> [flags]')
  console.error()
  console.error('Available commands:')
  console.error('  build <solution.js>        build container images')
  console.error('  push <solution.js>         push container images to registries for current kubernetes context')
  console.error('  yaml <solution.js>         synthesize yaml for current kubernetes context')
  console.error()
  console.error('Global flags:')
  console.error('      --config <config>      use <config> file instead of default')
  console.error('  -c, --context <context>    use <context> instead of current kubernetes context')
  console.error()
  console.error(`Flags for "yaml" command:`)
  console.error('  -o, --output <file>        output base yaml and context overlays to <file>.tgz')
  console.error()
  process.exit(1)
}

const config = init(argv)

function load (source) {
  const app = require(path.resolve(source))
  if (!(app instanceof Bundle)) {
    const err = new Error(`"${source}" does not export a bundle`)
    throw err
  }
  return app
}

function yamlCommand () {
  if (argv.output) {
    if (config.contexts.length === 0) {
      console.error('Warning: Generating base YAML without kustomization layers')
      errors++
    }
  } else {
    if (!config.context) {
      console.error('Warning: Generating base YAML without kustomization layer')
      errors++
    }
  }

  const app = load(source)

  class Layer {
    constructor (name) {
      this.name = name
      this.resources = {}
      this.bases = []
      this.patches = {}
      this.patchesJSON = {}
      this.images = []
    }
  }

  class SolsaArchiver {
    constructor (outputRoot) {
      this.outputRoot = outputRoot
      this.layers = { base: new Layer('base') }
    }

    writeToFile (obj, fname, layer) {
      let text
      try {
        text = yaml.safeDump(obj, { noArrayIndent: true })
      } catch (err) {
        console.error(util.inspect(obj, { colors: true, depth: 20 }))
        throw err
      }
      fs.writeFileSync(path.join(this.outputRoot, layer, fname), text)
    }

    getLayer (layer) {
      if (this.layers[layer] === undefined) {
        this.layers[layer] = new Layer(layer)
      }
      return this.layers[layer]
    }

    addResource (obj, fname, layer = 'base') {
      this.getLayer(layer).resources[fname] = obj
    }

    addPatch (patch, fname, layer = 'base') {
      this.getLayer(layer).patches[fname] = { patch }
    }

    addJSONPatch (patch, target, layer = 'base') {
      this.getLayer(layer).patchesJSON[target.path] = { patch, target }
    }

    finalizeImageRenames (context, app) {
      const images = []
      for (let name of app.getImages()) {
        const pos = name.indexOf(':', name.indexOf('/'))
        let newName = pos === -1 ? name : name.substring(0, pos)
        let newTag = pos === -1 ? undefined : name.substring(pos + 1)
        if (context.images && context.images.find(image => image.name === name || image.name === newName)) continue // already kustomized
        if (images.find(image => image.name === name)) continue // already encountered
        const k = { name }
        if (context.registry && !name.includes('/')) k.newName = context.registry + '/' + newName
        if (newTag) {
          images.unshift(k) // list tagged images first
        } else {
          if (context.imageTag) k.newTag = context.imageTag // tag image
          images.push(k)
        }
      }
      return (context.images || []).concat(images)
    }

    finalize (config, app) {
      for (const context of config.contexts) {
        const contextLayer = this.getLayer(context.name)
        contextLayer.bases.push('./../base')
        contextLayer.images = this.finalizeImageRenames(context, app)
      }

      fs.mkdirSync(this.outputRoot)
      for (let layer of Object.values(this.layers)) {
        fs.mkdirSync(path.join(this.outputRoot, layer.name))
        for (let fname of Object.keys(layer.resources)) {
          this.writeToFile(layer.resources[fname], fname, layer.name)
        }
        for (let fname of Object.keys(layer.patches)) {
          this.writeToFile(layer.patches[fname].patch, fname, layer.name)
        }
        for (let fname of Object.keys(layer.patchesJSON)) {
          this.writeToFile(layer.patchesJSON[fname].patch, fname, layer.name)
        }
        const kustom = {
          apiVersion: 'kustomize.config.k8s.io/v1beta1',
          kind: 'Kustomization',
          bases: layer.bases,
          resources: Object.keys(layer.resources),
          patches: Object.keys(layer.patches),
          patchesJson6902: Object.keys(layer.patchesJSON).map(k => layer.patchesJSON[k].target),
          images: layer.images
        }
        if (app.name) kustom.commonAnnotations = { 'solsa.ibm.com/app': app.name }
        this.writeToFile(kustom, 'kustomization.yaml', layer.name)
      }
    }
  }

  const dir = tmp.dirSync({ mode: '0755', prefix: 'solsa_', unsafeCleanup: true })
  const outputRoot = path.join(dir.name, path.basename(argv.output || 'solsa'))

  const sa = new SolsaArchiver(outputRoot)
  for (let item of app.getResources({ config })) {
    if (item.obj) {
      sa.addResource(item.obj, item.name, item.layer)
    } else if (item.JSONPatch) {
      sa.addJSONPatch(item.JSONPatch, item.JSONPatchTarget, item.layer)
    } else if (item.patch) {
      sa.addPatch(item.patch, item.name, item.layer)
    }
  }
  sa.finalize(config, app)

  if (argv.output) {
    cp.execSync(`tar -C ${dir.name} -zcf ${argv.output}.tgz ${path.basename(argv.output)}`, { stdio: [0, 1, 2] })
    console.log(`Generated YAML to ${argv.output}.tgz`)
  } else {
    cp.execSync(`kustomize build ${path.join(outputRoot, config.context || 'base')}`, { stdio: [0, 1, 2] })
  }
  dir.removeCallback()
}

function buildCommand () {
  const app = load(source)

  function build ({ name, build, main = '.' }) {
    console.log(`Building image "${name}"`)
    if (!fs.existsSync(path.join(build, 'package.json'))) {
      console.error(`Warning: Missing package.json in ${build}, skipping image`)
      errors++
      return
    }

    if (!fs.existsSync(path.join(build, 'node_modules'))) {
      console.log('Running npm install')
      cp.execSync('npm install --prod --no-save', { cwd: build, stdio: [0, 1, 2] })
    }

    console.log('Copying files to temporary folder')
    const dir = tmp.dirSync({ mode: '0755', prefix: 'solsa_', unsafeCleanup: true })
    cp.execSync(`rsync -rL --exclude=.git . "${dir.name}"`, { cwd: build, stdio: [0, 1, 2] })

    console.log('Running docker build')
    cp.execSync(`docker build -f ${path.join(__dirname, '..', 'runtime', 'node', 'Dockerfile')} "${dir.name}" --build-arg MAIN=${main} -t ${name}`, { cwd: build, stdio: [0, 1, 2] })

    console.log('Reclaiming temporary folder')
    dir.removeCallback()
  }

  const images = app.getBuilds()
  for (let name of new Set(images.map(image => image.name))) {
    build(images.find(image => image.name === name))
  }
}

function rename (name, context) {
  const pos = name.indexOf(':', name.indexOf('/'))
  let newName = pos === -1 ? name : name.substring(0, pos)
  let newTag = pos === -1 ? undefined : name.substring(pos + 1)
  const image = (context.images || []).find(image => image.name === name || image.name === newName)
  if (image) {
    newName = image.newName || newName
    newTag = image.newTag || newTag
  } else {
    if (context.registry && !name.includes('/')) newName = context.registry + '/' + newName
    newTag = newTag || context.imageTag
  }
  return newTag ? newName + ':' + newTag : newName
}

function pushCommand () {
  if (!config.context) {
    console.error('Warning: Missing context, cannot push')
    errors++
    return
  }

  const context = config.contexts.find(({ name }) => name === config.context)
  for (let name of new Set(load(source).getBuilds().map(image => image.name))) {
    const tag = rename(name, context)
    console.log(`Tagging image "${name}" with tag "${tag}"`)
    cp.execSync(`docker tag "${name}" "${tag}"`, { stdio: [0, 1, 2] })

    if (tag.includes('/')) {
      console.log(`Pushing image "${tag}"`)
      cp.execSync(`docker push "${tag}"`, { stdio: [0, 1, 2] })
    }
  }
}

switch (command) {
  case 'yaml':
    yamlCommand()
    break
  case 'build':
    buildCommand()
    break
  case 'push':
    pushCommand()
}

if (errors) {
  console.error('Warnings: ' + errors)
  process.exit(1)
}
