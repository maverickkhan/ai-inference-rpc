'use strict'

const WrkBase = require('./base.wrk.js')
const bcrypt = require('bcrypt')
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const RPC = require('@hyperswarm/rpc')
const DHT = require('@hyperswarm/dht')
const Hyperswarm = require('hyperswarm')
const fs = require('fs')
const path = require('path')

class AuthWorker extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)
    this.name = 'auth'
    
    // Initialize required structures manually
    this.conf.init = { facilities: [] }
    this.status = {}
    
    // Create a simple logger
    this.logger = {
      info: (msg) => console.log(`[AUTH] ${msg}`),
      error: (msg, err) => console.error(`[AUTH] ${msg}`, err),
      warn: (msg) => console.warn(`[AUTH] ${msg}`),
      debug: (msg) => console.log(`[AUTH] ${msg}`)
    }

    // In-memory storage for demo (replace with real DB)
    this.users = new Map()
    this.apiKeys = new Map()
    this.usage = new Map()
  }

  init () {
    // Don't call super.init() - do minimal initialization
    try {
      this.loadConf('common')
    } catch (error) {
      this.logger.warn('Could not load common config, using defaults')
      // Set default config
      this.conf.services = {
        auth: { port: 9001 },
        rateLimit: { windowMs: 60000, requests: 100 }
      }
    }
  }

  // Override the start method to avoid facility loading
  start (cb) {
    this.logger.info('Starting auth worker...')
    
    // Call init first!
    this.init()
    
    this._start((err) => {
      if (err) return cb(err)
      this.active = 1
      this.logger.info('Auth worker started successfully')
      cb()
    })
  }

  // Override stop method
  stop (cb) {
    this.logger.info('Stopping auth worker...')
    this._stop(cb)
  }

  async setupRPC () {
    try {
      this.logger.info('🔧 Setting up RPC with DHT...')
      
      // Create DHT - remove bootstrap config, use defaults like the working test
      this.dht = new DHT()
      
      // Don't call await dht.ready() - let RPC handle it
      this.logger.info('✅ Auth DHT created')
      
      // Create RPC with DHT
      this.rpc = new RPC({ dht: this.dht })
      this.logger.info('✅ RPC instance created with DHT')
      
      // Create server
      this.server = this.rpc.createServer()
      this.logger.info('✅ RPC server created')
      
      // Listen
      await this.server.listen()
      this.logger.info(`✅ Auth server listening on: ${this.server.address().publicKey.toString('hex')}`)
      
      // Save public key to discovery file
      await this.saveToDiscoveryFile()
      
      // Setup handlers
      this.setupRPCHandlers()
      
      this.logger.info('✅ Auth worker RPC setup complete')
      
    } catch (error) {
      this.logger.error('Failed to setup RPC:', error.message)
      throw error
    }
  }

  async testSelfConnection() {
    try {
      this.logger.info('🧪 Testing self-connection...')
      
      // Skip self-connection test for now - it might not work in same process
      this.logger.info('⚠️ Skipping self-connection test (same process limitation)')
      
      // Instead, just verify our server is listening
      const publicKey = this.server.address().publicKey
      this.logger.info(`✅ Server is listening on: ${publicKey.toString('hex')}`)
      this.logger.info(`✅ Server address available: ${!!this.server.address()}`)
      
    } catch (error) {
      this.logger.error('❌ Self-test failed:', error.message)
    }
  }

  async saveToDiscoveryFile() {
    const fs = require('fs')
    const path = require('path')
    
    try {
      // Ensure config directory exists
      const configDir = path.join(__dirname, '../config')
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }
      
      const discoveryPath = path.join(configDir, 'discovery.json')
      
      let discovery = {}
      if (fs.existsSync(discoveryPath)) {
        discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
      }
      
      if (!discovery.workers) discovery.workers = {}
      
      // Save this worker's public key
      discovery.workers[this.name] = {
        publicKey: this.server.address().publicKey.toString('hex'),
        timestamp: Date.now(),
        status: 'active'
      }
      
      fs.writeFileSync(discoveryPath, JSON.stringify(discovery, null, 2))
      this.logger.info(`✅ Saved ${this.name} worker to discovery file`)
      this.logger.info(`📁 Discovery file: ${discoveryPath}`)
      
    } catch (error) {
      this.logger.error('Failed to save to discovery file:', error.message)
    }
  }

  findUserByApiKey(apiKey) {
    // Search through users to find one with matching API key
    for (const [username, user] of this.users) {
      if (user.apiKey === apiKey) {
        return user
      }
    }
    return null
  }

  setupRPCHandlers() {
    this.logger.info('🔧 Setting up Auth RPC handlers...')
    
    // Simple ping handler for testing
    this.server.respond('ping', async (data) => {
      this.logger.info(`📞 PING HANDLER CALLED! Data: ${data.toString()}`)
      return Buffer.from('pong')
    })

    // Register handler
    this.server.respond('register', async (data) => {
      this.logger.info('📞 REGISTER HANDLER CALLED!')
      this.logger.info(`📞 Data received: ${data.toString()}`)
      
      try {
        const requestData = JSON.parse(data.toString())
        const { username, email, password } = requestData
        
        this.logger.info(`📞 Registering user: ${username}`)
        
        // Check if user already exists
        if (this.users.has(username)) {
          throw new Error('Username already exists')
        }
        
        // Simple registration
        const userId = crypto.randomUUID()
        const apiKey = crypto.randomUUID()
        
        // Store user
        this.users.set(username, {
          id: userId,
          username,
          email,
          password: password, // In real app, hash this!
          createdAt: new Date(),
          apiKey
        })
        
        // Store API key mapping
        this.apiKeys.set(apiKey, username)
        
        // Initialize usage with username as key (to match findUserByApiKey)
        this.usage.set(username, {
          totalRequests: 0,
          totalTokensUsed: 0,
          lastRequest: null
        })
        
        const response = {
          message: 'User registered successfully',
          apiKey: apiKey
        }
        
        this.logger.info(`📞 Registration successful for ${username}, API key: ${apiKey}`)
        return Buffer.from(JSON.stringify(response))
        
      } catch (error) {
        this.logger.error('📞 Registration handler error:', error.message)
        const errorResponse = {
          error: error.message
        }
        return Buffer.from(JSON.stringify(errorResponse))
      }
    })

    // Get usage handler
    this.server.respond('getUsage', (req) => {
      try {
        this.logger.info('📞 Get usage request received')
        
        const requestData = JSON.parse(req.toString())
        const { apiKey } = requestData
        
        this.logger.info(`📞 Looking up usage for API key: ${apiKey}`)
        
        // Find user by API key
        const user = this.findUserByApiKey(apiKey)
        if (!user) {
          throw new Error('Invalid API key')
        }
        
        // Get usage data
        const usage = this.usage.get(user.username) || {
          totalRequests: 0,
          totalTokensUsed: 0,
          lastRequest: null
        }
        
        const response = {
          username: user.username,
          email: user.email,
          createdAt: user.createdAt,
          usage: {
            totalRequests: usage.totalRequests || 0,
            totalTokensUsed: usage.totalTokensUsed || 0,
            lastRequest: usage.lastRequest || null
          }
        }
        
        this.logger.info(`📞 Returning usage data:`, response)
        return Buffer.from(JSON.stringify(response))
        
      } catch (error) {
        this.logger.error('📞 Get usage error:', error.message)
        const errorResponse = {
          error: error.message,
          username: 'Unknown',
          email: 'Unknown',
          createdAt: new Date(),
          usage: {
            totalRequests: 0,
            totalTokensUsed: 0,
            lastRequest: null
          }
        }
        return Buffer.from(JSON.stringify(errorResponse))
      }
    })

    // Generate API key handler
    this.server.respond('generateApiKey', async (data) => {
      this.logger.info('📞 GENERATE API KEY HANDLER CALLED!')
      
      try {
        const requestData = JSON.parse(data.toString())
        const { username, password } = requestData
        
        const user = this.users.get(username)
        if (!user || user.password !== password) {
          throw new Error('Invalid username or password')
        }
        
        // Generate new API key
        const newApiKey = crypto.randomUUID()
        
        // Remove old API key mapping
        this.apiKeys.delete(user.apiKey)
        
        // Update user with new API key
        user.apiKey = newApiKey
        this.users.set(username, user)
        
        // Add new API key mapping
        this.apiKeys.set(newApiKey, username)
        
        const response = {
          apiKey: newApiKey
        }
        
        this.logger.info(`📞 New API key generated for ${username}: ${newApiKey}`)
        return Buffer.from(JSON.stringify(response))
        
      } catch (error) {
        this.logger.error('📞 Generate API key error:', error.message)
        const errorResponse = {
          error: error.message
        }
        return Buffer.from(JSON.stringify(errorResponse))
      }
    })
    
    // API Key Validation
    this.server.respond('validate', async (req) => {
      this.logger.info('🔐 AUTH VALIDATE request received')
      
      try {
        const { apiKey } = JSON.parse(req.toString())
        const result = await this.validateApiKey(apiKey)
        
        this.logger.info(`🔐 Validation result for ${apiKey}: ${result.valid}`)
        return Buffer.from(JSON.stringify(result))
        
      } catch (error) {
        this.logger.error('❌ Validation error:', error.message)
        return Buffer.from(JSON.stringify({
          valid: false,
          reason: 'Validation error'
        }))
      }
    })

    // Rate Limit Check
    this.server.respond('check-limit', async (req) => {
      this.logger.info('🚦 AUTH RATE LIMIT CHECK request received')
      
      try {
        const { apiKey } = JSON.parse(req.toString())
        const allowed = await this.checkRateLimit(apiKey)
        
        this.logger.info(`🚦 Rate limit check for ${apiKey}: ${allowed}`)
        return Buffer.from(JSON.stringify({ allowed }))
        
      } catch (error) {
        this.logger.error('❌ Rate limit error:', error.message)
        return Buffer.from(JSON.stringify({ allowed: true })) // Allow on error
      }
    })

    // Track Usage
    this.server.respond('track-usage', async (req) => {
      this.logger.info('📈 AUTH TRACK USAGE request received')
      
      try {
        // Debug: Log what we actually received
        this.logger.info('📈 Raw request data:', req.toString())
        
        const requestData = JSON.parse(req.toString())
        this.logger.info('📈 Parsed request data:', requestData)
        
        const { apiKey, tokens, model } = requestData
        this.logger.info(`📈 Extracted values - apiKey: ${apiKey}, tokens: ${tokens}, model: ${model}`)
        
        await this.trackUsage(apiKey, tokens, model)
        
        this.logger.info(`📈 Usage tracked for ${apiKey}`)
        return Buffer.from(JSON.stringify({ success: true }))
        
      } catch (error) {
        this.logger.error('❌ Track usage error:', error.message)
        this.logger.error('❌ Full error:', error)
        return Buffer.from(JSON.stringify({ success: false, error: error.message }))
      }
    })

    // Get Stats
    this.server.respond('stats', async (req) => {
      this.logger.info('📊 AUTH STATS request received')
      
      try {
        const { apiKey } = JSON.parse(req.toString())
        const stats = await this.getUserStats(apiKey)
        
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

    // Get User Profile
    this.server.respond('profile', async (req) => {
      this.logger.info('👤 AUTH PROFILE request received')
      
      try {
        const { apiKey } = JSON.parse(req.toString())
        const profile = await this.getUserProfile(apiKey)
        
        this.logger.info(`👤 Returning profile for ${apiKey}`)
        return Buffer.from(JSON.stringify(profile))
        
      } catch (error) {
        this.logger.error('❌ Profile error:', error.message)
        return Buffer.from(JSON.stringify({
          user: { username: 'Unknown', email: 'Unknown' },
          apiKey: { tier: 'unknown' },
          usage: { totalRequests: 0, totalTokens: 0 }
        }))
      }
    })
    
    this.logger.info('✅ Auth RPC handlers setup complete')
  }

  _start (cb) {
    // Setup RPC server
    this.setupRPC().then(() => {
      this.logger.info('Auth worker RPC server started successfully')
      cb()
    }).catch(cb)
  }

  async _stop (cb) {
    if (this.server) {
      await this.server.close()
      this.logger.info('Auth RPC server stopped')
    }
    if (this.rpc) {
      await this.rpc.destroy()
    }
    if (this.dht) {
      await this.dht.destroy()
    }
    cb()
  }

  async validateApiKey(apiKey) {
    if (!apiKey) {
      return { valid: false, reason: 'API key is required' }
    }

    const keyData = this.apiKeys.get(apiKey)
    if (!keyData) {
      return { valid: false, reason: 'Invalid API key' }
    }

    return { valid: true, keyData }
  }

  async checkRateLimit(apiKey) {
    const now = Date.now()
    const windowMs = 60 * 1000 // 1 minute window

    try {
      // Get API key data for limits
      const keyData = this.apiKeys.get(apiKey)
      const maxRequests = keyData?.maxRequestsPerMinute || 10

      // Get rate limit data
      let rateLimitData = this.rateLimits.get(apiKey) || {
        requests: [],
        lastReset: now
      }

      // Remove old requests outside the window
      rateLimitData.requests = rateLimitData.requests.filter(
        requestTime => now - requestTime < windowMs
      )

      // Check if under limit
      if (rateLimitData.requests.length >= maxRequests) {
        this.logger.warn(`🚫 Rate limit exceeded for API key: ${apiKey}`)
        return false
      }

      // Add current request and save
      rateLimitData.requests.push(now)
      this.rateLimits.set(apiKey, rateLimitData)
      
      return true
    } catch (error) {
      this.logger.error('Rate limit check error:', error.message)
      return true // Allow on error
    }
  }

  async trackUsage(apiKey, tokens, model) {
    try {
      this.logger.info(`📈 TRACK USAGE: ${apiKey}, tokens: ${tokens}`)
      
      // EXACT same logic as gateway had
      if (!this.usage.has(apiKey)) {
        this.logger.info(`📈 Creating new usage entry for ${apiKey}`)
        this.usage.set(apiKey, {
          totalRequests: 0,
          totalTokens: 0,
          requestHistory: []
        })
      }

      const stats = this.usage.get(apiKey) 
      stats.totalRequests++
      stats.totalTokens += tokens
      stats.requestHistory.push({
        timestamp: Date.now(),
        tokens: tokens,
        model: model
      })

      // Keep only last 100 requests
      if (stats.requestHistory.length > 100) {
        stats.requestHistory = stats.requestHistory.slice(-100)
      }

      this.logger.info(`📈 Updated stats for ${apiKey}:`, JSON.stringify(stats))
      
    } catch (error) {
      this.logger.error('Failed to track usage:', error.message)
      throw error
    }
  }

  async getUserStats(apiKey) {
    const stats = this.usage.get(apiKey) || {
      totalRequests: 0,
      totalTokens: 0,
      requestHistory: []
    }
    return stats
  }

  async getUserProfile(apiKey) {
    try {
      // Get API key data
      const username = this.apiKeys.get(apiKey)
      if (!username) {
        throw new Error('API key not found')
      }
      
      // Get user data
      const userData = this.users.get(username)
      if (!userData) {
        throw new Error('User not found')
      }
      
      // Get usage stats
      const stats = await this.getUserStats(apiKey)
      
      return {
        user: userData,
        apiKey: {
          key: apiKey,
          tier: username.tier,
          active: username.active,
          maxRequestsPerMinute: username.maxRequestsPerMinute,
          createdAt: username.createdAt
        },
        usage: stats
      }
      
    } catch (error) {
      this.logger.error('Failed to get user profile:', error.message)
      throw error
    }
  }
}

module.exports = AuthWorker