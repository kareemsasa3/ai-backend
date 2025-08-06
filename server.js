const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const client = require("prom-client");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use(cors());
app.use(express.json());

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

// Chat endpoint
app.post("/chat", async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, history, context } = req.body;

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

    // Prepare conversation history for Gemini
    const conversationHistory = history || [];

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
    let fullMessage = message;
    if (context) {
      fullMessage = `${context}\n\nUser message: ${message}`;
    }

    // Generate response
    const result = await chat.sendMessage(fullMessage);
    const response = await result.response;
    const text = response.text();

    const responseTime = (Date.now() - startTime) / 1000;
    aiChatResponseTime.observe(responseTime);
    aiChatRequestsTotal.inc({ status: "success" });

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
