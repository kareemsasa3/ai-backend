const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const client = require("prom-client");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const Redis = require("ioredis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;
const SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET || "dev-session-token-secret-change-me";
const MAX_DAILY_REQUESTS = Number(process.env.AI_DAILY_LIMIT || 50);
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379/0";
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";

// Redis client (used for per-IP/day quotas)
const redis = new Redis(REDIS_URL);
redis.on("error", (err) => {
  console.error("Redis error:", err);
});

// Initialize Prometheus metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: "ai_backend_" });

// Create custom metrics
const httpRequestDurationMicroseconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 0.5, 1, 2, 5],
});

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
});

const aiChatRequestsTotal = new client.Counter({
  name: "ai_chat_requests_total",
  help: "Total number of AI chat requests",
  labelNames: ["status"],
});

const aiChatResponseTime = new client.Histogram({
  name: "ai_chat_response_time_seconds",
  help: "AI chat response time in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Middleware
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production" ? ["https://kareemsasa.dev"] : true,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "DNT",
      "User-Agent",
      "X-Requested-With",
      "If-Modified-Since",
      "Cache-Control",
      "Content-Type",
      "Range",
      "Authorization",
    ],
  })
);
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// Basic rate limiting (second layer; nginx is first layer)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

// Metrics middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;
    const labels = {
      method: req.method,
      route: req.route ? req.route.path : req.path,
      status_code: res.statusCode,
    };

    httpRequestDurationMicroseconds.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  } catch (ex) {
    res.status(500).end(ex);
  }
});

// Utility helpers
function getClientIp(req) {
  const xfwd = req.headers["x-forwarded-for"]; // e.g. "client, proxy1, proxy2"
  if (xfwd) return xfwd.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function todayKeyForIp(ip) {
  const now = new Date();
  const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}${String(now.getUTCDate()).padStart(2, "0")}`;
  return `ai_quota:${ip}:${day}`;
}

async function incrementDailyQuota(ip) {
  const key = todayKeyForIp(ip);
  const count = await redis.incr(key);
  if (count === 1) {
    // set TTL until midnight UTC
    const now = new Date();
    const tomorrow = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    );
    const ttlSeconds = Math.max(60, Math.floor((tomorrow - now) / 1000));
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

function signSessionToken(payload) {
  return jwt.sign(payload, SESSION_TOKEN_SECRET, { expiresIn: "1d" });
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, SESSION_TOKEN_SECRET);
  } catch (e) {
    return null;
  }
}

// Turnstile verification + session token issuance
app.post("/auth/turnstile", async (req, res) => {
  try {
    const { token } = req.body || {};
    const ip = getClientIp(req);

    if (process.env.NODE_ENV !== "production" && !TURNSTILE_SECRET) {
      // Dev fallback: issue a dev token
      const devToken = signSessionToken({ ip, dev: true, iat: Date.now() });
      return res.json({ sessionToken: devToken });
    }

    if (!TURNSTILE_SECRET) {
      return res.status(503).json({ error: "Turnstile not configured" });
    }

    if (!token) {
      return res.status(400).json({ error: "Missing Turnstile token" });
    }

    const params = new URLSearchParams();
    params.append("secret", TURNSTILE_SECRET);
    params.append("response", token);
    params.append("remoteip", ip);

    const verifyResp = await axios.post(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      params,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (!verifyResp.data?.success) {
      return res.status(401).json({ error: "Turnstile verification failed" });
    }

    const sessionToken = signSessionToken({ ip });
    return res.json({ sessionToken });
  } catch (err) {
    console.error("Turnstile verification error:", err);
    return res.status(500).json({ error: "Verification error" });
  }
});

// Dev helper to issue a token without Turnstile in non-production
app.post("/auth/dev-token", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).end();
  }
  const ip = getClientIp(req);
  const sessionToken = signSessionToken({ ip, dev: true });
  return res.json({ sessionToken });
});

// Chat endpoint
app.post("/chat", async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, history, context } = req.body || {};

    // Require a session token in production when TURNSTILE is configured
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.substring("Bearer ".length)
      : null;
    if (process.env.NODE_ENV === "production" && TURNSTILE_SECRET) {
      const verified = token ? verifySessionToken(token) : null;
      if (!verified) {
        aiChatRequestsTotal.inc({ status: "error" });
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    if (!message) {
      aiChatRequestsTotal.inc({ status: "error" });
      return res.status(400).json({ error: "Message is required" });
    }

    // Check if Gemini API key is configured
    if (!process.env.GEMINI_API_KEY) {
      aiChatRequestsTotal.inc({ status: "error" });
      return res.status(500).json({
        error:
          "AI service not configured. Please set GEMINI_API_KEY environment variable.",
      });
    }

    // Daily quota enforcement (per IP)
    const ip = getClientIp(req);
    let usedToday = 0;
    try {
      usedToday = await incrementDailyQuota(ip);
    } catch (e) {
      console.warn("Quota check failed; allowing request:", e.message);
    }
    if (usedToday > MAX_DAILY_REQUESTS) {
      aiChatRequestsTotal.inc({ status: "error" });
      return res
        .status(429)
        .json({ error: "Daily message limit reached. Please try tomorrow." });
    }

    // Prepare conversation history for Gemini
    const conversationHistory = Array.isArray(history)
      ? history.slice(0, 20).map((m) => ({
          role: m && m.role === "user" ? "user" : "model",
          content:
            typeof m?.content === "string" ? m.content.slice(0, 2000) : "",
          timestamp: Number.isFinite(m?.timestamp) ? m.timestamp : Date.now(),
        }))
      : [];

    // Create the model instance
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
    });

    // Start a chat session
    const chat = model.startChat({
      history: conversationHistory.map((msg) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      })),
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    });

    // Add system context if provided
    let fullMessage = String(message).slice(0, 4000);
    if (context) {
      fullMessage = `${String(context).slice(
        0,
        2000
      )}\n\nUser message: ${fullMessage}`;
    }

    // Generate response
    const result = await chat.sendMessage(fullMessage);
    const response = await result.response;
    const text = response.text();

    const responseTime = (Date.now() - startTime) / 1000;
    aiChatResponseTime.observe(responseTime);
    aiChatRequestsTotal.inc({ status: "success" });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      response: text,
      timestamp: Date.now(),
    });
  } catch (error) {
    const responseTime = (Date.now() - startTime) / 1000;
    aiChatResponseTime.observe(responseTime);
    aiChatRequestsTotal.inc({ status: "error" });

    console.error("AI chat error:", error);

    // Provide a helpful error message
    let errorMessage =
      "Sorry, I encountered an error while processing your request.";

    if (error.message?.includes("API_KEY_INVALID")) {
      errorMessage =
        "AI service authentication failed. Please check GEMINI_API_KEY configuration.";
    } else if (error.message?.includes("QUOTA_EXCEEDED")) {
      errorMessage = "AI service quota exceeded. Please try again later.";
    } else if (error.message?.includes("RATE_LIMIT")) {
      errorMessage = "AI service rate limit exceeded. Please try again later.";
    }

    res.status(500).json({
      error: errorMessage,
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Start server
app.listen(PORT, () => {
  console.log(`AI Backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Metrics endpoint: http://localhost:${PORT}/metrics`);
  console.log(`Chat endpoint: http://localhost:${PORT}/chat`);

  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      "⚠️  No GEMINI_API_KEY configured. Please set the environment variable."
    );
  } else {
    console.log("✅ Gemini API configured successfully");
  }
});
