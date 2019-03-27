#!/usr/bin/env node

const archiver = require('archiver')
const fs = require('fs')
const minimist = require('minimist')
const os = require('os')
const path = require('path')
const utils = require('../utils.js')
const yaml = require('js-yaml')

class SolsaArchiver {
  constructor (app, archiveName) {
    this.app = app
    var output = fs.createWriteStream(archiveName + '.tgz')
    this.archive = archiver('tar', {
      gzip: true,
      zlib: { level: 9 }
    })
    this.files = []

    // listen for all archive data to be written
    // 'close' event is fired only when a file descriptor is involved
    output.on('close', function () {
      console.log('archiver has been finalized and the output file descriptor has closed.')
    })

    // good practice to catch warnings (ie stat failures and other non-blocking errors)
    this.archive.on('warning', function (err) {
      if (err.code === 'ENOENT') {
        // log warning
      } else {
        // throw error
        throw err
      }
    })

    // good practice to catch this error explicitly
    this.archive.on('error', function (err) {
      throw err
    })

    // pipe archive data to the file
    this.archive.pipe(output)
  }

  addYaml (obj, fname) {
    this.archive.append(yaml.safeDump(obj, { noArrayIndent: true }),
      { name: 'solsa-' + this.app.name.toLowerCase() + '/base/' + fname })
    this.files.push(fname)
  }

  addKustomizeYaml (obj, path, fname) {
    this.archive.append(yaml.safeDump(obj, { noArrayIndent: true }),
      { name: 'solsa-' + this.app.name.toLowerCase() + path + fname })
  }

  _finalizeIngress (cluster, target, additionalFiles, jsonPatches) {
    if (cluster.ingress.iks) {
      switch (target) {
        case utils.targets.KUBERNETES: {
          const ingress = {
            apiVersion: 'extensions/v1beta1',
            kind: 'Ingress',
            metadata: {
              name: this.app.name + '-ing-iks',
              labels: {
                'solsa.ibm.com/name': this.app.name
              }
            },
            spec: {
              tls: [{
                hosts: [
                  this.app.name + '.' + cluster.ingress.iks.subdomain
                ],
                secretName: cluster.ingress.iks.tlssecret
              }],
              rules: [{
                host: this.app.name + '.' + cluster.ingress.iks.subdomain,
                http: {
                  paths: [{
                    path: '/',
                    backend: {
                      serviceName: this.app.name,
                      servicePort: 'solsa'
                    }
                  }]
                }
              }]
            }
          }
          this.addKustomizeYaml(ingress, '/' + cluster.name + '/', 'ingress.yaml')
          additionalFiles.push('ingress.yaml')
          break
        }
        case utils.targets.KNATIVE:
        // NOTHING TO DO FOR IKS (Ingress automatically configured for KNative Services)
      }
    } else if (cluster.ingress.nodePort) {
      switch (target) {
        case utils.targets.KUBERNETES: {
          const nodePortPatch = [
            {
              op: 'replace',
              path: '/spec/type',
              value: 'NodePort'
            }, {
              op: 'add',
              path: '/spec/ports/0/nodePort',
              value: cluster.ingress.nodePort
            }
          ]
          this.addKustomizeYaml(nodePortPatch, '/' + cluster.name + '/', 'expose-svc.yaml')
          jsonPatches.push({
            target: {
              version: 'v1',
              kind: 'Service',
              name: this.app.name
            },
            path: 'expose-svc.yaml'
          })
          break
        }
        case utils.targets.KNATIVE: {
          console.log(`Warning for cluster ${cluster.name}: NodePort Ingress is not supported with Knative target`)
        }
      }
    }
  }

  _finalizeImageRenames (cluster, target, additionalFiles, jsonPatches) {
    if (!cluster.images) return []
    switch (target) {
      case utils.targets.KUBERNETES: {
        return cluster.images
      }
      case utils.targets.KNATIVE: {
        // NOTE: This assumes a patch to Kustomize that has not yet been merged upstream
        return cluster.images
      }
    }
  }

  finalize (userConfig, target) {
    const kustom = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      commonAnnotations: {
        'solsa.ibm.com/app': this.app.name
      },
      resources: this.files
    }
    this.addKustomizeYaml(kustom, '/base/', 'kustomization.yaml')

    if (userConfig.clusters) {
      for (const cluster of userConfig.clusters) {
        const additionalFiles = []
        const jsonPatches = []

        if (cluster.ingress) {
          this._finalizeIngress(cluster, target, additionalFiles, jsonPatches)
        }
        const images = this._finalizeImageRenames(cluster, target, additionalFiles, jsonPatches)

        const kc = {
          apiVersion: 'kustomize.config.k8s.io/v1beta1',
          kind: 'Kustomization',
          bases: ['./../base'],
          resources: additionalFiles,
          patchesJson6902: jsonPatches,
          images: images
        }
        this.addKustomizeYaml(kc, '/' + cluster.name + '/', 'kustomization.yaml')
      }
    }

    this.archive.finalize()
  }
}

async function main () {
  const argv = minimist(process.argv.slice(2), {
    default: { target: 'kubernetes', output: 'solsa-yaml', config: process.env.SOLSA_CONFIG || path.join(os.homedir(), '.solsa.yaml') },
    alias: { target: 't', output: 'o', config: 'c' },
    string: ['target', 'output', 'config']
  })

  var userConfig = {}
  if (argv.config) {
    userConfig = yaml.safeLoad(fs.readFileSync(argv.config, 'utf8'))
  }
  var target
  if (argv.target.toLowerCase() === 'kubernetes') {
    target = utils.targets.KUBERNETES
  } else if (argv.target.toLowerCase() === 'knative') {
    target = utils.targets.KNATIVE
  } else {
    console.log('Warning: unrecognized target ' + argv.target)
  }

  const theApp = require(require('path').resolve(argv._[0]))
  const sa = new SolsaArchiver(theApp, argv.output)
  await theApp._yaml(sa, target)
  sa.finalize(userConfig, target)
}

global.__yaml = true

main()
