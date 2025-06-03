# AI Inference Platform

A distributed AI inference platform built on Hyperswarm RPC with peer-to-peer architecture, providing scalable AI inference services with built-in authentication, rate limiting, and monitoring.

## 🏗️ Architecture

This platform uses a microservice architecture with the following components:

- **Gateway Worker**: API gateway handling authentication, rate limiting, and request routing
- **Auth Worker**: User registration, API key management, and authentication services  
- **Inference Worker**: AI model inference using OpenAI/Ollama backends
- **Web Worker**: Web interface for user management and dashboard
- **Base Worker**: Shared functionality including metrics, storage, and RPC handling

### Key Features

- 🔗 **P2P Architecture**: Built on Hyperswarm for decentralized networking
- 📊 **Prometheus Metrics**: Built-in monitoring for all services
- 🔐 **API Key Authentication**: Secure access control with usage tracking
- ⚡ **Rate Limiting**: Configurable request limits per API key
- 🗄️ **Persistent Storage**: Hyperbee-based distributed storage
- 🌐 **Web Interface**: User-friendly dashboard for account management
- 🖥️ **CLI Tool**: Command-line interface for all operations
- 🤖 **Multiple AI Backends**: Support for OpenAI, Ollama, and other providers

## 🚀 Quick Start

### Prerequisites

- Node.js 16+ 
- npm or yarn

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd ai-inference-platform
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Setup configuration:**
   ```bash
   ./setup-config.sh
   ```

4. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

### Starting the Platform

Start each worker in separate terminals:

```bash
# Terminal 1 - Auth Service
npm run auth

# Terminal 2 - Gateway Service  
npm run gateway

# Terminal 3 - Inference Service
npm run inference

# Terminal 4 - Web Interface
npm run web
```

The services will be available at:
- **Web Interface**: http://localhost:3000
- **Gateway Metrics**: http://localhost:9090/metrics
- **Auth Metrics**: http://localhost:9091/metrics
- **Inference Metrics**: http://localhost:9092/metrics
- **Web Metrics**: http://localhost:9093/metrics

## 📖 Usage

### Web Interface

1. **Register a new account**: Visit http://localhost:3000/register
2. **Generate API key**: Use the web dashboard to create your API key
3. **View usage**: Monitor your API usage and limits from dashboard

### CLI Tool

```bash
# Register your api key
export AI_API_KEY="c4300ba3-e5cd-41d9-b49f-37e44e4bdc61" 

# Make inference request
./cli/ai-inference-cli.js infer "What is the capital of Uganda?" --model gpt-3.5-turbo
```

## ⚙️ Configuration

### Environment Variables

```bash
# .env
OPENAI_API_KEY=your_openai_api_key_here
```

### Common Configuration

Edit `config/common.json`:

```json
{
  "debug": 1,
  "env": "development",
  "services": {
    "discovery": {
      "namespace": "ai-inference-platform"
    },
    "inference": {
      "backend": "openai",
      "defaultModel": "gpt-3.5-turbo"
    }
  },
  "metrics": {
    "enabled": true,
    "port": 9090
  }
}
```

## 🧪 Testing

### Manual Testing

```bash
# Test gateway connectivity
node test-gateway-ping.js

# Test single process
node test-single-process.js

# Test direct gateway connection
node test-direct-gateway.js
```

### Development Scripts

```bash
# Start with automatic restart
npm start

# Lint code
npm run lint

# Run specific worker
node worker.js --wtype gateway --env development
```

## 🔧 Development

### Adding New Workers

1. Create new worker in `workers/` directory extending `BaseWorker`
2. Add worker configuration to `config/common.json`
3. Add npm script to `package.json`
4. Implement worker-specific RPC handlers

## 📁 Project Structure

```
ai-inference-platform/
├── workers/
│   ├── base.wrk.js          # Base worker class
│   ├── auth.wrk.js          # Authentication service
│   ├── gateway.wrk.js       # API gateway
│   ├── inference.wrk.js     # AI inference service
│   └── web.wrk.js           # Web interface
├── web/
│   └── views/               # EJS templates
├── cli/
│   └── ai-inference-cli.js  # Command line interface
├── config/
│   ├── common.json          # Shared configuration
│   └── *.json.example       # Configuration templates
├── worker.js                # Main worker entry point
└── package.json
```