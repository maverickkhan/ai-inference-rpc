# System Design Document

## Overview

This platform is a distributed, peer-to-peer AI inference system with microservices architecture, using Hyperswarm for P2P networking. It provides scalable AI inference, authentication, rate limiting, and a web dashboard.

---

## Architecture

### Main Components

1. **Gateway Worker**

   * API gateway
   * Authentication, rate limiting, request routing
   * Exposes external APIs

2. **Auth Worker**

   * User registration/authentication
   * API key management
   * Credential storage/validation

3. **Inference Worker**

   * AI model inference
   * Connects to model backends (OpenAI, Ollama)
   * Scalable for load balancing

4. **Web Worker**

   * Hosts web dashboard
   * User management UI
   * Dashboard/statistics

5. **Base Worker**

   * Shared logic (storage, metrics, RPC)
   * Lifecycle utilities

### Data Flow and Storage

* Hyperbee for distributed storage (via Hypercore)
* Auth data, logs, and usage metrics stored per worker
* Configuration via JSON files
* Web UI uses EJS templates

### Communication/Protocols

* P2P/RPC via Hyperswarm
* Workers run with --wtype flag
* Metrics via Prometheus (Gateway)

### Deployment/Scaling

* Independent worker scaling
* Decentralized, fault-tolerant
* Inference workers scale with demand

---

## Flows

### Registration & Authentication

1. User registers via Web Worker
2. Web Worker calls Auth Worker via RPC
3. Auth Worker stores credentials, issues API key

### Inference Request

1. User/client sends request (API key) to Gateway Worker
2. Gateway authenticates with Auth Worker
3. Gateway forwards request to Inference Worker
4. Inference Worker responds

### Dashboard

1. User opens web dashboard (Web Worker)
2. Web Worker fetches stats from Gateway
3. Web Worker shows data to user

---

## Service Interaction (ASCII Diagram)

```
[User/Client]         [Web Browser]
     |                     |
     | REST/RPC/API        | HTTP/Web
     v                     v
[Gateway Worker] <----> [Web Worker]
     |                       |
     |  RPC (Hyperswarm)     |
     v                       v
[Auth Worker]          [Inference Worker]
     |                       |
  [Hyperbee/DB Storage] [Hyperbee/DB Storage]
```

---

## Summary

* Registration, key management via Auth Worker
* Inference via Gateway/Inference Workers
* Dashboard on Web Worker
* Distributed, scalable, fault-tolerant
