#!/usr/bin/env node
'use strict'

const { program } = require('commander')
const DHT = require('@hyperswarm/dht')
const RPC = require('@hyperswarm/rpc')
const fs = require('fs')
const path = require('path')

class AIInferenceCLI {
  constructor () {
    this.dht = null
    this.rpc = null
    this.connected = false
  }

  async init () {
    // Setup DHT and RPC - same pattern as workers
    this.dht = new DHT()
    this.rpc = new RPC({ dht: this.dht })
    
    this.connected = true
    console.log('✅ Connected to AI Inference Platform')
  }

  async discoverWorker(workerName) {
    try {
      const discoveryPath = path.join(__dirname, '../config/discovery.json')
      
      if (!fs.existsSync(discoveryPath)) {
        throw new Error('Discovery file not found. Make sure workers are running.')
      }
      
      const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
      
      if (!discovery.workers || !discovery.workers[workerName]) {
        throw new Error(`Worker ${workerName} not found in discovery file`)
      }
      
      const worker = discovery.workers[workerName]
      return Buffer.from(worker.publicKey, 'hex')
      
    } catch (error) {
      throw new Error(`Failed to discover ${workerName}: ${error.message}`)
    }
  }

  async makeInference (prompt, options = {}) {
    if (!this.connected) {
      throw new Error('Not connected to platform')
    }

    const apiKey = process.env.AI_API_KEY
    if (!apiKey) {
      throw new Error('AI_API_KEY environment variable not set')
    }

    try {
      // Discover gateway worker
      const gatewayKey = await this.discoverWorker('gateway')
      
      const requestData = Buffer.from(JSON.stringify({
        apiKey,
        prompt,
        model: options.model || 'gpt-4o-mini',
        options: {
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          top_p: options.topP
        }
      }))

      const result = await this.rpc.request(gatewayKey, 'infer', requestData)
      const response = JSON.parse(result.toString())
      
      if (response.error) {
        throw new Error(response.error)
      }
      
      return response
      
    } catch (error) {
      throw new Error(`Inference failed: ${error.message}`)
    }
  }

  async getModels () {
    if (!this.connected) {
      throw new Error('Not connected to platform')
    }

    try {
      const gatewayKey = await this.discoverWorker('gateway')
      const result = await this.rpc.request(gatewayKey, 'models', Buffer.from(''))
      return JSON.parse(result.toString())
    } catch (error) {
      throw new Error(`Failed to get models: ${error.message}`)
    }
  }

  async getHealth () {
    if (!this.connected) {
      throw new Error('Not connected to platform')
    }

    try {
      const gatewayKey = await this.discoverWorker('gateway')
      const result = await this.rpc.request(gatewayKey, 'health', Buffer.from(''))
      return JSON.parse(result.toString())
    } catch (error) {
      throw new Error(`Health check failed: ${error.message}`)
    }
  }

  async close () {
    if (this.rpc) {
      await this.rpc.destroy()
    }
    if (this.dht) {
      await this.dht.destroy()
    }
  }
}

// CLI Commands
program
  .name('ai-inference')
  .description('AI Inference Platform CLI')
  .version('1.0.0')

program
  .command('infer')
  .description('Make an inference request')
  .argument('<prompt>', 'The prompt to send to the AI model')
  .option('-m, --model <model>', 'Model to use', 'gpt-3.5-turbo')
  .option('-t, --temperature <temp>', 'Temperature (0-2)', parseFloat)
  .option('--max-tokens <tokens>', 'Maximum tokens', parseInt)
  .option('--top-p <p>', 'Top-p value', parseFloat)
  .option('--json', 'Output as JSON')
  .action(async (prompt, options) => {
    const cli = new AIInferenceCLI()
    
    try {
      console.log('🔌 Connecting to AI Inference Platform...')
      await cli.init()
      
      console.log('🤖 Processing inference request...')
      const result = await cli.makeInference(prompt, options)
      
      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log('\n📝 Response:')
        console.log(result.completion)
        console.log(`\n📊 Usage: ${result.usage.total_tokens} tokens`)
      }
    } catch (error) {
      console.error('❌ Error:', error.message)
      process.exit(1)
    } finally {
      await cli.close()
    }
  })

program
  .command('models')
  .description('List available models')
  .action(async () => {
    const cli = new AIInferenceCLI()
    
    try {
      console.log('🔌 Connecting to AI Inference Platform...')
      await cli.init()
      
      const models = await cli.getModels()
      
      console.log('\n🤖 Available Models:')
      models.available.forEach(model => {
        const isDefault = model === models.default
        console.log(`  ${isDefault ? '→' : ' '} ${model}${isDefault ? ' (default)' : ''}`)
      })
    } catch (error) {
      console.error('❌ Error:', error.message)
      process.exit(1)
    } finally {
      await cli.close()
    }
  })

program
  .command('health')
  .description('Check platform health')
  .action(async () => {
    const cli = new AIInferenceCLI()
    
    try {
      console.log('🔌 Connecting to AI Inference Platform...')
      await cli.init()
      
      const health = await cli.getHealth()
      
      console.log('\n🏥 Platform Health:')
      console.log(`  Status: ${health.status}`)
      console.log(`  Auth Services: ${health.authPeers}`)
      console.log(`  Inference Services: ${health.inferencePeers}`)
    } catch (error) {
      console.error('❌ Error:', error.message)
      process.exit(1)
    } finally {
      await cli.close()
    }
  })

program
  .command('ping')
  .description('Test ping to gateway')
  .action(async () => {
    const cli = new AIInferenceCLI()
    
    try {
      await cli.init()
      
      console.log('🔍 Discovering gateway...')
      const gatewayKey = await cli.discoverWorker('gateway')
      
      console.log('⏳ Waiting for DHT...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      
      console.log('📞 Sending ping...')
      const result = await cli.rpc.request(gatewayKey, 'ping', Buffer.from('cli-test'), {
        timeout: 15000
      })
      
      console.log('✅ Ping successful:', result.toString())
      
    } catch (error) {
      console.error('❌ Ping failed:', error.message)
    } finally {
      await cli.close()
    }
  })

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message)
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error.message)
  process.exit(1)
})

program.parse() 