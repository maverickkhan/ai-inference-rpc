'use strict'

const WrkBase = require('./base.wrk.js')
const express = require('express')
const path = require('path')
const DHT = require('@hyperswarm/dht')
const RPC = require('@hyperswarm/rpc')
const fs = require('fs')

class WebWorker extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)
    this.name = 'web'
    
    // Initialize required structures manually
    this.conf.init = { facilities: [] }
    this.status = {}
    
    // Create a simple logger
    this.logger = {
      info: (msg) => console.log(`[WEB] ${msg}`),
      error: (msg, err) => console.error(`[WEB] ${msg}`, err),
      warn: (msg) => console.warn(`[WEB] ${msg}`),
      debug: (msg) => console.log(`[WEB] ${msg}`)
    }
  }

  init () {
    // Don't call super.init() - do minimal initialization
    try {
      this.loadConf('common')
    } catch (error) {
      this.logger.warn('Could not load common config, using defaults')
      // Set default config
      this.conf.services = {
        web: { port: 3000 },
        rateLimit: { windowMs: 60000, requests: 100 }
      }
    }
    this.setupExpressApp()
  }

  // Override the start method to avoid facility loading
  start (cb) {
    this.logger.info('Starting web worker...')
    
    // Call init first!
    this.init()
    
    this._start((err) => {
      if (err) return cb(err)
      this.active = 1
      this.logger.info('Web worker started successfully')
      cb()
    })
  }

  // Override stop method
  stop (cb) {
    this.logger.info('Stopping web worker...')
    this._stop(cb)
  }

  async setupRPC () {
    try {
      this.logger.info('🔧 Setting up Web RPC client for Auth service...')
      
      this.dht = new DHT()
      this.rpc = new RPC({ dht: this.dht })
      
      // Discover auth worker
      this.authWorkerKey = await this.discoverWorker('auth')
      this.logger.info(`✅ Found auth worker: ${this.authWorkerKey}`)
      
    } catch (error) {
      this.logger.error('Failed to setup RPC:', error.message)
      throw error
    }
  }

  async testAuthConnection() {
    try {
      this.logger.info('🧪 Testing auth worker connection with PING...')
      
      const authPublicKey = await this.discoverWorker('auth')
      this.logger.info(`Found auth public key: ${authPublicKey.toString('hex')}`)
      
      // Try ping first
      this.logger.info('📞 Sending PING...')
      const pingResult = await this.rpc.request(authPublicKey, 'ping', Buffer.from('hello'))
      this.logger.info(`✅ PING successful: ${pingResult.toString()}`)
      
    } catch (error) {
      this.logger.error('❌ PING test failed:', error.message)
      this.logger.error('❌ PING error stack:', error.stack)
    }
  }

  async discoverWorker(workerName) {
    const discoveryPath = path.join(__dirname, '../config/discovery.json')
    
    if (!fs.existsSync(discoveryPath)) {
      throw new Error(`Discovery file not found: ${discoveryPath}`)
    }
    
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
    const worker = discovery.workers?.[workerName]
    
    if (!worker) {
      throw new Error(`Worker ${workerName} not found in discovery`)
    }
    
    return Buffer.from(worker.publicKey, 'hex')
  }

  setupExpressApp () {
    this.app = express()
    this.app.use(express.json())
    this.app.use(express.urlencoded({ extended: true }))
    this.app.use(express.static(path.join(__dirname, '../web/public')))
    
    // Set view engine
    this.app.set('view engine', 'ejs')
    this.app.set('views', path.join(__dirname, '../web/views'))

    // Routes
    this.setupRoutes()
  }

  setupRoutes () {
    // Home page
    this.app.get('/', (req, res) => {
      res.render('index', { 
        error: null,
        message: null 
      })
    })

    // Register page
    this.app.get('/register', (req, res) => {
      res.render('register', { 
        error: null,
        message: null 
      })
    })

    // Registration endpoint
    this.app.post('/register', async (req, res) => {
      try {
        this.logger.info('Registration request received')
        
        // Check if RPC is ready
        if (!this.rpc) {
          throw new Error('RPC client not ready yet')
        }
        
        const { username, email, password } = req.body
        
        // Discover auth worker
        const authPublicKey = await this.discoverWorker('auth')
        this.logger.info(`Connecting to auth worker: ${authPublicKey.toString('hex')}`)
        
        // Prepare data
        const requestData = Buffer.from(JSON.stringify({
          username,
          email, 
          password
        }))
        
        this.logger.info('Sending registration request...')
        
        // Make RPC request
        const result = await this.rpc.request(authPublicKey, 'register', requestData)
        
        this.logger.info(`Registration response received: ${result.toString()}`)
        
        // Parse response
        const response = JSON.parse(result.toString())
        
        if (response.error) {
          throw new Error(response.error)
        }
        
        res.render('success', {
          title: 'Registration Successful',
          message: response.message,
          apiKey: response.apiKey
        })
        
      } catch (error) {
        this.logger.error('Registration error:', error.message)
        res.render('register', {
          title: 'Register',
          error: error.message
        })
      }
    })

    // Dashboard page
    this.app.get('/dashboard', async (req, res) => {
      try {
        // Get the API key - use the test key we know works
        const apiKey = '887935a3-c52c-4955-b508-3fd8e0ff1494'
        
        // Fetch real usage data from gateway
        let usageData = {
          totalRequests: 0,
          totalTokens: 0,
          requestHistory: []
        }
        
        let error = null
        
        try {
          const authKey = await this.discoverWorker('auth')
          const request = Buffer.from(JSON.stringify({ apiKey }))
          const result = await this.rpc.request(authKey, 'stats', request)
          usageData = JSON.parse(result.toString())
          this.logger.info(`📊 Dashboard data: ${usageData.totalRequests} requests, ${usageData.totalTokens} tokens`)
        } catch (statsError) {
          this.logger.warn('Could not fetch real usage data:', statsError.message)
          error = `Unable to fetch usage statistics: ${statsError.message}`
        }
        
        // Use your original dashboard template with real data
        const dashboardData = {
          error: error,
          totalRequests: usageData.totalRequests || 0,
          totalTokens: usageData.totalTokens || 0,
          lastRequest: usageData.requestHistory?.length > 0 
            ? new Date(usageData.requestHistory[usageData.requestHistory.length - 1].timestamp).toLocaleString()
            : 'Never',
          memberSince: '6/2/2025',
          username: 'ahai@iekomedia.com',
          email: 'abdulhai.elegant@gmail.com',
          apiKey: apiKey,
          usage: usageData.totalRequests > 0 ? usageData : null
        }
        
       return res.render('dashboard', dashboardData)
        
      } catch (error) {
        this.logger.error('Dashboard error:', error.message)
        res.render('dashboard', {
          error: `Dashboard error: ${error.message}`,
          totalRequests: 0,
          totalTokens: 0,
          lastRequest: 'Never',
          memberSince: '6/2/2025',
          username: 'ahai@iekomedia.com',
          email: 'abdulhai.elegant@gmail.com',
          apiKey: '887935a3-c52c-4955-b508-3fd8e0ff1494',
          usage: null
        })
      }
    })

    // Add POST handler for dashboard (for form submissions)
    this.app.post('/dashboard', async (req, res) => {
      try {
        const { action, apiKey: submittedApiKey } = req.body
        
        // if (action === 'checkKey' && submittedApiKey) {
        if (!!submittedApiKey) {
          // Handle "Check Another Key" functionality
          try {
            const authKey = await this.discoverWorker('auth')
            const request = Buffer.from(JSON.stringify({ apiKey: submittedApiKey }))
            
            // Fetch both stats and profile
            const statsResult = await this.rpc.request(authKey, 'stats', request)
            const usageData = JSON.parse(statsResult.toString())
            
            const profileResult = await this.rpc.request(authKey, 'profile', request)
            const profile = JSON.parse(profileResult.toString())
            
            let profileData = {
              username: 'Unknown',
              email: 'Unknown', 
              memberSince: new Date().toISOString()
            }
            
            if (profile.user) {
              profileData = {
                username: profile.user.username || 'Unknown',
                email: profile.user.email || 'Unknown',
                memberSince: profile.user.createdAt || new Date().toISOString()
              }
            }
            
            // Render dashboard with the checked key's data
            return res.render('dashboard', {
              error: null,
              totalRequests: usageData.totalRequests || 0,
              totalTokens: usageData.totalTokens || 0,
              lastRequest: usageData.requestHistory?.length > 0 
                ? new Date(usageData.requestHistory[usageData.requestHistory.length - 1].timestamp).toLocaleString()
                : 'Never',
              memberSince: profileData.memberSince,
              username: profileData.username,
              email: profileData.email,
              apiKey: submittedApiKey,
              usage: usageData.totalRequests > 0 ? usageData : null,
              message: `Showing data for API key: ${submittedApiKey.substring(0, 8)}...`
            })
            
          } catch (error) {
            return res.render('dashboard', {
              error: `Failed to check API key: ${error.message}`,
              totalRequests: 0,
              totalTokens: 0,
              lastRequest: 'Never',
              memberSince: '6/2/2025',
              username: 'ahai@iekomedia.com',
              email: 'abdulhai.elegant@gmail.com',
              apiKey: submittedApiKey,
              usage: null
            })
          }
        }
        
        if (action === 'generateKey') {
          // Handle "Generate New Key" functionality
          const newApiKey = require('crypto').randomUUID()
          
          return res.render('dashboard', {
            error: null,
            totalRequests: 0,
            totalTokens: 0,
            lastRequest: 'Never',
            memberSince: new Date().toLocaleDateString(),
            username: 'ahai@iekomedia.com',
            email: 'abdulhai.elegant@gmail.com',
            apiKey: newApiKey,
            usage: null,
            message: `New API key generated: ${newApiKey}`
          })
        }
        
        // Default: redirect to GET dashboard
        res.redirect('/dashboard')
        
      } catch (error) {
        this.logger.error('Dashboard POST error:', error.message)
        res.render('dashboard', {
          error: `Error: ${error.message}`,
          totalRequests: 0,
          totalTokens: 0,
          lastRequest: 'Never',
          memberSince: '6/2/2025',
          username: 'ahai@iekomedia.com',
          email: 'abdulhai.elegant@gmail.com',
          apiKey: '887935a3-c52c-4955-b508-3fd8e0ff1494',
          usage: null
        })
      }
    })

    // Generate API key page
    this.app.get('/generate-key', (req, res) => {
      res.render('generate-key', { title: 'Generate API Key', apiKey: null, error: null })
    })

    // Generate API key endpoint
    this.app.post('/generate-key', async (req, res) => {
      try {
        const { username, password } = req.body
        
        // Discover and connect to auth worker
        const authPublicKey = await this.discoverWorker('auth')
        
        // Encode data as Buffer for RPC
        const requestData = Buffer.from(JSON.stringify({
          username,
          password
        }))
        
        const result = await this.rpc.request(authPublicKey, 'generateApiKey', requestData)
        
        // Parse response
        const response = JSON.parse(result.toString())
        
        if (response.error) {
          throw new Error(response.error)
        }
        
        res.render('generate-key', {
          title: 'Generate API Key',
          apiKey: response.apiKey,
          error: null
        })
      } catch (error) {
        this.logger.error('Generate key error:', error.message)
        res.render('generate-key', {
          title: 'Generate API Key',
          apiKey: null,
          error: error.message
        })
      }
    })

    // Update API usage endpoint to use auth service
    this.app.get('/api/usage', async (req, res) => {
      try {
        const apiKey = req.query.apiKey
        
        this.logger.info(`📊 Web requesting usage stats for: ${apiKey}`)
        
        // Call auth service for stats
        const response = await this.rpc.request(
          this.authWorkerKey,
          'stats',
          Buffer.from(JSON.stringify({ apiKey }))
        )
        
        const stats = JSON.parse(response.toString())
        this.logger.info(`📊 Received stats from auth service:`, stats)
        
        res.json(stats)
        
      } catch (error) {
        this.logger.error('❌ Error getting usage:', error.message)
        res.status(500).json({
          error: 'Failed to get usage data',
          totalRequests: 0,
          totalTokens: 0,
          requestHistory: []
        })
      }
    })

    // Update profile endpoint to use auth service  
    this.app.get('/api/profile', async (req, res) => {
      try {
        const apiKey = req.query.apiKey || '887935a3-c52c-4955-b508-3fd8e0ff1494'
        
        this.logger.info(`👤 Web requesting profile for: ${apiKey}`)
        
        // Call auth service for profile
        const response = await this.rpc.request(
          this.authWorkerKey, 
          'profile',
          Buffer.from(JSON.stringify({ apiKey }))
        )
        
        const profile = JSON.parse(response.toString())
        this.logger.info(`👤 Received profile from auth service`)
        
        res.json(profile)
        
      } catch (error) {
        this.logger.error('❌ Error getting profile:', error.message)
        res.status(500).json({
          error: 'Failed to get profile data',
          user: { username: 'Unknown', email: 'Unknown' },
          apiKey: { tier: 'unknown' },
          usage: { totalRequests: 0, totalTokens: 0 }
        })
      }
    })

    // Add validation endpoint (for debugging)
    this.app.get('/api/validate', async (req, res) => {
      try {
        const apiKey = req.query.apiKey || '887935a3-c52c-4955-b508-3fd8e0ff1494'
        
        this.logger.info(`🔐 Web validating API key: ${apiKey}`)
        
        const response = await this.rpc.request(
          this.authWorkerKey,
          'validate', 
          Buffer.from(JSON.stringify({ apiKey }))
        )
        
        const result = JSON.parse(response.toString())
        res.json(result)
        
      } catch (error) {
        this.logger.error('❌ Error validating API key:', error.message)
        res.status(500).json({
          valid: false,
          reason: 'Validation service error'
        })
      }
    })
  }

  _start (cb) {
    this.setupRPC().then(() => {
      this.server = this.app.listen(this.conf.services?.web?.port || 3000, () => {
        this.logger.info(`🌐 Web server running on http://localhost:${this.conf.services?.web?.port || 3000}`)
        cb()
      })
    }).catch(cb)
  }

  async _stop (cb) {
    if (this.server) {
      this.server.close(() => {
        this.logger.info('Web server stopped')
        if (this.rpc) this.rpc.destroy()
        if (this.dht) this.dht.destroy()
        cb()
      })
    } else {
      if (this.rpc) await this.rpc.destroy()
      if (this.dht) await this.dht.destroy()
      cb()
    }
  }
}

module.exports = WebWorker 