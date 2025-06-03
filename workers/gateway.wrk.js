'use strict'

const WrkBase = require('./base.wrk.js')
const client = require('prom-client')
const crypto = require('crypto')
const RPC = require('@hyperswarm/rpc')
const DHT = require('hyperdht')
const path = require('path')
const fs = require('fs')

class GatewayWorker extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)
    this.name = 'gateway'
    
    // Initialize required structures manually
    this.conf.init = { facilities: [] }
    this.status = {}
    
    // Create a simple logger
    this.logger = {
      info: (msg) => console.log(`[GATEWAY] ${msg}`),
      error: (msg, err) => console.error(`[GATEWAY] ${msg}`, err),
      warn: (msg) => console.warn(`[GATEWAY] ${msg}`),
      debug: (msg) => console.log(`[GATEWAY] ${msg}`)
    }

    // Initialize auth data structures
    this.apiKeys = new Map() // Store API key data
    this.rateLimits = new Map() // Store rate limit data
    this.usageStats = new Map() // Store usage statistics
    
    // Load valid API keys (for now, hardcode the test key)
    this.apiKeys.set('887935a3-c52c-4955-b508-3fd8e0ff1494', {
      active: true,
      tier: 'free',
      maxRequestsPerMinute: 10,
      userId: 'test-user'
    })
    
    this.logger.info('🔐 Gateway authentication initialized')
  }

  init () {
    // Don't call super.init() - do minimal initialization
    this.rateLimitStore = new Map()
    this.setupMetrics()
  }

  // Override the start method to avoid facility loading
  start (cb) {
    this.logger.info('Starting gateway worker...')
    
    this._start((err) => {
      if (err) return cb(err)
      this.active = 1
      this.logger.info('Gateway worker started successfully')
      cb()
    })
  }

  // Override stop method
  stop (cb) {
    this.logger.info('Stopping gateway worker...')
    this._stop(cb)
  }

  setupMetrics () {
    this.metrics = {
      requestsTotal: new client.Counter({
        name: 'gateway_requests_total',
        help: 'Total number of requests',
        labelNames: ['method', 'status']
      }),
      requestDuration: new client.Histogram({
        name: 'gateway_request_duration_seconds',
        help: 'Request duration in seconds',
        labelNames: ['method']
      }),
      rateLimitHits: new client.Counter({
        name: 'gateway_rate_limit_hits_total',
        help: 'Total number of rate limit hits'
      })
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
      const discoveryPath = path.join(__dirname, '../config/discovery.json')
      
      this.logger.info(`🔍 Looking for ${workerName} in discovery file: ${discoveryPath}`)
      
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
      this.logger.error(`Failed to discover ${workerName}:`, error.message)
      throw error
    }
  }

  async setupRPC () {
    try {
      this.logger.info('🔧 Setting up RPC client with DHT...')
      
      // Create DHT - use same pattern as working workers
      this.dht = new DHT()
      
      this.logger.info('✅ Gateway DHT created')
      
      // Create RPC with DHT
      this.rpc = new RPC({ dht: this.dht })
      this.logger.info('✅ RPC instance created with DHT')
      
    } catch (error) {
      this.logger.error('Failed to setup RPC:', error.message)
      throw error
    }
  }

  setupRPCHandlers () {
    // Add ping handler with better logging
    this.server.respond('ping', async (data) => {
      this.logger.info(`📞 GATEWAY PING received: ${data.toString()}`)
      return Buffer.from('pong-from-gateway')
    })

    // Updated inference handler - now calls real inference worker
    this.server.respond('infer', async (req) => {
      this.logger.info('📞 GATEWAY INFER request received')
      
      try {
        const requestData = JSON.parse(req.toString())
        this.logger.info('📊 Request data:', JSON.stringify(requestData, null, 2))
        
        // Get API key from request - require it, don't fallback to hardcoded key
        const apiKey = requestData.apiKey
        if (!apiKey) {
          throw new Error('API key is required')
        }
        
        this.logger.info(`🔑 Using API key: ${apiKey}`)
        
        // Validate API key via auth service
        const authResult = await this.validateApiKeyViaAuth(apiKey)
        if (!authResult.valid) {
          throw new Error(`Authentication failed: ${authResult.reason}`)
        }

        this.logger.info('✅ API key validation successful')
        
        // Process inference via inference worker
        const result = await this.processInference(requestData)
        
        // ADD USAGE TRACKING HERE - this was missing!
        if (result.usage) {
          this.logger.info(`📈 Tracking usage: ${result.usage.total_tokens} tokens`)
          await this.trackUsage(apiKey, result)
        } else {
          this.logger.warn('⚠️  No usage data in result')
        }
        
        this.logger.info('✅ Gateway inference completed')
        return Buffer.from(JSON.stringify(result))
        
      } catch (error) {
        this.logger.error('❌ Gateway infer error:', error.message)
        const errorResponse = { error: error.message }
        return Buffer.from(JSON.stringify(errorResponse))
      }
    })

    // Health check
    this.server.respond('health', async () => {
      this.logger.info('📞 GATEWAY HEALTH check received')
      const healthData = {
        status: 'healthy',
        authPeers: 1,
        inferencePeers: 1,
        timestamp: Date.now()
      }
      return Buffer.from(JSON.stringify(healthData))
    })

    // Add stats handler
    this.server.respond('stats', async (req) => {
      this.logger.info('📊 GATEWAY STATS request received')
      
      try {
        const { apiKey } = JSON.parse(req.toString())
        
        const stats = this.usageStats.get(apiKey) || {
          totalRequests: 0,
          totalTokens: 0,
          requestHistory: []
        }
        
        this.logger.info(`📊 Returning stats for ${apiKey}: ${stats.totalRequests} requests`)
        return Buffer.from(JSON.stringify(stats))
        
      } catch (error) {
        this.logger.error('❌ Stats error:', error.message)
        return Buffer.from(JSON.stringify({
          totalRequests: 0,
          totalTokens: 0,
          requestHistory: []
        }))
      }
    })
  }

  async startServiceDiscovery () {
    // This would normally discover other services
    // For now, we'll simulate having services available
    this.logger.info('Service discovery started')
  }

  async validateApiKey(apiKey) {
    if (!apiKey) {
      return { valid: false, reason: 'API key is required' }
    }

    const keyData = this.apiKeys.get(apiKey)
    if (!keyData) {
      return { valid: false, reason: 'Invalid API key' }
    }

    if (!keyData.active) {
      return { valid: false, reason: 'API key is inactive' }
    }

    return { valid: true, keyData }
  }

  checkRateLimit(apiKey) {
    const now = Date.now()
    const windowMs = 60 * 1000 // 1 minute window

    if (!this.rateLimits.has(apiKey)) {
      this.rateLimits.set(apiKey, {
        requests: [],
        lastReset: now
      })
    }

    const rateLimitData = this.rateLimits.get(apiKey)
    const keyData = this.apiKeys.get(apiKey)
    const maxRequests = keyData?.maxRequestsPerMinute || 10

    // Remove old requests outside the window
    rateLimitData.requests = rateLimitData.requests.filter(
      requestTime => now - requestTime < windowMs
    )

    // Check if under limit
    if (rateLimitData.requests.length >= maxRequests) {
      this.logger.warn(`🚫 Rate limit exceeded for API key: ${apiKey}`)
      return false
    }

    // Add current request
    rateLimitData.requests.push(now)
    return true
  }

  async processInference(requestData) {
    try {
      // Discover inference worker
      const inferenceKey = await this.discoverWorker('inference')
      
      // Forward request to inference worker
      const request = Buffer.from(JSON.stringify({
        prompt: requestData.prompt,
        model: requestData.model || 'gpt-3.5-turbo',
        options: requestData.options || {}
      }))
      
      this.logger.info('🔄 Forwarding to inference worker...')
      const result = await this.rpc.request(inferenceKey, 'process', request)
      return JSON.parse(result.toString())
      
    } catch (error) {
      this.logger.error('Failed to process inference:', error.message)
      throw error
    }
  }

  async trackUsage(apiKey, result) {
    try {
      this.logger.info(`📈 TRACK USAGE: ${apiKey}, tokens: ${result.usage?.total_tokens}`)
      
      // Send raw data to auth service - let auth service do the exact same logic
      const authWorkerKey = await this.discoverWorker('auth')
      const request = Buffer.from(JSON.stringify({
        apiKey: apiKey,
        tokens: result.usage?.total_tokens || 0,  // Send raw token count
        model: result.model || 'unknown'          // Send raw model name
      }))
      
      const response = await this.rpc.request(authWorkerKey, 'track-usage', request)
      const trackResult = JSON.parse(response.toString())
      
      if (trackResult.success) {
        this.logger.info(`📈 Usage successfully tracked via auth service for ${apiKey}`)
      } else {
        this.logger.error(`📈 Failed to track usage via auth service: ${trackResult.error}`)
      }
      
    } catch (error) {
      this.logger.error('Failed to track usage via auth service:', error.message)
    }
  }

  saveDiscoveryInfo(publicKey) {
    try {
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
      discovery.workers.gateway = {
        publicKey: publicKey,
        timestamp: Date.now(),
        status: 'active'
      }
      
      fs.writeFileSync(discoveryPath, JSON.stringify(discovery, null, 2))
      this.logger.info(`✅ Saved public key to discovery.json: ${publicKey}`)
      
    } catch (error) {
      this.logger.error('Failed to save discovery info:', error.message)
    }
  }

  async validateApiKeyViaAuth(apiKey) {
    try {
      // Discover auth worker
      const authWorkerKey = await this.discoverWorker('auth')
      
      // Send validation request to auth service
      const request = Buffer.from(JSON.stringify({ apiKey }))
      const response = await this.rpc.request(authWorkerKey, 'validate', request)
      
      const result = JSON.parse(response.toString())
      this.logger.info(`🔐 Auth validation result: ${result.valid}`)
      
      return result
      
    } catch (error) {
      this.logger.error('Failed to validate API key via auth service:', error.message)
      return { valid: false, reason: 'Authentication service error' }
    }
  }

  _start (cb) {
    this.setupRPC().then(async () => {
      try {
        // Create server FIRST
        this.server = this.rpc.createServer()
        this.logger.info('✅ Gateway RPC server created')
        
        // Setup handlers
        this.setupRPCHandlers()
        
        // Start listening
        await this.server.listen()
        this.logger.info('✅ Gateway server listen() called')
        
        const pubkey = this.server.publicKey.toString('hex')
        this.logger.info(`🚀 Gateway server listening on: ${pubkey}`)
        
        // Test that server is actually responsive
        setTimeout(async () => {
          try {
            this.logger.info('🧪 Testing self-ping...')
            const selfResponse = await this.rpc.request(this.server.publicKey, 'ping', Buffer.from('self-test'))
            this.logger.info('✅ Self-ping successful:', selfResponse.toString())
          } catch (error) {
            this.logger.error('❌ Self-ping failed:', error.message)
          }
        }, 2000)
        
        // Save discovery info
        this.saveDiscoveryInfo(pubkey)
        
        this.logger.info('✅ Gateway worker RPC setup complete')
        cb()
      } catch (error) {
        this.logger.error('Failed to start gateway worker:', error.message)
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
}

module.exports = GatewayWorker