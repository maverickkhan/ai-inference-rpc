'use strict'

const { program } = require('commander')

program
  .option('--wtype <type>', 'worker type')
  .option('--env <env>', 'environment', 'development')

program.parse()

const { wtype, env } = program.opts()

if (!wtype) {
  console.error('Worker type is required. Use --wtype <type>')
  process.exit(1)
}

let Worker
try {
  switch (wtype) {
    case 'gateway':
      Worker = require('./workers/gateway.wrk.js')
      break
    case 'auth':
      Worker = require('./workers/auth.wrk.js')
      break
    case 'inference':
      Worker = require('./workers/inference.wrk.js')
      break
    case 'web':
      Worker = require('./workers/web.wrk.js')
      break
    default:
      throw new Error(`Unknown worker type: ${wtype}`)
  }
} catch (error) {
  console.error(`Failed to load worker: ${error.message}`)
  process.exit(1)
}

// Create proper conf and ctx objects that bfx-wrk-base expects
const conf = {}
const ctx = {
  wtype: wtype,
  env: env,
  root: process.cwd()
}

console.log('Creating worker with:', { wtype, env, root: process.cwd() })

const worker = new Worker(conf, ctx)

worker.start((err) => {
  if (err) {
    console.error('Worker failed to start:', err)
    process.exit(1)
  }
  
  console.log(`${wtype} worker started successfully`)
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down worker...')
  worker.stop(() => {
    process.exit(0)
  })
})

process.on('SIGTERM', () => {
  console.log('Shutting down worker...')
  worker.stop(() => {
    process.exit(0)
  })
})
