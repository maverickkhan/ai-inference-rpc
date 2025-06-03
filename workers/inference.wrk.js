'use strict'

const WrkBase = require('./base.wrk.js')
const axios = require('axios')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const RPC = require('@hyperswarm/rpc')
const DHT = require('hyperdht')
require('dotenv').config();



class InferenceWorker extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)
    this.name = 'inference'
    
    // Initialize required structures manually
    this.conf.init = { facilities: [] }
    this.status = {}
    
    // Create a simple logger
    this.logger = {
      info: (msg) => console.log(`[INFERENCE] ${msg}`),
      error: (msg, err) => console.error(`[INFERENCE] ${msg}`, err),
      warn: (msg) => console.warn(`[INFERENCE] ${msg}`),
      debug: (msg) => console.log(`[INFERENCE] ${msg}`)
    }
  }

  init () {
    // Don't call super.init() - do minimal initialization
    this.loadConf('common')
    this.validateOpenAIConfig()
  }

  // Override the start method to avoid facility loading
  start (cb) {
    this.logger.info('Starting inference worker...')
    
    this._start((err) => {
      if (err) return cb(err)
      this.active = 1
      this.logger.info('Inference worker started successfully')
      cb()
    })
  }

  // Override stop method
  stop (cb) {
    this.logger.info('Stopping inference worker...')
    this._stop(cb)
  }

  validateOpenAIConfig () {
    if (!process.env.OPENAI_API_KEY) {
      this.logger.warn('OPENAI_API_KEY not set. Please set it in your environment variables.')
    }
  }

  async setupDiscovery() {
    try {
      // Announce this worker on DHT topic
      const topic = Buffer.from(`ai-platform:${this.name}`)
      await this.dht.announce(topic, this.server.publicKey)
      
      this.logger.info(`Announced ${this.name} worker on DHT topic: ai-platform:${this.name}`)
    } catch (error) {
      this.logger.error('Failed to announce worker on DHT:', error.message)
      throw error
    }
  }

  async discoverWorker(workerName) {
    try {
      const topic = Buffer.from(`ai-platform:${workerName}`)
      const lookup = this.dht.lookup(topic)
      
      this.logger.info(`Looking up worker: ${workerName}`)
      
      // Wait for first peer
      for await (const peer of lookup) {
        this.logger.info(`Found ${workerName} worker: ${peer.publicKey.toString('hex')}`)
        lookup.destroy() // Stop looking after finding first peer
        return peer.publicKey
      }
      
      throw new Error(`Worker ${workerName} not found on DHT`)
    } catch (error) {
      this.logger.error(`Failed to discover ${workerName}:`, error.message)
      throw error
    }
  }

  async setupRPC () {
    try {
      this.logger.info('🔧 Setting up RPC with DHT...')
      
      // Create DHT - use same pattern
      this.dht = new DHT()
      
      this.logger.info('✅ Inference DHT created')
      
      // Create RPC with DHT
      this.rpc = new RPC({ dht: this.dht })
      this.logger.info('✅ RPC instance created with DHT')
      
      // Create server
      this.server = this.rpc.createServer()
      this.logger.info('✅ RPC server created')
      
    } catch (error) {
      this.logger.error('Failed to setup RPC:', error.message)
      throw error
    }
  }

  setupRPCHandlers () {
    // Add ping handler for testing
    this.server.respond('ping', async (data) => {
      this.logger.info(`📞 INFERENCE PING HANDLER CALLED!`)
      return Buffer.from('pong')
    })

    this.server.respond('process', async (req) => {
      try {
        const { prompt, model, options } = JSON.parse(req.toString())
        this.logger.info(`🤖 Processing inference: ${prompt.substring(0, 50)}...`)
        console.log("🚀 ~ InferenceWorker ~ this.server.respond ~ model:", model)
        
        const result = await this.processInference(prompt, model, options)
        
        this.logger.info(`✅ Inference completed: ${result.usage.total_tokens} tokens`)
        return Buffer.from(JSON.stringify(result))
        
      } catch (error) {
        this.logger.error('❌ Inference failed:', error.message)
        
        // Return error response instead of throwing
        const errorResponse = {
          error: error.message,
          completion: `Error: ${error.message}`,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }
        return Buffer.from(JSON.stringify(errorResponse))
      }
    })

    this.server.respond('health', async () => {
      const health = {
        status: 'healthy',
        backend: 'openai',
        timestamp: Date.now()
      }
      return Buffer.from(JSON.stringify(health))
    })

    this.logger.info('✅ Inference RPC handlers setup complete')
  }

  async processInference (prompt, model, options) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key not configured')
    }

    const requestData = {
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: options.maxTokens || 150,
      temperature: options.temperature || 0.7,
      ...options
    }

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        requestData,
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      )

      const completion = response.data.choices[0].message.content

      return {
        completion,
        usage: response.data.usage || {
          prompt_tokens: this.estimateTokens(prompt),
          completion_tokens: this.estimateTokens(completion),
          total_tokens: this.estimateTokens(prompt) + this.estimateTokens(completion)
        }
      }
    } catch (error) {
      if (error.response) {
        const errorMessage = error.response.data?.error?.message || error.response.statusText
        this.logger.error('OpenAI API error:', {
          status: error.response.status,
          message: errorMessage
        })
        throw new Error(`OpenAI API error: ${errorMessage}`)
      } else if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout - the inference took too long')
      } else {
        this.logger.error('OpenAI request failed:', error.message)
        throw new Error(`Inference failed: ${error.message}`)
      }
    }
  }

  estimateTokens (text) {
    // More accurate token estimation for OpenAI models
    // Roughly 4 characters per token for English text
    return Math.ceil(text.length / 4)
  }

  _start (cb) {
    this.setupRPC().then(async () => {
      try {
        this.setupRPCHandlers()
        
        // Start listening
        await this.server.listen()
        const pubkey = this.server.publicKey.toString('hex')
        this.logger.info(`🚀 Inference server listening on: ${pubkey}`)
        
        // Save discovery info
        this.saveDiscoveryInfo(pubkey)
        
        this.logger.info('✅ Inference worker RPC setup complete')
        cb()
      } catch (error) {
        this.logger.error('Failed to start inference worker:', error.message)
        cb(error)
      }
    }).catch(cb)
  }

  async _stop (cb) {
    if (this.server) await this.server.close()
    if (this.rpc) await this.rpc.destroy()
    if (this.dht) await this.dht.destroy()
    cb()
  }

  saveDiscoveryInfo(publicKey) {
    try {
      const path = require('path')
      const fs = require('fs')
      const discoveryPath = path.join(__dirname, '../config/discovery.json')
      const configDir = path.dirname(discoveryPath)
      
      // Ensure config directory exists
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }
      
      let discovery = { workers: {} }
      
      // Read existing discovery file if it exists
      if (fs.existsSync(discoveryPath)) {
        try {
          discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
        } catch (err) {
          this.logger.warn('Could not parse discovery file, creating new one')
        }
      }
      
      // Add this worker's info
      discovery.workers = discovery.workers || {}
      discovery.workers.inference = {
        publicKey: publicKey,
        timestamp: Date.now()
      }
      
      fs.writeFileSync(discoveryPath, JSON.stringify(discovery, null, 2))
      this.logger.info(`✅ Saved public key to discovery.json: ${publicKey}`)
      
    } catch (error) {
      this.logger.error('Failed to save discovery info:', error.message)
    }
  }
}

module.exports = InferenceWorker
